import type { EngineInterface } from 'claude-code'
import type { Job } from '../types'
import { refresh } from './board'
import { profiles, reviewsOnly, turnedOff, wrappingUp } from './config'
import { afterFailedRounds, belowTarget } from './coordinator'
import {
  GONE_MISSES,
  INLINE_CHARS,
  INLINE_LINES,
  LOST_REPORT_MS,
  MESSAGE_CHARS,
  NAME,
  PROMPT_TRIES,
  QUIET_BUSY_MS,
  QUIET_MS,
} from './defaults'
import { acceptFolderTrust, herdr, type HerdrAgent, lastStatus, notify } from './herdr'
import { ask, openQuestions } from './owner'
import { cmd } from './session'
import { jobs, saveJob } from './state'
import { briefRefs, withPr } from './tasks'
import { excludeFromGit } from './worktrees'

// Worker agents that run in herdr tabs. spawn opens a tab, starts the CLI there,
// hands it the task and returns at once. When the worker ends its turn, its RESULT.md
// is submitted to this session as a new prompt.
//
// herdr tells the mod when a worker settles: arm starts a `herdr agent wait` for it in
// a child process, and the sweep (every SWEEP_MS, one `herdr agent list` for all
// workers) catches what the waits miss. checkReports (every 3 s) delivers a RESULT.md as
// soon as it lands. Everything that may deliver, prompt or check a job goes through
// serial, so a wait, a sweep and the report check never act on the same job twice.

// The module's own variables start over on every reload; the jobs live in $.state, so
// session.start arms a wait for each running one (resumeWatching).
// The wait armed for each worker: the token it was armed for, whether it waits for the
// turn to end ('finish') or for the next turn to start ('resume'), and an id, so a child
// that ends late does not clear a newer one.
const armed = new Map<string, { token?: string; mode: 'finish' | 'resume'; id: number }>()
let armIds = 0
// Sweeps in a row that found no tab for each worker (see sweep).
const misses = new Map<string, number>()
// Each worker's screen as the sweep last saw it, and since when it has not changed.
const quiet = new Map<string, { token?: string; screen: string; since: number }>()
// The last step queued for each worker (see serial).
const chains = new Map<string, Promise<void>>()

// Each prompt gets a fresh token the worker puts on RESULT.md's first line, so a
// report the worker writes late for an earlier prompt is never taken as this one's.
export function reportRule(job: Job) {
  return [
    `When you are completely finished, write your final report to ${job.dir}/RESULT.md,`,
    `whose first line must be exactly: <!-- report ${job.token} -->. Then, in at most 25 lines:`,
    'what you did, the branch or PR link, test results, open questions, and anything you could not do.',
    `Put long material, such as a plan or a full review, in another file in ${job.dir} (a plan goes in PLAN.md)`,
    'and give its absolute path in the report instead of copying it in.',
    'If you need a decision only the owner can make, write each question on its own line as',
    '"DECISION: [Short title] <question> | <option> (recommended) | <option>", the title 2-4 words and the options short;',
    'if you cannot go on without the answer, stop there.',
    'That file is how your coordinator gets your answer.',
    'To wait for something outside your control (CI, a merge, a free test machine), never sleep or poll inside a command for more than 2 minutes.',
    `Instead write ${job.dir}/WAIT.json as {"for": "<what, a few words>", "check": "<shell command, run in your folder, that exits 0 once it is ready>", "every": <minutes between checks, 1-30>, "max": <minutes before giving up>}`,
    'and end your turn without RESULT.md; you get a message when the check passes or times out.',
    'If you cannot go on, write why to RESULT.md and stop.',
  ].join(' ')
}

// Sends `text` to the worker and, once herdr sees it working, arms the wait for its turn
// to end, which delivers its report.
export async function prompt($: EngineInterface, job: Job, lead: string) {
  const token = crypto.randomUUID().slice(0, 8)
  const next: Job = { ...job, token, status: 'running', endedAt: undefined }
  await $.process.run(['rm', '-f', `${job.dir}/RESULT.md`])
  await saveJob($, next)
  const lost = await send($, job.name, `${lead} ${reportRule(next)}`)
  if (lost === undefined) {
    // Only once the worker works is its turn's end the one to wait for: herdr answers a wait at
    // once for a state the worker is already in, and the last turn's 'done' may still be there.
    lastStatus.set(next.name, 'working')
    arm($, next, 'finish')
  } else {
    // A prompt that never arrived is reported after a while: a tool call can't submit one.
    void $.clock.sleep(LOST_REPORT_MS).then(() => serial(next.name, () => deliver($, next, 'blocked', QUIET_MS, lost)))
  }
}

