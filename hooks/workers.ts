import type { EngineInterface } from 'claude-code'
import type { Job } from '../types'
import { refresh } from './board'
import { profiles, reviewsOnly, turnedOff, wrappingUp } from './config'
import { afterFailedRounds, belowTarget } from './coordinator'
import { INLINE_CHARS, INLINE_LINES, MESSAGE_CHARS, NAME, QUIET_BUSY_MS, QUIET_MS } from './defaults'
import { acceptFolderTrust, herdr, type HerdrAgent, notify } from './herdr'
import { ask, openQuestions } from './owner'
import { cmd } from './session'
import { jobs, saveJob } from './state'
import { excludeFromGit } from './worktrees'

// Worker agents that run in herdr tabs. spawn opens a tab, starts the CLI there,
// hands it the task and returns at once. When herdr sees the worker settle, its
// RESULT.md is submitted to this session as a new prompt.

// The module's own variables start over on every reload; the jobs live in
// $.state, so session.start re-attaches a watcher to each running one.
const watching = new Set<string>()

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

// Sends `text` to the worker and, in the background, waits for it to settle
// and delivers its report.
export async function prompt($: EngineInterface, job: Job, lead: string) {
  const token = crypto.randomUUID().slice(0, 8)
  const next: Job = { ...job, token, status: 'running', endedAt: undefined }
  await $.process.run(['rm', '-f', `${job.dir}/RESULT.md`])
  await saveJob($, next)
  await herdr($, ['agent', 'prompt', job.name, `${lead} ${reportRule(next)}`])
  watch($, next)
}

// Whether RESULT.md is this prompt's report (see reportRule).
export async function reported($: EngineInterface, job: Job) {
  const path = `${job.dir}/RESULT.md`
  if (!(await $.fs.exists(path))) return false
  return !job.token || (await $.fs.read(path)).trimStart().startsWith(`<!-- report ${job.token} -->`)
}

// RESULT.md is the completion signal: herdr's lifecycle state alone is not
// (a Claude worker running its own subagents reads as done while it works).
// A blocked worker is reported at once; a quiet one after QUIET_MS, or QUIET_BUSY_MS
// while it waits on background work of its own.
export function watch($: EngineInterface, job: Job) {
  if (watching.has(job.name)) return
  watching.add(job.name)
  void (async () => {
    let screen = ''
    let quietSince: number | undefined
    try {
      for (;;) {
        await $.clock.sleep(10_000)
        const current = (await jobs($))[job.name]
        if (!current || current.status !== 'running') return
        if (await reported($, job)) return await deliver($, job, 'done')

        let status = 'gone'
        let pane = ''
        try {
          const agent = (await herdr<{ agent: HerdrAgent }>($, ['agent', 'get', job.name])).agent
          status = agent.agent_status
          pane = agent.pane_id
        } catch {}
        if (status === 'gone' || status === 'blocked') return await deliver($, job, status)

        const now = await $.clock.now()
        if (await waiting($, job, status, now)) {
          if (!(await jobs($))[job.name]?.wait) return // woken: the prompt it got is watched anew
          quietSince = undefined
          continue
        }
        const seen = pane ? (await $.process.run(['herdr', 'pane', 'read', pane, '--source', 'visible'])).stdout : ''
        if (status === 'working' || seen !== screen) quietSince = undefined
        else if (quietSince === undefined) quietSince = now
        else if (now - quietSince > (inBackground(seen) ? QUIET_BUSY_MS : QUIET_MS)) return await deliver($, job, status, now - quietSince)
        screen = seen
      }
    } finally {
      watching.delete(job.name)
      // deliver may have sent queued messages, starting a new prompt this loop couldn't watch.
      const current = (await jobs($))[job.name]
      if (current?.status === 'running' && current.token !== job.token) watch($, current)
    }
  })()
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

export async function deliver($: EngineInterface, job: Job, status: string, quietMs = QUIET_MS) {
  const current = (await jobs($))[job.name]
  if (!current || current.status !== 'running') return
  const error = status === 'gone' ? 'its tab is gone' : undefined

  const resultPath = `${job.dir}/RESULT.md`
  let body: string
  if (await reported($, current)) {
    body = (await $.fs.read(resultPath)).replace(/^\s*<!-- report \S+ -->\s*/, '')
    // Read the questions from the whole report: they often sit past the cut.
    const asked = [...body.matchAll(/^\s*(?:[-*]\s*)?\**DECISION:?\**:?\s*(.+)$/gm)].map(m => (m[1] ?? '').trim()).filter(Boolean)
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
  } else if (status === 'blocked') {
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

  await saveJob($, { ...current, status: 'reported', queued: [], wait: undefined, endedAt: await $.clock.now() })
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

export function resumeWatching($: EngineInterface, list: Job[]) {
  for (const job of list) if (job.status === 'running') watch($, job)
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
    const env = Object.entries(p.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`])
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
    const job: Job = { name: worker, profile, cwd, dir, startedAt: await $.clock.now(), status: 'running' }
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
  if (watching.has(job.name)) {
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
// or that herdr shows working or blocked, keeps its tab.
export async function closeIdle($: EngineInterface, minutes: number) {
  const now = await $.clock.now()
  const asking = new Set((await openQuestions($)).map(d => d.from))
  const closed: string[] = []
  for (const job of Object.values(await jobs($))) {
    if (job.status !== 'reported' || job.closed || asking.has(job.name)) continue
    if (job.endedAt === undefined || now - job.endedAt < minutes * 60_000) continue
    let agent: HerdrAgent | undefined
    try {
      agent = (await herdr<{ agent: HerdrAgent }>($, ['agent', 'get', job.name])).agent
    } catch {}
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
