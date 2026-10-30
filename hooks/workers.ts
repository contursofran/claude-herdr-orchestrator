import type { EngineInterface } from 'claude-code'
import type { Job, Profile } from '../types'
import { archive } from './archive'
import { refresh } from './board'
import { profiles, reviewsOnly, turnedOff, wrappingUp } from './config'
import { afterFailedRounds } from './coordinator'
import {
  ADDRESS_LIKE,
  GONE_MISSES,
  INLINE_CHARS,
  INLINE_LINES,
  LOST_REPORT_MS,
  MESSAGE_CHARS,
  NAME,
  PROMPT_CHECK_MS,
  PROMPT_TRIES,
  PROMPT_WAIT_MS,
  QUIET_BUSY_MS,
  QUIET_MS,
  SEND_DEADLINE_MS,
} from './defaults'
import {
  closeTerminal,
  type HcListed,
  type HcSend,
  type HcTerminal,
  hc,
  kindOf,
  lastStatus,
  listWorkers,
  notify,
  readScreen,
  waitReady,
  watch,
  workerArgv,
} from './hc'
import { ask, openQuestions } from './owner'
import { post } from './outbox'
import { type Header, parseHeader, summaryOf } from './report'
import { cmd, session } from './session'
import { active, jobs, latestJob, patchJob, saveJob, updateJob } from './state'
import { briefRefs, withPr } from './tasks'
import { belowTarget } from './target'
import { checkWorktree, createWorktree, defaultBase, excludeFromGit, repoTop, validBranch, worktreePath } from './worktrees'

// Worker agents that run as hc terminals, shown in a Herdr tab. spawn starts the CLI in one,
// hands it the task and returns at once. When the worker ends its turn, its RESULT.md
// is submitted to this session as a new prompt.
//
// hc tells the mod when a worker settles: arm starts an `hc events` watch for it in
// a child process, and the sweep (every SWEEP_MS, one `hc ls` for all
// workers) catches what the waits miss. checkReports (every TICK_MS) delivers a RESULT.md once
// it has stopped changing. Everything that may deliver, prompt or check a job goes through
// serial, so a wait, a sweep and the report check never act on the same job twice.

// The RESULT.md text checkReports saw last for each job: delivered when the next tick sees the same.
const seenReport = new Map<string, { token?: string; text: string }>()

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
// The full rule goes in a spawn's first prompt, and in REPORTING.md, which the later
// prompts name (see prompt).
export function reportRule(job: Job, token = job.token) {
  return [
    `When you are completely finished, write your final report to ${job.dir}/RESULT.md in one write, as your last step. Its first line must be exactly: <!-- report ${token} -->`,
    'Right below that line, put this header, fences included, with your own values:',
    '```report',
    'status: done',
    'pr: 123',
    'summary: what changed; the checks you ran and their result; what is next (at most 3 short lines)',
    'ask: one line, only if your coordinator must answer something; otherwise leave this line out',
    '```',
    'status is done, blocked (you need an answer or something outside your control) or failed. Leave out pr if you opened or updated no PR; list several as 12, 13. Your coordinator usually reads only this header, so make the summary enough to act on.',
    `Below the header, in at most 25 lines: what you did, the branch or PR link, test results, open questions, and anything you could not do. Put long material, such as a plan or a full review, in another file in ${job.dir} (a plan goes in PLAN.md) and give its absolute path instead of copying it in.`,
    'If you need a decision only the owner can make, write each question on its own line as "DECISION: [Short title] <question> | <option> (recommended) | <option>", the title 2-4 words and the options short; if you cannot go on without the answer, stop there.',
    'To wait for something outside your control (CI, a merge, a free test machine), never sleep or poll inside a command for more than 2 minutes.',
    `Instead write ${job.dir}/WAIT.json as {"for": "<what, a few words>", "check": "<shell command, run in your folder, that exits 0 once it is ready>", "every": <minutes between checks, 1-30>, "max": <minutes before giving up>}`,
    'and end your turn without RESULT.md; you get a message when the check passes or times out.',
    `If you cannot go on, write why to RESULT.md (status: blocked or failed) and stop. These rules are kept in ${job.dir}/REPORTING.md; later messages only remind you of them.`,
  ].join('\n')
}

// The one-line reminder that later prompts carry instead of the full rule (see prompt).
export function reportReminder(job: Job) {
  return `When you are finished, report as before: write ${job.dir}/RESULT.md in one write, as your last step, with the first line exactly <!-- report ${job.token} -->, then the \`\`\`report header (status, pr, summary, ask) and your report. DECISION lines and WAIT.json work as in ${job.dir}/REPORTING.md.`
}

// Sends `text` to the worker and, once hc sees it working, arms the watch for its turn
// to end, which delivers its report. `force` types it over a question the worker waits at.
export async function prompt($: EngineInterface, job: Job, lead: string, spawned = false, force = false) {
  const token = crypto.randomUUID().slice(0, 8)
  seenReport.delete(job.name)
  // The last turn's report is not this turn's: it goes with the status it set.
  const next: Job = {
    ...job,
    token,
    status: 'running',
    endedAt: undefined,
    tail: undefined,
    reportStatus: undefined,
    reportFile: undefined,
  }
  await saveJob($, next)
  await $.process.run(['rm', '-f', `${job.dir}/RESULT.md`])
  // A spawn's first prompt gets the full rule, as does the first prompt to a folder without REPORTING.md.
  // A job folder outlives its job, so a spawn cannot rely on that file. REPORTING.md keeps the full rule
  // for the prompts after it, which get the reminder.
  const rules = `${job.dir}/REPORTING.md`
  const full = spawned || !(await $.fs.exists(rules))
  if (full) await $.fs.write(rules, `TOKEN below is the token in the latest prompt you got.\n\n${reportRule(next, 'TOKEN')}`)
  const lost = await send($, job.name, `${lead} ${full ? reportRule(next) : reportReminder(next)}`, force)
  if (lost === undefined) {
    // Only once the worker works is its turn's end the one to wait for: the watch answers at
    // once for a state the worker is already in, and the last turn's 'done' may still be there.
    lastStatus.set(next.name, 'working')
    arm($, next, 'finish')
  } else {
    // A prompt that never arrived is reported after a while: a tool call can't submit one.
    void $.clock
      .sleep(LOST_REPORT_MS)
      .then(() => serial(next.name, () => deliver($, next, 'blocked', QUIET_MS, lost)))
      .catch(() => {})
  }
}