// herdr types a prompt once the CLI looks ready, but a CLI still busy with its own
// startup (many tabs starting at once) can drop it, leaving the worker at an empty
// input box. With --wait, herdr fails with agent_prompt_stalled when no work starts
// within 5 s; then text still in the input box is submitted, else the prompt is typed
// again. Returns why it was not delivered, or undefined once work started.
async function send($: EngineInterface, name: string, text: string): Promise<string | undefined> {
  const started = ['--until', 'working', '--until', 'blocked']
  const typeIt = () => herdr($, ['agent', 'prompt', name, text, '--wait', ...started, '--timeout', '15000'], 30_000)
  for (let i = 0; i < PROMPT_TRIES; i++) {
    try {
      if (i === 0) await typeIt()
      else if ((await $.process.run(['herdr', 'agent', 'read', name, '--lines', '40'])).stdout.includes(text.slice(0, 40))) {
        await herdr($, ['agent', 'send-keys', name, 'enter'])
        await herdr($, ['agent', 'wait', name, ...started, '--timeout', '5000'], 15_000)
      } else await typeIt()
      return undefined
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'agent_prompt_stalled' && code !== 'timeout') throw err
    }
  }
  return `its prompt was not delivered: no work started after ${PROMPT_TRIES} tries`
}

// Whether RESULT.md is this prompt's report (see reportRule).
export async function reported($: EngineInterface, job: Job) {
  const path = `${job.dir}/RESULT.md`
  if (!(await $.fs.exists(path))) return false
  return !job.token || (await $.fs.read(path)).trimStart().startsWith(`<!-- report ${job.token} -->`)
}

// Runs fn once the worker's earlier steps are done, so a wait and a sweep never deliver,
// prompt or check the same job twice. An error ends that step only.
function serial(name: string, fn: () => Promise<void>): Promise<void> {
  const next = (chains.get(name) ?? Promise.resolve()).then(fn).catch(() => {})
  chains.set(name, next)
  return next
}

// Starts a herdr wait for the worker in a child process: for its turn to end ('finish':
// done, idle or blocked) or for its next turn to start ('resume': working or blocked).
// The child lives until herdr answers. A child that could not start, or whose hook was
// let go, leaves the worker to the sweep, which arms a new one.
export function arm($: EngineInterface, job: Job, mode: 'finish' | 'resume') {
  const held = armed.get(job.name)
  if (held && held.token === job.token && held.mode === mode) return
  const id = ++armIds
  armed.set(job.name, { token: job.token, mode, id })
  const until =
    mode === 'finish' ? ['--until', 'done', '--until', 'idle', '--until', 'blocked'] : ['--until', 'working', '--until', 'blocked']
  void (async () => {
    let out = ''
    try {
      for await (const piece of $.process.spawn({ argv: ['herdr', 'agent', 'wait', job.name, ...until] })) {
        if (piece.stream === 'stdout') out += piece.text
      }
    } catch {
      return
    } finally {
      if (armed.get(job.name)?.id === id) armed.delete(job.name)
    }
    // herdr prints one JSON line: its result, or an error (agent_not_found, agent_not_running…),
    // and an error decides nothing.
    let reply: { result?: { agent?: { agent_status?: string } }; error?: unknown }
    try {
      reply = JSON.parse(out)
    } catch {
      return
    }
    const status = reply.result?.agent?.agent_status
    if (!status || reply.error) return
    lastStatus.set(job.name, status)
    void serial(job.name, () => settle($, job, mode, status))
  })()
}

