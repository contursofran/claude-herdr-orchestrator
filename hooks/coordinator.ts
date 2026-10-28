import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Reset } from '../types'
import { refresh } from './board'
import { config, resetSettings, smallTasks, target, turnedOff, userConfigPath } from './config'
import { AUTO_END, AUTO_START, SAVE_WAIT_MS, WRAP_UP } from './defaults'
import { pinned } from './owner'
import { cmd, session } from './session'
import { active, jobs } from './state'

// The coordinator's side: the playbook it follows, the worker target and wrap-up,
// and keeping its context small.

// The context reset under way (see maybeReset), and whether /hrd-orchestrate ran here.
const resetAtom = atom({ plugin: 'herdr-agents', key: 'reset' } as const, null as Reset | null)
const orchestrating = atom({ plugin: 'herdr-agents', key: 'orchestrating' } as const, false)

// What the coordinator does after two failed fix rounds.
export function afterFailedRounds(off: Set<string>) {
  return off.has('debugger') ? 'ask the owner with ask_owner' : 'spawn `debugger`'
}

export async function setWrapUp($: EngineInterface, on: boolean) {
  const folders = { ...((await $.store.get(WRAP_UP)) ?? {}) } as Record<string, boolean>
  if (on) folders[session.cwd] = true
  else delete folders[session.cwd]
  await $.store.set(WRAP_UP, folders)
  const path = await userConfigPath($)
  // Parsed here, not through config(): a broken file throws instead of being overwritten.
  const c = !on && (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : {}
  if (c.wrapUp !== undefined) {
    delete c.wrapUp
    await $.fs.write(path, `${JSON.stringify(c, null, 2)}\n`)
  }
  void refresh($)
}

// What the orchestrate command hands the session, and again after each compaction.
// `playbook` in herdr-agents.json (a line or a list of lines) adds the person's own.
export async function playbook($: EngineInterface, statePath: string) {
  const want = await target($)
  const off = await turnedOff($)
  const extra = (await config($)).playbook ?? []
  const small = await smallTasks($)
  const steps = [
    off.has('planner')
      ? 'spawn `builder` with the issue; it plans before it builds'
      : "spawn `builder` with the issue; it plans before it builds. Spawn `planner` first only when the work needs several PRs or the issue leaves the approach open (its plan lands in PLAN.md), then `builder` with the plan's path",
    off.has('reviewer')
      ? "then review the builder's PR yourself (diff and checks) before it merges"
      : "then `reviewer` on the builder's PR",
  ]
  return [
    'You coordinate worker agents for the repo(s) in this folder: you plan, start and check them and land their PRs; you write little code yourself.',
    '- Rules: read AGENTS.md or CLAUDE.md first. They name the base branch, the checks, the PR format, who merges and what needs the owner; workers read them too.',
    `- State: keep ${statePath} current. The mod rewrites its block between ${AUTO_START} and ${AUTO_END} (running and waiting workers, recent reports) on every change; never edit that block. You own Ready (planned items that can start now, at least 3), Decisions and Next: update them when they change, not after every report. A fresh context carries on from the file alone.`,
    "- Reports: a <herdr-agent> report starts with the worker's summary. Read its full report file only when the summary is not enough; give a fix builder that path instead of copying the report.",
    '- Worktrees: each worker gets its own git worktree off the base branch, next to the repo (`git worktree add -b <branch> ../<repo>-<slug> origin/<base>`); never two writers in one.',
    `- Each issue: ${steps.join(', ')}. Send blockers to a fresh builder: stop the one that wrote the PR, then spawn \`builder\` in the same worktree with the PR and the blockers; after two failed fix rounds, ${afterFailedRounds(off)}.${small ? ` Small, well-defined tasks may go to \`${small}\`.` : ''}`,
    `- Throughput: keep ${want} workers busy; each report says how many work. Split big work into small PRs and run independent slices at once.`,
    '- Waiting: never poll or sleep; reports, WAIT.json checks and decisions arrive by themselves.',
    '- The owner: ask only what is theirs (product, design or rule choices, approvals) with ask_owner, a few at a time; settle the rest yourself with decided. Merge only as the repo rules allow.',
    '- Things the owner must do (test a build, merge a PR that waits for them) or should know: pin each with pin_for_owner, never only in a message, and unpin it with unpin_for_owner once it is done.',
    `- When the owner runs ${cmd('wrap-up')}: start nothing new, let the running workers finish, then update the state file and stop.`,
    ...(Array.isArray(extra) ? extra : [extra]).map((line: string) => `- ${line}`),
  ].join('\n')
}

// Turns wrap-up on or off and, in a session that has started workers, tells its model.
export async function toggleWrapUp($: EngineInterface, on: boolean) {
  await setWrapUp($, on)
  const live = Object.values(await jobs($)).filter(active)
  if (Object.keys(await jobs($)).length > 0) {
    void $.prompt.submit({
      text: on
        ? `<herdr-context>The owner is wrapping up: start no new workers (a reviewer for an open PR is allowed). Let the ${live.length} running finish, send them fixes with message and merge what is ready. When the last one has reported, update the state file and stop.</herdr-context>`
        : `<herdr-context>The owner ended the wrap-up: keep ${await target($)} workers busy again from the Ready list.</herdr-context>`,
    })
  }
  const names = live.map(j => j.name).join(', ')
  return on
    ? `Wrapping up: no new herdr workers start. ${live.length ? `${live.length} still running finish: ${names}.` : 'None are running.'} ${cmd('wrap-up')} off ends it.`
    : 'Wrap-up off: workers start again.'
}

// The live workers, for the compaction summary to keep.
export async function roster($: EngineInterface) {
  return Object.values(await jobs($))
    .filter(active)
    .map(j => `- ${j.name} (${j.profile}) in ${j.cwd}, job folder ${j.dir}`)
    .join('\n')
}

let resetting = false

// Whether a context reset is under way: the model was asked to save its state, or compaction runs.
export async function resetPending($: EngineInterface) {
  return resetting || (await read($, resetAtom)) !== null
}

// Keeps a coordinator's context small. Past the limit it asks the model to
// save its state to the state file; once that file is newer than the ask (or
// SAVE_WAIT_MS passed), it compacts with a short summary pointing at the file.
// Only a session that has started workers is reset.
export async function maybeReset($: EngineInterface, tokens: number) {
  if (resetting || Object.keys(await jobs($)).length === 0) return
  const { limit, statePath, coordinator, shared } = await resetSettings($)
  const reset = await read($, resetAtom)
  if (tokens < limit) {
    if (reset) await update($, resetAtom, () => null)
    return
  }
  const now = await $.clock.now()
  if (!reset) {
    await update($, resetAtom, (): Reset => ({ stage: 'saving', at: now }))
    await $.prompt.submit({
      text: [
        `<herdr-context tokens="${Math.round(tokens / 1000)}k" limit="${Math.round(limit / 1000)}k">`,
        ...(coordinator
          ? [`This session's context is past the limit. Update ${statePath} now so a fresh context can carry on from it alone:`]
          : [
              `This session's context is past the limit. It is not the coordinator: leave ${shared} alone (another session owns it)`,
              `and write this session's own handoff to ${statePath} so a fresh context can carry on from it alone:`,
            ]),
        "what each running worker is doing (the mod's block already lists them), open PRs and their state,",
        "what waits on review, CI or merge, the owner's decisions and standing instructions from this session,",
        'open questions for the owner, ids already claimed (migration numbers and the like), and the next steps.',
        'Replace stale content and keep it under about 150 lines. Then answer in one line.',
        'The mod compacts the conversation right after.',
        '</herdr-context>',
      ].join('\n'),
    })
    return
  }
  let saved = false
  try {
    saved = (await $.fs.exists(statePath)) && (await $.fs.stat(statePath)).mtimeMs > reset.at
  } catch {}
  if (!saved && now - reset.at < SAVE_WAIT_MS) return

  resetting = true
  try {
    const live = await roster($)
    const items = await pinned($)
    const result = await $.session.compact({
      instructions: [
        `Keep this summary short, under 1,500 words. This session's full state is in ${statePath}:`,
        'say to read it first and trust it over this summary.',
        "Keep only what that file may lack: the owner's latest messages and anything that happened after it was saved.",
        live ? `Workers still running in herdr tabs:\n${live}` : 'No herdr workers are running.',
        ...(items ? [`Still pinned for the owner (unpin_for_owner once done):\n${items}`] : []),
      ].join('\n'),
    })
    if ('skip' in result && result.skip) return
    await update($, resetAtom, () => null)
    $.ui.toast('herdr-agents: context compacted')
    const coordinating = await read($, orchestrating)
    await $.prompt.submit({
      text: `<herdr-context>The conversation was compacted to keep the context small. Read ${statePath} before acting on the next report.${coordinating ? `\n${await playbook($, statePath)}` : ''}</herdr-context>`,
    })
  } catch {
    // A turn is running; try again after the next one.
  } finally {
    resetting = false
  }
}

export async function orchestrate($: EngineInterface, args: string) {
  const goal = args.trim()
  const { statePath } = await resetSettings($)
  await update($, orchestrating, () => true)
  void $.prompt.submit({
    text: [
      '<herdr-context>You are now the coordinator of this folder.',
      await playbook($, statePath),
      goal
        ? `Goal: ${goal}`
        : 'Goal: none given. Read the state file and the open issues, then propose the first ones to the owner with ask_owner.',
      '</herdr-context>',
    ].join('\n'),
  })
  return { text: `Coordinating${goal ? `: ${goal}` : ''}. State file: ${statePath}. ${cmd('wrap-up')} stops new work.` }
}