// hc types a prompt and reports whether work started within 5 s, which does not tell a lost prompt from a
// slow one. A CLI still busy with its own startup (many terminals starting at once) can drop a prompt, leaving
// the worker at an empty input box. It can also have taken it and still report idle: Claude does not start a
// turn until its session.start hooks are done, and a second copy typed meanwhile runs when the first ends. So
// each try gets PROMPT_WAIT_MS to start work. Then a prompt the screen shows (in the input box, or as a CLI's
// paste placeholder) is submitted, and only one the screen does not show is typed again. Returns why it was
// not delivered, or undefined once work started. A statusless CLI (started: null) counts as delivered; the
// quiet-screen rule catches it if it never works. The whole call has a deadline, SEND_DEADLINE_MS: the waits add
// up to 3 x 90 s, the sends and reads to some 20 s more, and slow `hc get` calls would stretch that without it.
async function send($: EngineInterface, name: string, text: string, force = false): Promise<string | undefined> {
  const deadline = (await $.clock.now()) + SEND_DEADLINE_MS
  const late = async () => (await $.clock.now()) >= deadline
  const typeIt = () => hc<HcSend>($, ['send', name, text, ...(force ? ['--force'] : [])], 30_000)
  let turn = 0
  // A short turn can start and end between two looks: only the turn count shows it then.
  const started = async () => {
    const t = await hc<HcTerminal>($, ['get', name])
    return t.status?.state === 'working' || t.status?.state === 'blocked' || (t.turn ?? 0) > turn
  }
  const startsInTime = async () => {
    for (let waited = 0; waited < PROMPT_WAIT_MS; waited += PROMPT_CHECK_MS) {
      if (await started()) return true
      if (await late()) return false
      await $.clock.sleep(PROMPT_CHECK_MS)
    }
    return await started()
  }
  // The visible screen only: `hc read --lines` scrolls a full-screen CLI, and took 25 s on one that had not started its turn.
  const onScreen = async () => {
    const screen = await readScreen($, name)
    // The placeholder counts only in the input box at the bottom: the transcript above may show an earlier prompt's.
    return screen.includes(text.slice(0, 40)) || /\[Pasted /i.test(screen.split('\n').slice(-8).join('\n'))
  }
  for (let i = 0; i < PROMPT_TRIES; i++) {
    if (i > 0 && (await late())) return `its prompt was not delivered: no work started within ${SEND_DEADLINE_MS / 60_000} minutes`
    try {
      if (i > 0 && (await onScreen())) {
        await hc($, ['keys', name, 'enter'])
      } else {
        const sent = await typeIt()
        if (sent.started !== false) return undefined
        turn = sent.turn
      }
      if (await startsInTime()) return undefined
    } catch (err) {
      const kind = kindOf(err)
      if (kind === 'blocked') return 'it waits at an approval or question, so the text was not typed'
      if (kind === 'finished' || kind === 'not_found') return 'its terminal is gone'
      throw err
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

// The text of a report as deliver archives it: RESULT.md without its token line.
const reportBody = (text: string) => text.replace(/^\s*<!-- report \S+ -->\s*/, '')

// Whether RESULT.md is a report not yet delivered: this prompt's token, and a body that
// differs from the RESULT-<token>.md deliver wrote, so a delivered report is never sent twice.
export async function fresh($: EngineInterface, job: Job) {
  if (!job.token || !(await reported($, job))) return false
  const archived = `${job.dir}/RESULT-${job.token}.md`
  if (!(await $.fs.exists(archived))) return true
  return reportBody(await $.fs.read(`${job.dir}/RESULT.md`)) !== (await $.fs.read(archived))
}

// Messages held for a non-Claude worker, sent when its turn ends (deliver, endTail).
const heldPrompt = (queued: string[]) =>
  `Messages from your coordinator, sent while you worked, are in ${queued.join(', ')}. Read them and do what they ask.`

// Runs fn once the worker's earlier steps are done, so a wait and a sweep never deliver,
// prompt or check the same job twice. An error ends that step only.
function serial(name: string, fn: () => Promise<void>): Promise<void> {
  const next = (chains.get(name) ?? Promise.resolve()).then(fn).catch(() => {})
  chains.set(name, next)
  return next
}

// Starts a watch for the worker in a child process (`hc events`, see watch): for its turn to end
// ('finish': done, idle, blocked or error) or for its next turn to start ('resume': working,
// blocked or error). The child lives until the status comes. A child that could not start, whose
// terminal finished, or whose hook was let go, leaves the worker to the sweep, which arms a new one.
export function arm($: EngineInterface, job: Job, mode: 'finish' | 'resume') {
  const held = armed.get(job.name)
  if (held && held.token === job.token && held.mode === mode) return
  const id = ++armIds
  armed.set(job.name, { token: job.token, mode, id })
  const until = mode === 'finish' ? ['done', 'idle', 'blocked', 'error'] : ['working', 'blocked', 'error']
  void (async () => {
    let status: string | undefined
    try {
      status = await watch($, job.name, until, () => armed.get(job.name)?.id !== id)
    } finally {
      if (armed.get(job.name)?.id === id) armed.delete(job.name)
    }
    if (!status) return
    lastStatus.set(job.name, status)
    void serial(job.name, () => settle($, job, mode, status))
  })()
}

// What a settled wait means for its job. The report decides what happened; hc's status
// only moves the job along: a blocked worker and a CLI error are reported at once, and one that ends its
// turn without a report is waited on for its next turn. The sweep judges a quiet one.
async function settle($: EngineInterface, job: Job, mode: 'finish' | 'resume', status: string) {
  const current = (await jobs($))[job.name]
  if (current?.status === 'reported' && current.tail && current.token === job.token) return await settleTail($, current, status)
  // A stale child: its job was reported, stopped or prompted again since it was armed.
  if (!current || current.status !== 'running' || current.token !== job.token) return
  if (await reported($, current)) return await deliver($, current, 'done')
  if (status === 'blocked') return await deliver($, current, 'blocked')
  if (status === 'error') return await deliver($, current, 'error', QUIET_MS, 'its CLI reported an error')
  // A resume wait only ends once the worker works again; its turn's end is the one to wait for next.
  if (mode === 'resume') return arm($, current, 'finish')
  const now = await $.clock.now()
  await waiting($, current, status, now)
  // A WAIT.json that woke the worker prompted it again, and that prompt armed its own wait.
  if ((await jobs($))[job.name]?.token !== job.token) return
  arm($, current, 'resume')
}

// A reported job whose turn was not over (see Job.tail), when hc's watch for it settles.
async function settleTail($: EngineInterface, job: Job, status: string) {
  if (await fresh($, job)) return await deliver($, job, 'done')
  if (status === 'blocked' || status === 'error') {
    if (status === 'blocked' && job.tail === 'early') await blockedAfterReport($, job)
    return
  }
  // It works again (the owner answered): it is no longer blocked, and its turn's end is the one to wait for next.
  if (status === 'working') return arm($, await answered($, job), 'finish')
  await endTail($, job)
}

// A blocked report (tail 'blocked') whose worker works again was answered in its tab: it is no longer
// blocked (its turn is still on, so the watch stays as an early report's). A job with tail 'early' is left
// as it is: its worker working means the turn it reported in is still on, not that anyone answered it.
// Returns the job as it is now.
async function answered($: EngineInterface, job: Job) {
  const { after } = await updateJob($, job.name, j =>
    j.token === job.token && j.status === 'reported' && j.tail === 'blocked' ? { ...j, tail: 'early', headerStatus: undefined } : undefined,
  )
  return after ?? job
}

// A worker that reported early, then waits at an approval or question: the coordinator is told once.
async function blockedAfterReport($: EngineInterface, job: Job) {
  const { after } = await updateJob($, job.name, j =>
    j.token === job.token && j.status === 'reported' && j.tail === 'early' ? { ...j, tail: 'blocked' } : undefined,
  )
  if (!after) return
  notify($, `${job.name} is blocked`, 'It waits at an approval or question in its herdr tab.')
  arm($, after, 'resume')
  await post(
    $,
    `<herdr-agent name="${job.name}" profile="${job.profile}" status="blocked">\nAfter its report, the worker waits at an approval or question in its herdr tab. Ask the person to answer it there; the message tool can answer a question, but not a permission request. Its report above still stands; a new RESULT.md from this turn is delivered as a further report.\n</herdr-agent>`,
    true,
  )
}

// The turn of a reported job ended with no new report: it is no longer watched, and the
// messages held for it go out as a prompt (which submits no report of its own).
async function endTail($: EngineInterface, job: Job) {
  const { before, after } = await updateJob($, job.name, j =>
    j.token === job.token && j.status === 'reported' && j.tail ? { ...j, tail: undefined, queued: [] } : undefined,
  )
  const queued = before?.queued ?? []
  if (after && queued.length > 0 && !after.closed) await prompt($, { ...after, queued: [] }, heldPrompt(queued))
}

// Every TICK_MS (register): a running worker whose RESULT.md carries its token is delivered
// while it may still be finishing its turn, once the file has been the same for a whole tick
// (seenReport), so a report written in parts is not sent half done. The wait and the sweep
// stay for a blocked worker and for a turn that ends with no report; a report found there is
// delivered at once, as the worker has stopped writing. It makes no hc call: one exists
// check, and a read once the file is there. Not awaited, so a step queued behind a slow one
// does not hold up the band's tick.
export async function checkReports($: EngineInterface) {
  for (const job of Object.values(await jobs($))) {
    const running = job.status === 'running'
    // A job blocked after its report is watched for a new one too.
    if (running ? job.queued?.length || !(await reported($, job)) : job.tail !== 'blocked' || !(await fresh($, job))) continue
    void serial(job.name, async () => {
      const current = (await jobs($))[job.name]
      if (!current) return
      let text: string
      if (current.status === 'running') {
        // A worker with messages held for it is left to its turn's end: deliver sends them then.
        if (current.queued?.length || !(await reported($, current))) return
        text = await $.fs.read(`${current.dir}/RESULT.md`)
      } else if (current.tail === 'blocked' && (await fresh($, current))) {
        text = await $.fs.read(`${current.dir}/RESULT.md`)
      } else return
      const seen = seenReport.get(current.name)
      if (seen && seen.token === current.token && seen.text === text)
        return await deliver($, current, 'done', QUIET_MS, undefined, { early: true })
      seenReport.set(current.name, { token: current.token, text })
    })
  }
}

// RESULT.md is the completion signal: hc's status alone is not
// (a Claude worker running its own subagents reads as done while it works).
// A blocked worker is reported at once; a quiet one after QUIET_MS, or QUIET_BUSY_MS
// while it waits on background work of its own. The sweep, every SWEEP_MS, does this for
// all running workers with one `hc ls`. A worker hc no longer lists live counts as gone only
// after GONE_MISSES sweeps in a row, and a failed list decides nothing. A worker whose CLI
// reports no status reads as 'unknown', and the quiet-screen rule judges it.
export async function sweep($: EngineInterface, closeMinutes: number) {
  const now = await $.clock.now()
  let agents: HcListed[] | undefined
  try {
    agents = await listWorkers($)
  } catch {
    agents = undefined
  }
  const byName = new Map<string, HcListed>()
  for (const a of agents ?? []) if (a.name) byName.set(a.name, a)
  for (const job of Object.values(await jobs($))) {
    if (job.status !== 'running' && !job.tail) continue
    await serial(job.name, async () => {
      const current = (await jobs($))[job.name]
      if (!current) return
      const a = byName.get(job.name)
      // With no agent list the turn's end was not seen: a report found then stays a tail until a list call succeeds.
      const early = agents === undefined || a?.status === 'working'
      if (current.status === 'reported') return current.tail ? await sweepTail($, current, agents, a, early) : undefined
      if (await reported($, current)) return await deliver($, current, 'done', QUIET_MS, undefined, { early })
      // A CLI error is not evidence of anything.
      if (agents === undefined) return
      if (!a) {
        const n = (misses.get(job.name) ?? 0) + 1
        misses.set(job.name, n)
        if (n >= GONE_MISSES) await deliver($, current, 'gone')
        return
      }
      misses.delete(job.name)
      const status = a.status ?? 'unknown'
      lastStatus.set(job.name, status)
      if (status === 'blocked') return await deliver($, current, 'blocked')
      if (status === 'error') return await deliver($, current, 'error', QUIET_MS, 'its CLI reported an error')
      if (!armed.has(job.name)) arm($, current, status === 'working' ? 'finish' : 'resume')
      if (await waiting($, current, status, now)) {
        quiet.delete(job.name)
        return
      }
      if (status === 'working') {
        quiet.delete(job.name)
        return
      }
      let seen: string
      try {
        seen = await readScreen($, job.name)
      } catch {
        return
      }
      const q = quiet.get(job.name)
      if (!q || q.token !== current.token || q.screen !== seen) {
        quiet.set(job.name, { token: current.token, screen: seen, since: now })
        return
      }
      if (now - q.since >= (inBackground(seen) ? QUIET_BUSY_MS : QUIET_MS)) await deliver($, current, status, now - q.since)
    })
  }
  if (closeMinutes > 0) await closeIdle($, closeMinutes, agents)
  void refresh($)
}

// A reported job still watched (see Job.tail), as the sweep sees it. No quiet-screen rule:
// the report is out, so only hc's status says whether the turn goes on.
async function sweepTail($: EngineInterface, job: Job, agents: HcListed[] | undefined, a: HcListed | undefined, early: boolean) {
  if (await fresh($, job)) return await deliver($, job, 'done', QUIET_MS, undefined, { early })
  if (agents === undefined) return
  if (!a) {
    const n = (misses.get(job.name) ?? 0) + 1
    misses.set(job.name, n)
    // Its tab is gone: nothing more will come, and held messages have nowhere to go.
    if (n >= GONE_MISSES) {
      misses.delete(job.name)
      const { before, after } = await updateJob($, job.name, j =>
        j.token === job.token && j.status === 'reported' && j.tail ? { ...j, tail: undefined, queued: [] } : undefined,
      )
      const queued = before?.queued ?? []
      if (after && queued.length > 0)
        await post(
          $,
          `<herdr-agent name="${job.name}" profile="${job.profile}" status="gone">\n[${queued.length} message(s) held for it were not sent, as its tab is gone: ${queued.join(', ')}.]\n</herdr-agent>`,
          true,
        )
    }
    return
  }
  misses.delete(job.name)
  const status = a.status ?? 'unknown'
  lastStatus.set(job.name, status)
  if (status === 'blocked' && job.tail === 'early') return await blockedAfterReport($, job)
  if (status !== 'working' && status !== 'blocked' && status !== 'error') return await endTail($, job)
  if (status === 'working') job = await answered($, job)
  if (!armed.has(job.name)) arm($, job, status === 'working' ? 'finish' : 'resume')
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

// A patch for a job that still runs the prompt `job` was read for; anything else is left alone.
const live = (job: Job, fn: (j: Job) => Job) => (j: Job) => (j.token === job.token && j.status === 'running' ? fn(j) : undefined)

// A worker that wrote WAIT.json (see reportRule) waits with no model running:
// this runs its check every few minutes and prompts it once the check passes or
// times out. Returns whether the worker is waiting (or was just woken).
export async function waiting($: EngineInterface, job: Job, status: string, now: number) {
  const path = `${job.dir}/WAIT.json`
  const current = (await jobs($))[job.name]
  if (!current) return false
  if (!(await $.fs.exists(path))) {
    if (current.wait)
      await updateJob(
        $,
        job.name,
        live(job, j => ({ ...j, wait: undefined })),
      )
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
    const set = wait
    await updateJob(
      $,
      job.name,
      live(job, j => ({ ...j, wait: set })),
    )
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
    const next = { ...wait, lastAt: now }
    await updateJob(
      $,
      job.name,
      live(job, j => ({ ...j, wait: next })),
    )
    return true
  }
  // A worker still working (it wrote WAIT.json mid-turn) is woken once it stops.
  if (status === 'working') return true
  // The check may have run for minutes: a stop, a report or a new prompt since then ends this wait.
  const latest = await latestJob($, job.name)
  if (!latest || latest.status !== 'running' || latest.token !== job.token) return true
  await $.process.run(['rm', '-f', path])
  const mins = Math.round((now - wait.since) / 60_000)
  await prompt(
    $,
    { ...latest, wait: undefined },
    [
      `Your wait is over: ${wait.for} ${passed ? `is ready (the check passed after ${mins} min)` : `is still not ready after ${mins} min, so the wait timed out`}.`,
      out ? `The check's last output:\n${out}\n` : '',
      passed ? 'Carry on with your task.' : 'Decide whether to wait again (a new WAIT.json) or report what is blocking you.',
    ].join(' '),
  )
  return true
}

// `why` says why a worker stopped when hc's status alone doesn't (a prompt that never arrived).
// `opts.early`: the worker may still be in its turn, so its job stays watched (Job.tail).
export async function deliver(
  $: EngineInterface,
  job: Job,
  status: string,
  quietMs = QUIET_MS,
  why?: string,
  opts: { early?: boolean } = {},
) {
  const current = (await jobs($))[job.name]
  if (!current) return
  // A reported job still watched may deliver again, but only a report it has not delivered.
  if (current.status !== 'running' && !(current.tail && (await fresh($, current)))) return
  // A caller holding an earlier prompt's token does nothing: that prompt has been replaced.
  if (job.token !== undefined && current.token !== job.token) return
  seenReport.delete(job.name)
  if (status === 'gone') lastStatus.set(job.name, 'gone')
  const error = why ?? (status === 'gone' ? 'its tab is gone' : undefined)

  const resultPath = `${job.dir}/RESULT.md`
  let body: string
  // The PRs a report names, for the sidebar's task rows: its header's, else the PR link in the report.
  let prs: number[] = []
  // A report's header (see report.ts): its status and PRs go on the prompt's tag.
  let header: Header | undefined
  // The file this report was kept in, for the state file's block.
  let reportFile: string | undefined
  let tail: Job['tail']
  if (await reported($, current)) {
    if (status === 'done' && opts.early) tail = 'early'
    body = reportBody(await $.fs.read(resultPath))
    header = parseHeader(body)
    const linked = Number(body.match(/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/)?.[1]) || undefined
    prs = header?.prs.length ? header.prs : linked ? [linked] : []
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
    reportFile = full
    await archive($, job.dir, full.slice(job.dir.length + 1), body)
    const lines = body.split('\n').filter(l => l.trim())
    const ids: string[] = []
    // A header report shows each pinned question inline, as the coordinator can settle it from there.
    const pinnedLines: string[] = []
    for (const line of asked) {
      const [head = line, ...parts] = line.split(/\s+\|\s+/)
      const titled = head.match(/^\[([^\]]{1,40})\]\s*(.+)$/)
      const question = titled ? titled[2]! : head
      const marked = /\s*\((?:recommended|rec\.?)\)\s*/i
      const found = parts.findIndex(o => marked.test(o))
      const recommended = found >= 0 ? found : undefined
      const options = parts.map(o => o.replace(marked, ' ').trim()).filter(Boolean)
      const id = await ask($, job.name, question, options, recommended, titled?.[1], true)
      ids.push(`D${id}`)
      const shown = options.map((o, i) => (i === recommended ? `${o} (recommended)` : o))
      pinnedLines.push(`D${id} ${titled ? `[${titled[1]}] ` : ''}${question}${shown.length ? ` | ${shown.join(' | ')}` : ''}`)
    }
    if (header) body = summaryOf(header, full, lines.length, pinnedLines)
    else if (lines.length > INLINE_LINES || body.length > INLINE_CHARS) {
      const first = (lines[0] ?? '').replace(/^#+\s*/, '').slice(0, 200)
      body = `${first}\n[Full report, ${lines.length} lines: ${full}. Read it before acting on it.]`
    }
    if (ids.length)
      body += `\n\n[Pinned for the owner as ${ids.join(', ')}. The owner is pinged when this turn ends. Settle any that is not theirs (not a product rule, design choice or approval) now, with decided and your answer; the band shows them what you chose.]`
  } else if (status === 'blocked' && !why) {
    tail = 'blocked'
    body =
      'The worker is waiting at an approval or question in its herdr tab. Ask the person to answer it there; the message tool can answer a question, but not a permission request.'
    notify($, `${job.name} is blocked`, 'It waits at an approval or question in its herdr tab.')
  } else {
    // A CLI error, like a block, may pass: a report it writes after recovering is delivered too.
    if (status === 'error') tail = 'blocked'
    let lines = ''
    try {
      lines = (await readScreen($, job.name, 40)).trim()
    } catch {}
    const screen = `${job.dir}/SCREEN-${current.token ?? (await $.clock.now())}.txt`
    await $.fs.write(screen, lines.slice(-4000))
    reportFile = screen
    await archive($, job.dir, screen.slice(job.dir.length + 1), lines.slice(-4000))
    body = `The worker stopped (${error ?? `${status}, screen unchanged for ${Math.round(quietMs / 60_000)} min`}) without writing RESULT.md. Its screen and 40 lines of history above it are in ${screen}.`
  }

  // Patch the job as it is now: a message queued or a stop during the awaits above must stay.
  const endedAt = await $.clock.now()
  const { before, after } = await updateJob($, job.name, j =>
    j.token === current.token
      ? {
          ...prs.reduce((x, n) => withPr(x, n), j),
          status: 'reported',
          queued: tail === 'early' ? (j.queued ?? []) : [],
          wait: undefined,
          endedAt,
          tail,
          reportFile,
          reportStatus: status,
          headerStatus: header?.status,
        }
      : undefined,
  )
  if (!after) return
  // A worker blocked at a question, or whose CLI errored, may carry on: its next turn is the one to watch.
  if (tail === 'blocked') arm($, after, 'resume')
  // An early report leaves the turn's end to be waited on (a no-op while that wait is still armed).
  if (tail === 'early') arm($, after, 'finish')
  misses.delete(job.name)
  quiet.delete(job.name)
  $.ui.toast(`herdr worker ${job.name}: ${status}`)
  // An early report leaves held messages for the turn's end (endTail).
  const queued = tail === 'early' ? [] : (before?.queued ?? [])
  if (queued.length > 0) {
    if (status === 'done' && !after.closed) {
      // Messages held while a non-Claude worker worked go out now.
      await prompt($, { ...after, queued: [] }, heldPrompt(queued))
      body += `\n\n[The ${queued.length} message(s) queued for it were sent now; its next report follows.]`
    } else {
      body += `\n\n[${queued.length} message(s) held for it were not sent, as it did not finish (${status}): ${queued.join(', ')}.]`
    }
  }
  // The header's result and PRs, when it has them (see report.ts).
  const attrs = `${header?.status ? ` result="${header.status}"` : ''}${header?.prs.length ? ` pr="${header.prs.join(',')}"` : ''}${header?.verdict ? ` verdict="${header.verdict}"` : ''}`
  await post(
    $,
    `<herdr-agent name="${job.name}" profile="${job.profile}" status="${status}"${attrs}>\n${body.trim()}\n</herdr-agent>`,
    true,
  )
}

// session.start: each running worker gets its watch back, since a reload killed the children.
export function resumeWatching($: EngineInterface, list: Job[]) {
  for (const job of list) {
    if (job.status === 'starting') void serial(job.name, () => startFailed($, job, new Error('the mod reloaded while it started')))
    else if (job.status === 'running') arm($, job, 'finish')
    else if (job.tail) arm($, job, job.tail === 'blocked' ? 'resume' : 'finish')
  }
}

export type SpawnArgs = { worker: string; profile: string; task: string; cwd?: string; repo?: string; branch?: string; base?: string }

// A worktree for spawn to make before the worker starts.
type NewTree = { top: string; branch: string; base: string }

// The branch checked out in a folder, for the state file's block; undefined when git says none or fails.
async function currentBranch($: EngineInterface, cwd: string) {
  try {
    const r = await $.process.run(['git', '-C', cwd, 'branch', '--show-current'], { timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

export async function spawnWorker($: EngineInterface, e: SpawnArgs) {
  const { worker, profile, task, branch } = e
  if (!NAME.test(worker) || ADDRESS_LIKE.test(worker))
    return { deny: `worker must match ${NAME} and not look like a terminal address (t7, t1b)` }
  if (!!e.cwd === !!branch) return { deny: 'give exactly one of cwd (an existing folder) or branch (a new worktree)' }
  if (!branch && (e.repo || e.base)) return { deny: 'repo and base go with branch; cwd alone names an existing folder' }
  const off = await turnedOff($)
  if (off.has(profile)) return { deny: `${profile} is turned off in this folder's settings (disable); ${cmd('config')} turns it on.` }
  const all = await profiles($)
  const p = all[profile]
  if (!p) return { deny: `unknown profile ${profile}; have ${Object.keys(all).join(', ')}` }
  if (profile !== 'reviewer' && (await wrappingUp($)))
    return {
      deny: `Wrapping up: the owner stopped new work (${cmd('wrap-up')}). Let the running workers finish and send fixes to an open worker with message; only a reviewer for an open PR may start. The owner ends it with ${cmd('wrap-up')} off.`,
    }
  const known = (await jobs($))[worker]
  if (known && active(known)) return { deny: `worker ${worker} is still running; use message or stop` }
  // The coordinator's own terminal says which Herdr space the workers' tabs go to.
  const self = await $.env.get('HC_TERMINAL_ID')
  if (!self)
    return {
      deny: 'this session is not in an hc terminal. Start it in the Herdr app or with: hc run --bg claude. hc is herdr-core: https://github.com/herdrdev/herdr-core',
    }
  let space: string | undefined
  try {
    space = (await hc<HcTerminal>($, ['get', self])).labels?.['herdr.space']
  } catch (err) {
    return {
      deny: `cannot reach hc: ${err instanceof Error ? err.message : String(err)}. hc is herdr-core: https://github.com/herdrdev/herdr-core`,
    }
  }

  let cwd = e.cwd ?? ''
  let tree: NewTree | undefined
  if (branch) {
    const top = await repoTop($, e.repo)
    if (!top) return { deny: `${e.repo ?? session.cwd} is not a git checkout; pass repo` }
    cwd = worktreePath(top, branch)
    const checked = await checkWorktree($, top, branch, cwd)
    if ('deny' in checked) return checked
    if (!checked.reuse) {
      if (e.base && !(await validBranch($, e.base))) return { deny: `${e.base} is not a valid base branch name` }
      tree = { top, branch, base: e.base || (await defaultBase($, top)) }
    }
  }

  // One writer per worktree. A fix round goes to a fresh builder once the one that
  // wrote the PR is stopped, so its context stays small. The debugger takes over after failed rounds.
  if (!reviewsOnly(profile) && profile !== 'debugger') {
    for (const j of Object.values(await jobs($))) {
      if (j.name === worker || j.cwd !== cwd || reviewsOnly(j.profile)) continue
      try {
        // A finished terminal stays readable to hc get, so only a live one is a writer.
        if ((await hc<HcTerminal>($, ['get', j.name])).state !== 'live') continue
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
  const job: Job = { name: worker, profile, cwd, dir, startedAt: await $.clock.now(), status: 'starting', ...briefRefs(task, worker) }
  await saveJob($, job)
  // The tab, the CLI and the first prompt take many seconds: they run on, and the result of the start
  // (the first report, or a failed one) reaches the coordinator as a message.
  void serial(worker, () => startWorker($, job, task, p, space, tree))
  void refresh($)
  return {
    result: `${JSON.stringify({ worker, cwd, status: 'starting', ...(branch ? { branch } : {}) })}\nStarting ${worker} (${profile}, ${p.kind}) in herdr tab "${worker}". Its report, or a failed report if it does not start, arrives as a <herdr-agent> message.${space ? '' : ` Not in a Herdr space: watch it with hc attach ${worker}.`}`,
  }
}

// The background half of spawn. Each step that takes long is followed by a check that the job is still
// 'starting': a stop meanwhile ends it, and the terminal it made is closed.
async function startWorker($: EngineInterface, job: Job, task: string, p: Profile, space: string | undefined, tree?: NewTree) {
  const { name: worker, cwd, dir } = job
  const close = async () => {
    try {
      await closeTerminal($, worker)
    } catch {}
  }
  try {
    if (tree) await createWorktree($, tree.top, tree.branch, tree.base, cwd)
    await $.fs.write(`${dir}/TASK.md`, task)
    await excludeFromGit($, cwd)
    // The role comes last, so a profile's env cannot drop it. A worker's own session
    // reads it (see session.start).
    const env: [string, string][] = [...Object.entries(p.env ?? {}), ['HERDR_AGENTS_ROLE', 'worker']]
    // With a space the terminal is adopted into the coordinator's Herdr space, in a tab of its own.
    const labels = ['herdr-agents.role=worker', ...(space ? [`herdr.space=${space}`, `herdr.tab=hrd-${worker}`] : [])].flatMap(l => [
      '--label',
      l,
    ])
    const argv = await workerArgv($, p.kind, p.args, env)
    const made = await hc<{ address: string }>($, ['run', '--bg', '--no-parent', '--name', worker, '--cwd', cwd, ...labels, '--', ...argv])
    const saved = await updateJob($, worker, j => (j.status === 'starting' ? { ...j, address: made.address } : undefined))
    if (!saved.after) return await close()
    if (space) void nameTab($, worker)
    await waitReady($, worker, cwd, p.kind)
    const branch = await currentBranch($, cwd)
    const { before, after } = await updateJob($, worker, j =>
      j.status === 'starting' ? { ...j, status: 'running', ...(branch ? { branch } : {}), queued: [] } : undefined,
    )
    if (!after) return await close()
    // Messages sent while it started go in with its task (see messageWorker).
    const held = before?.queued ?? []
    const extra =
      held.length > 0
        ? ` Your coordinator also sent ${held.length} message(s) after the task: ${held.join(', ')}. Read them after TASK.md.`
        : ''
    await prompt($, after, `Your task is in ${dir}/TASK.md. Read it and do it.${extra}`, true)
    void refresh($)
  } catch (err) {
    await startFailed($, job, err)
  }
}

// Names the worker's tab after it, where Herdr would call it by its number. Best effort: tried
// twice, as the tab may not exist yet, and a failure only leaves the number.
async function nameTab($: EngineInterface, worker: string) {
  for (let i = 0; i < 2; i++) {
    try {
      const ran = await $.process.run(['herdr-app', 'do', 'tab.rename', '--id', `hrd-${worker}`, '--name', worker], { timeoutMs: 10_000 })
      if (ran.exitCode === 0) return
    } catch {}
    if (i === 0) await $.clock.sleep(1000)
  }
}

// A start that failed (or was cut off by a reload): the screen of its terminal is kept, the terminal is
// closed and the coordinator gets a failed report.
async function startFailed($: EngineInterface, job: Job, err: unknown) {
  const current = await latestJob($, job.name)
  if (!current) return
  if (current.status !== 'starting') {
    // The job went live before the error (a failed first prompt): nothing to fail now, but say so.
    if (current.status === 'running') {
      $.ui.toast(`herdr worker ${job.name}: its first prompt failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }
  const now = await $.clock.now()
  let reportFile: string | undefined
  if (current.address && (await $.fs.exists(current.dir))) {
    try {
      const text = (await readScreen($, current.name)).slice(-4000)
      const file = `${current.dir}/SCREEN-start-${now}.txt`
      await $.fs.write(file, text)
      await archive($, current.dir, file.slice(current.dir.length + 1), text)
      reportFile = file
    } catch {}
  }
  if (current.address) {
    try {
      await closeTerminal($, current.name)
    } catch {}
  }
  const { before, after } = await updateJob($, job.name, j =>
    j.status === 'starting'
      ? { ...j, status: 'reported', reportStatus: 'failed', endedAt: now, closed: true, reportFile, queued: [] }
      : undefined,
  )
  if (!after) return
  const reason = err instanceof Error ? err.message : String(err)
  const held = before?.queued ?? []
  const body = [
    `The worker did not start: ${reason}.${reportFile ? ` The screen of its tab is in ${reportFile}.` : ''}${current.address ? ' Its tab was closed.' : ''}`,
    ...(held.length > 0 ? [`[${held.length} message(s) held for it were not sent: ${held.join(', ')}.]`] : []),
  ].join('\n')
  await post($, `<herdr-agent name="${job.name}" profile="${job.profile}" status="failed">\n${body}\n</herdr-agent>`, true)
  $.ui.toast(`herdr worker ${job.name}: failed to start`)
  void refresh($)
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
  // hc refuses to type over a worker that waits at an approval or question. A question may be answered
  // (forced); a permission, auth or unknown prompt is the person's to answer in its tab.
  let force = false
  if (job.status !== 'starting') {
    try {
      const now = await hc<HcTerminal>($, ['get', job.name])
      const waits = now.state === 'live' && now.status?.state === 'blocked' ? now.status : undefined
      if (waits?.kind === 'question') force = true
      else if (waits)
        return {
          deny: `${e.worker} waits at ${waits.kind ? `a ${waits.kind} prompt` : 'an approval or question'} that only the person can answer. Ask them to answer it in its herdr tab.`,
        }
    } catch {}
  }
  // The suffix keeps two messages sent in one millisecond apart.
  const path = `${job.dir}/MESSAGE-${await $.clock.now()}-${crypto.randomUUID().slice(0, 4)}.md`
  await $.fs.write(path, text)
  const kind = (await profiles($))[job.profile]?.kind
  const hold = async () => {
    // Held only if the job still runs the prompt it was read for; deliver may have reported it meanwhile.
    const { after } = await updateJob($, job.name, j =>
      j.status === 'running' && j.token === job.token ? { ...j, queued: [...(j.queued ?? []), path] } : undefined,
    )
    return after !== undefined
  }
  // Returns why the text could not be typed, or undefined once it went in.
  const typeIn = async () => {
    try {
      await hc($, [
        'send',
        job.name,
        `Your coordinator sent an extra message while you work: ${path}. Read it and fold it into your current task. Your final report still goes to RESULT.md as first instructed.`,
        ...(force ? ['--force'] : []),
      ])
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
  const typedFailed = (why: string) => ({ deny: `could not type the message into ${e.worker}: ${why}` })
  if (job.status === 'starting') {
    // It has no CLI yet: the message goes in with its first prompt (see startWorker).
    const { after } = await updateJob($, job.name, j =>
      j.status === 'starting' ? { ...j, queued: [...(j.queued ?? []), path] } : undefined,
    )
    if (after) return { result: `${e.worker} is still starting; the message is handed to it with its task.` }
  }
  const heldResult = { result: `${e.worker} (${kind}) is mid-task, so the message is held and sent the moment it reports.` }
  if (job.status === 'running') {
    // Mid-task: Claude queues typed input for its next step, so it goes in now;
    // other CLIs get it the moment they report.
    if (kind === 'claude') {
      const why = await typeIn()
      if (why) return typedFailed(why)
      return { result: `Sent to ${e.worker} while it works; Claude takes it at its next step, and its one report covers both.` }
    }
    if (await hold()) return heldResult
  }
  // A follow-up goes to a file of its own and, when short, into the prompt itself.
  // Told to read TASK.md again, a worker that read it for its first task took it
  // for that task resent, did not open it and asked its DECISION lines again.
  // In the job's own step, so it cannot land between a report and the prompt that follows it.
  let result: { result: string } | { deny: string } | undefined
  await serial(job.name, async () => {
    const latest = await latestJob($, job.name)
    if (!latest) return
    if (latest.status === 'running') {
      // deliver just sent its queued messages: this one waits for that turn.
      if (kind === 'claude') {
        const why = await typeIn()
        result = why
          ? typedFailed(why)
          : { result: `Sent to ${e.worker} while it works; Claude takes it at its next step, and its one report covers both.` }
      } else {
        const { after } = await updateJob($, job.name, j =>
          j.status === 'running' ? { ...j, queued: [...(j.queued ?? []), path] } : undefined,
        )
        if (after) result = heldResult
      }
      if (result) return
    }
    if (latest.tail === 'early' && kind !== 'claude') {
      // Its report is out but its turn is not over: the message waits for that turn's end (settleTail).
      const { after } = await updateJob($, job.name, j =>
        j.token === latest.token && j.status === 'reported' && j.tail === 'early'
          ? { ...j, queued: [...(j.queued ?? []), path] }
          : undefined,
      )
      if (after) {
        result = {
          result: `${e.worker} (${kind}) is still finishing its turn after its report, so the message is held and sent when that turn ends.`,
        }
        return
      }
    }
    await prompt(
      $,
      latest,
      text.length <= MESSAGE_CHARS
        ? `New message from your coordinator (also saved in ${path}). It is not your earlier task again: it answers or follows your last report.\n\n${text}\n\nDo what it says.`
        : `New message from your coordinator in ${path}, a file you have not read yet. It is not your earlier task again: it answers or follows your last report. Read it now and do what it says.`,
      false,
      force,
    )
    result = { result: `Sent to ${e.worker}. Its next report will arrive as a <herdr-agent> message.` }
  })
  return result ?? { deny: `could not send to ${e.worker}; try again` }
}

export async function stopWorker($: EngineInterface, e: { worker: string }) {
  const job = (await jobs($))[e.worker]
  if (!job) return { deny: `no worker ${e.worker}` }
  if (job.status === 'starting') {
    const endedAt = await $.clock.now()
    const { after } = await updateJob($, job.name, j =>
      j.status === 'starting' ? { ...j, status: 'reported', reportStatus: 'stopped', endedAt, closed: true, tail: undefined } : undefined,
    )
    if (after) {
      if (after.address) {
        try {
          await closeTerminal($, job.name)
        } catch {}
      }
      return { result: `Stopped ${e.worker} while it was starting.${await belowTarget($)}` }
    }
  }
  // A worker that delivered a report keeps its status and file; one that did not is stopped.
  // Either way it leaves Blocked at once.
  await patchJob($, job.name, {
    status: 'reported',
    ...(job.status === 'running' || !job.reportFile ? { reportStatus: 'stopped' } : {}),
    headerStatus: undefined,
    endedAt: await $.clock.now(),
    tail: undefined,
  })
  try {
    await closeTerminal($, job.name)
  } catch (err) {
    return { result: `Marked ${e.worker} stopped; closing its tab failed: ${err}` }
  }
  await patchJob($, job.name, { closed: true })
  return { result: `Stopped ${e.worker} and closed its tab.${await belowTarget($)}` }
}

// A reported worker keeps its tab, and its CLI, for follow-ups, so finished workers
// piled up in herdr. Once one has sat idle `minutes` since its report, its tab is
// closed; a later follow-up goes to a fresh worker. One with a question still open,
// or that hc shows working or blocked, keeps its tab. `agents` is the sweep's list:
// undefined when that call failed, and then no tab is closed.
export async function closeIdle($: EngineInterface, minutes: number, agents?: HcListed[]) {
  if (agents === undefined) return
  const now = await $.clock.now()
  const asking = new Set((await openQuestions($)).map(d => d.from))
  const closed: string[] = []
  for (const job of Object.values(await jobs($))) {
    if (job.status !== 'reported' || job.tail || job.closed || asking.has(job.name)) continue
    if (job.endedAt === undefined || now - job.endedAt < minutes * 60_000) continue
    // A worker hc no longer lists live is marked closed; its finished terminal, if it left one, is removed.
    const agent = agents.find(a => a.name === job.name)
    if (agent) {
      if (agent.status === 'working' || agent.status === 'blocked') continue
      try {
        await closeTerminal($, job.name)
      } catch {
        continue
      }
      closed.push(job.name)
    } else {
      try {
        await hc($, ['rm', job.name])
      } catch {}
    }
    // A message may have woken it meanwhile.
    await updateJob($, job.name, j => (j.status === 'reported' ? { ...j, closed: true } : undefined))
  }
  if (closed.length) $.ui.toast(`Closed ${closed.length} idle worker tab${closed.length === 1 ? '' : 's'}: ${closed.join(', ')}`)
}