// What a settled wait means for its job. The report decides what happened; herdr's state
// only moves the job along: a blocked worker is reported at once, and one that ends its
// turn without a report is waited on for its next turn. The sweep judges a quiet one.
async function settle($: EngineInterface, job: Job, mode: 'finish' | 'resume', status: string) {
  const current = (await jobs($))[job.name]
  // A stale child: its job was reported, stopped or prompted again since it was armed.
  if (!current || current.status !== 'running' || current.token !== job.token) return
  if (await reported($, current)) return await deliver($, current, 'done')
  if (status === 'blocked') return await deliver($, current, 'blocked')
  // A resume wait only ends once the worker works again; its turn's end is the one to wait for next.
  if (mode === 'resume') return arm($, current, 'finish')
  const now = await $.clock.now()
  await waiting($, current, status, now)
  // A WAIT.json that woke the worker prompted it again, and that prompt armed its own wait.
  if ((await jobs($))[job.name]?.token !== job.token) return
  arm($, current, 'resume')
}

// Every 3 s (register): a running worker whose RESULT.md carries its token is delivered as
// soon as the file is there, though the worker may still be finishing its turn. The wait
// and the sweep stay for a blocked worker and for a turn that ends with no report. It makes
// no herdr call: one exists check, and a read once the file is there. Not awaited, so a
// step queued behind a slow one does not hold up the band's tick.
export async function checkReports($: EngineInterface) {
  for (const job of Object.values(await jobs($))) {
    if (job.status !== 'running' || !(await reported($, job))) continue
    void serial(job.name, async () => {
      const current = (await jobs($))[job.name]
      // A worker with messages held for it is left to its turn's end: deliver sends them then.
      if (!current || current.status !== 'running' || current.queued?.length) return
      if (await reported($, current)) await deliver($, current, 'done')
    })
  }
}

// RESULT.md is the completion signal: herdr's lifecycle state alone is not
// (a Claude worker running its own subagents reads as done while it works).
// A blocked worker is reported at once; a quiet one after QUIET_MS, or QUIET_BUSY_MS
// while it waits on background work of its own. The sweep, every SWEEP_MS, does this for
// all running workers with one `herdr agent list`. A tab herdr no longer lists counts as
// gone only after GONE_MISSES sweeps in a row, and a failed list decides nothing.
export async function sweep($: EngineInterface, closeMinutes: number) {
  const now = await $.clock.now()
  let agents: HerdrAgent[] | undefined
  try {
    agents = (await herdr<{ agents: HerdrAgent[] }>($, ['agent', 'list'])).agents
  } catch {
    agents = undefined
  }
  const byName = new Map<string, HerdrAgent>()
  for (const a of agents ?? []) if (a.name) byName.set(a.name, a)
  for (const job of Object.values(await jobs($))) {
    if (job.status !== 'running') continue
    await serial(job.name, async () => {
      const current = (await jobs($))[job.name]
      if (!current || current.status !== 'running') return
      if (await reported($, current)) return await deliver($, current, 'done')
      // A CLI error is not evidence of anything.
      if (agents === undefined) return
      const a = byName.get(job.name)
      if (!a) {
        const n = (misses.get(job.name) ?? 0) + 1
        misses.set(job.name, n)
        if (n >= GONE_MISSES) await deliver($, current, 'gone')
        return
      }
      misses.delete(job.name)
      lastStatus.set(job.name, a.agent_status)
      if (a.agent_status === 'blocked') return await deliver($, current, 'blocked')
      if (!armed.has(job.name)) arm($, current, a.agent_status === 'working' ? 'finish' : 'resume')
      if (await waiting($, current, a.agent_status, now)) {
        quiet.delete(job.name)
        return
      }
      if (a.agent_status === 'working') {
        quiet.delete(job.name)
        return
      }
      let seen: string
      try {
        const ran = await $.process.run(['herdr', 'pane', 'read', a.pane_id, '--source', 'visible'])
        if (ran.exitCode !== 0) return
        seen = ran.stdout
      } catch {
        return
      }
      const q = quiet.get(job.name)
      if (!q || q.token !== current.token || q.screen !== seen) {
        quiet.set(job.name, { token: current.token, screen: seen, since: now })
        return
      }
      if (now - q.since >= (inBackground(seen) ? QUIET_BUSY_MS : QUIET_MS)) await deliver($, current, a.agent_status, now - q.since)
    })
  }
  if (closeMinutes > 0) await closeIdle($, closeMinutes, agents)
  void refresh($)
}

// A Claude worker waiting on its own background shell, monitor or subagent keeps a
// still screen; the status lines below its prompt box say so ("· 1 shell", a
// "◯ general-purpose …" row). Only those lines count: its own messages often say
// "1 shell" or "still running", and every footer shows "← 1 agent", the session itself.
export function inBackground(screen: string) {
  const lines = screen.split('\n')
  let input = -1
  lines.forEach((l, i) => {
    if (l.trimStart().startsWith('❯')) input = i
  })
  const footer = lines.slice(input >= 0 ? input + 1 : -4).join('\n')
  return /\b\d+ (shells?|monitors?)\b|still running|^\s*◯ |← ([2-9]|\d{2,}) agents/m.test(footer)
}

// A worker that wrote WAIT.json (see reportRule) waits with no model running:
// this runs its check every few minutes and prompts it once the check passes or
// times out. Returns whether the worker is waiting (or was just woken).
export async function waiting($: EngineInterface, job: Job, status: string, now: number) {
  const path = `${job.dir}/WAIT.json`
  const current = (await jobs($))[job.name]
  if (!current) return false
  if (!(await $.fs.exists(path))) {
    if (current.wait) await saveJob($, { ...current, wait: undefined })
    return false
  }
  let wait = current.wait
  if (!wait) {
    try {
      const w = JSON.parse(await $.fs.read(path))
      if (typeof w.check !== 'string' || !w.check.trim()) throw new Error('"check" must be a shell command')
      const minutes = (v: unknown, d: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, typeof v === 'number' ? v : d))
      wait = {
        for: String(w.for ?? 'a check').slice(0, 80),
        check: w.check,
        every: minutes(w.every, 3, 1, 30),
        max: minutes(w.max, 120, 5, 720),
        since: now,
      }
    } catch (err) {
      // It may still be writing the file; read it again once it stops.
      if (status === 'working') return false
      await $.process.run(['mv', path, `${job.dir}/WAIT.bad.json`])
      await prompt($, current, `Your ${path} could not be read (${err}); it was moved to WAIT.bad.json. Write it again or carry on.`)
      return true
    }
    await saveJob($, { ...current, wait })
  }
  if (wait.lastAt !== undefined && now - wait.lastAt < wait.every * 60_000) return true
  const ran = await $.process.run(['/bin/bash', '-c', wait.check], { cwd: job.cwd, timeoutMs: 120_000 }).catch((err: unknown) => ({
    exitCode: -1,
    stdout: String(err),
  }))
  const out = String(ran.stdout ?? '')
    .trim()
    .slice(-1500)
  const passed = ran.exitCode === 0
  const timedOut = now - wait.since > wait.max * 60_000
  if (!passed && !timedOut) {
    await saveJob($, { ...current, wait: { ...wait, lastAt: now } })
    return true
  }
  // A worker still working (it wrote WAIT.json mid-turn) is woken once it stops.
  if (status === 'working') return true
  await $.process.run(['rm', '-f', path])
  const mins = Math.round((now - wait.since) / 60_000)
  await prompt(
    $,
    { ...current, wait: undefined },
    [
      `Your wait is over: ${wait.for} ${passed ? `is ready (the check passed after ${mins} min)` : `is still not ready after ${mins} min, so the wait timed out`}.`,
      out ? `The check's last output:\n${out}\n` : '',
      passed ? 'Carry on with your task.' : 'Decide whether to wait again (a new WAIT.json) or report what is blocking you.',
    ].join(' '),
  )
  return true
}

// `why` says why a worker stopped when herdr's status alone doesn't (a prompt that never arrived).
export async function deliver($: EngineInterface, job: Job, status: string, quietMs = QUIET_MS, why?: string) {
  const current = (await jobs($))[job.name]
  if (!current || current.status !== 'running') return
  // A caller holding an earlier prompt's token does nothing: that prompt has been replaced.
  if (job.token !== undefined && current.token !== job.token) return
  if (status === 'gone') lastStatus.set(job.name, 'gone')
  const error = why ?? (status === 'gone' ? 'its tab is gone' : undefined)

  const resultPath = `${job.dir}/RESULT.md`
  let body: string
  // The PR a report links, for the sidebar's task rows.
  let pr: number | undefined
  if (await reported($, current)) {
    body = (await $.fs.read(resultPath)).replace(/^\s*<!-- report \S+ -->\s*/, '')
    pr = Number(body.match(/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/)?.[1]) || undefined
    // Read the questions from the whole report: they often sit past the cut.
    // "DECISION: none. No owner decision is needed" asks nothing, so it is not pinned.
    const asked = [...body.matchAll(/^\s*(?:[-*]\s*)?\**DECISION:?\**:?\s*(.+)$/gm)]
      .map(m => (m[1] ?? '').trim())
      .filter(q => q && !/^(?:none|n\/a)\b/i.test(q))
    // RESULT.md is removed on the next prompt, so every report keeps its full
    // text in a file of its own. Claude Code draws a plugin's prompt in full and
    // no hook can shorten it, so only a short report goes inline: a longer one
    // is sent as its first line and the path the coordinator reads it from.
    const full = `${job.dir}/RESULT-${current.token ?? (await $.clock.now())}.md`
    await $.fs.write(full, body)
    const lines = body.split('\n').filter(l => l.trim())
    if (lines.length > INLINE_LINES || body.length > INLINE_CHARS) {
      const first = (lines[0] ?? '').replace(/^#+\s*/, '').slice(0, 200)
      body = `${first}\n[Full report, ${lines.length} lines: ${full}. Read it before acting on it.]`
    }
    const ids: string[] = []
    for (const line of asked) {
      const [head = line, ...parts] = line.split(/\s+\|\s+/)
      const titled = head.match(/^\[([^\]]{1,40})\]\s*(.+)$/)
      const question = titled ? titled[2]! : head
      const marked = /\s*\((?:recommended|rec\.?)\)\s*/i
      const recommended = parts.findIndex(o => marked.test(o))
      const options = parts.map(o => o.replace(marked, ' ').trim()).filter(Boolean)
      ids.push(`D${await ask($, job.name, question, options, recommended >= 0 ? recommended : undefined, titled?.[1], true)}`)
    }
    if (ids.length)
      body += `\n\n[Pinned for the owner as ${ids.join(', ')}. The owner is pinged when this turn ends. Settle any that is not theirs (not a product rule, design choice or approval) now, with decided and your answer; the band shows them what you chose.]`
  } else if (status === 'blocked' && !why) {
    body =
      'The worker is waiting at an approval or question in its herdr tab. Ask the person to answer it there, or send the answer with the message tool.'
    await notify($, `${job.name} is blocked`, 'It waits at an approval or question in its herdr tab.')
  } else {
    let tail = ''
    try {
      tail = (await $.process.run(['herdr', 'agent', 'read', job.name, '--lines', '40'])).stdout.trim()
    } catch {}
    const screen = `${job.dir}/SCREEN-${current.token ?? (await $.clock.now())}.txt`
    await $.fs.write(screen, tail.slice(-4000))
    body = `The worker stopped (${error ?? `${status}, screen unchanged for ${Math.round(quietMs / 60_000)} min`}) without writing RESULT.md. The last 40 lines of its terminal are in ${screen}.`
  }

  await saveJob($, { ...withPr(current, pr), status: 'reported', queued: [], wait: undefined, endedAt: await $.clock.now() })
  misses.delete(job.name)
  quiet.delete(job.name)
  $.ui.toast(`herdr worker ${job.name}: ${status}`)
  // Messages held while a non-Claude worker worked go out now.
  const queued = current.queued ?? []
  if (queued.length > 0 && status === 'done') {
    await prompt(
      $,
      { ...current, queued: [] },
      `Messages from your coordinator, sent while you worked, are in ${queued.join(', ')}. Read them and do what they ask.`,
    )
    body += `\n\n[The ${queued.length} message(s) queued for it were sent now; its next report follows.]`
  }
  body += await belowTarget($)
  await $.prompt.submit({
    text: `<herdr-agent name="${job.name}" profile="${job.profile}" status="${status}">\n${body.trim()}\n</herdr-agent>`,
  })
}

// session.start: each running worker gets its wait back, since a reload killed the children.
export function resumeWatching($: EngineInterface, list: Job[]) {
  for (const job of list) if (job.status === 'running') arm($, job, 'finish')
}

export type SpawnArgs = { worker: string; profile: string; cwd: string; task: string }

export async function spawnWorker($: EngineInterface, e: SpawnArgs) {
  const { worker, profile, cwd, task } = e
  if (!NAME.test(worker)) return { deny: `worker must match ${NAME}` }
  const off = await turnedOff($)
  if (off.has(profile)) return { deny: `${profile} is turned off in this folder's settings (disable); ${cmd('config')} turns it on.` }
  const all = await profiles($)
  const p = all[profile]
  if (!p) return { deny: `unknown profile ${profile}; have ${Object.keys(all).join(', ')}` }
  if (profile !== 'reviewer' && (await wrappingUp($)))
    return {
      deny: `Wrapping up: the owner stopped new work (${cmd('wrap-up')}). Let the running workers finish and send fixes to an open worker with message; only a reviewer for an open PR may start. The owner ends it with ${cmd('wrap-up')} off.`,
    }
  if ((await jobs($))[worker]?.status === 'running') return { deny: `worker ${worker} is still running; use message or stop` }
  if (!(await $.env.get('HERDR_SOCKET_PATH'))) return { deny: 'this session is not running inside herdr' }

  // One writer per worktree. A fix round goes to a fresh builder once the one that
  // wrote the PR is stopped, so its context stays small. The debugger takes over after failed rounds.
  if (!reviewsOnly(profile) && profile !== 'debugger') {
    for (const j of Object.values(await jobs($))) {
      if (j.name === worker || j.cwd !== cwd || reviewsOnly(j.profile)) continue
      try {
        await herdr($, ['agent', 'get', j.name])
      } catch {
        continue
      }
      return {
        deny: `${j.name} (${j.profile}) is still open in ${cwd}. For a fix round, stop it first, then spawn the fresh builder with the PR and the blockers. After two failed fix rounds, ${afterFailedRounds(off)} instead.`,
      }
    }
  }

  // Inside the worktree, so sandboxed CLIs may write RESULT.md there;
  // git's local exclude keeps it out of commits.
  const dir = `${cwd}/.herdr-agents/${worker}`
  await $.fs.write(`${dir}/TASK.md`, task)
  await excludeFromGit($, cwd)

  try {
    // The role comes last, so a profile's env cannot drop it. A worker's own session
    // reads it (see session.start).
    const env = [...Object.entries(p.env ?? {}), ['HERDR_AGENTS_ROLE', 'worker']].flatMap(([k, v]) => ['--env', `${k}=${v}`])
    const tab = await herdr<{ root_pane: { pane_id: string } }>($, ['tab', 'create', '--cwd', cwd, '--label', worker, '--no-focus', ...env])
    const pane = tab.root_pane.pane_id
    // A fresh tab's shell may still be starting; herdr then reports the
    // pane busy, so try again for a few seconds.
    for (let tries = 0; ; tries++) {
      try {
        await herdr($, ['agent', 'start', worker, '--kind', p.kind, '--pane', pane, '--timeout', '60000', '--', ...p.args])
        break
      } catch (err) {
        if (String(err).includes('blocked during startup') && (await acceptFolderTrust($, worker, pane, cwd))) break
        if (tries >= 10 || !String(err).includes('not an available shell')) throw err
        await $.clock.sleep(1000)
      }
    }
    const job: Job = { name: worker, profile, cwd, dir, startedAt: await $.clock.now(), status: 'running', ...briefRefs(task, worker) }
    await prompt($, job, `Your task is in ${dir}/TASK.md. Read it and do it.`)
    void refresh($)
    return {
      result: `Started ${worker} (${profile}, ${p.kind}) in herdr tab "${worker}" (pane ${pane}). Its report will arrive as a <herdr-agent> message.`,
    }
  } catch (err) {
    return { deny: String(err) }
  }
}

export async function messageWorker($: EngineInterface, e: { worker: string; text: string }) {
  const job = (await jobs($))[e.worker]
  if (!job) return { deny: `no worker ${e.worker}` }
  if (job.closed)
    return {
      deny: `${e.worker}'s tab is closed. Spawn a fresh worker in ${job.cwd} with what it needs; its reports are in ${job.dir}.`,
    }
  const text = e.text.trim()
  if (!text) return { deny: 'the message is empty' }
  // The suffix keeps two messages sent in one millisecond apart.
  const path = `${job.dir}/MESSAGE-${await $.clock.now()}-${crypto.randomUUID().slice(0, 4)}.md`
  await $.fs.write(path, text)
  if (job.status === 'running') {
    // Mid-task: Claude queues typed input for its next step, so it goes in now;
    // other CLIs get it the moment they report.
    const kind = (await profiles($))[job.profile]?.kind
    if (kind === 'claude') {
      await herdr($, [
        'agent',
        'prompt',
        job.name,
        `Your coordinator sent an extra message while you work: ${path}. Read it and fold it into your current task. Your final report still goes to RESULT.md as first instructed.`,
      ])
      return { result: `Sent to ${e.worker} while it works; Claude takes it at its next step, and its one report covers both.` }
    }
    await saveJob($, { ...job, queued: [...(job.queued ?? []), path] })
    return { result: `${e.worker} (${kind}) is mid-task, so the message is held and sent the moment it reports.` }
  }
  // A follow-up goes to a file of its own and, when short, into the prompt itself.
  // Told to read TASK.md again, a worker that read it for its first task took it
  // for that task resent, did not open it and asked its DECISION lines again.
  await prompt(
    $,
    job,
    text.length <= MESSAGE_CHARS
      ? `New message from your coordinator (also saved in ${path}). It is not your earlier task again: it answers or follows your last report.\n\n${text}\n\nDo what it says.`
      : `New message from your coordinator in ${path}, a file you have not read yet. It is not your earlier task again: it answers or follows your last report. Read it now and do what it says.`,
  )
  return { result: `Sent to ${e.worker}. Its next report will arrive as a <herdr-agent> message.` }
}

export async function stopWorker($: EngineInterface, e: { worker: string }) {
  const job = (await jobs($))[e.worker]
  if (!job) return { deny: `no worker ${e.worker}` }
  await saveJob($, { ...job, status: 'reported', endedAt: await $.clock.now() })
  try {
    const agent = await herdr<{ agent: HerdrAgent }>($, ['agent', 'get', job.name])
    await herdr($, ['tab', 'close', agent.agent.tab_id])
  } catch (err) {
    return { result: `Marked ${e.worker} stopped; closing its tab failed: ${err}` }
  }
  await saveJob($, { ...(await jobs($))[job.name]!, closed: true })
  return { result: `Stopped ${e.worker} and closed its tab.${await belowTarget($)}` }
}

// A reported worker keeps its tab, and its CLI, for follow-ups, so finished workers
// piled up in herdr. Once one has sat idle `minutes` since its report, its tab is
// closed; a later follow-up goes to a fresh worker. One with a question still open,
// or that herdr shows working or blocked, keeps its tab. `agents` is the sweep's list:
// undefined when that call failed, and then no tab is closed.
export async function closeIdle($: EngineInterface, minutes: number, agents?: HerdrAgent[]) {
  if (agents === undefined) return
  const now = await $.clock.now()
  const asking = new Set((await openQuestions($)).map(d => d.from))
  const closed: string[] = []
  for (const job of Object.values(await jobs($))) {
    if (job.status !== 'reported' || job.closed || asking.has(job.name)) continue
    if (job.endedAt === undefined || now - job.endedAt < minutes * 60_000) continue
    // A tab herdr no longer lists is marked closed without a close call.
    const agent = agents.find(a => a.name === job.name)
    if (agent) {
      if (agent.agent_status === 'working' || agent.agent_status === 'blocked') continue
      try {
        await herdr($, ['tab', 'close', agent.tab_id])
      } catch {
        continue
      }
      closed.push(job.name)
    }
    // A message may have woken it meanwhile.
    const current = (await jobs($))[job.name]
    if (current?.status === 'reported') await saveJob($, { ...current, closed: true })
  }
  if (closed.length) $.ui.toast(`Closed ${closed.length} idle worker tab${closed.length === 1 ? '' : 's'}: ${closed.join(', ')}`)
}
