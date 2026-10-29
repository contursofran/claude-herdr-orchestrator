import type { Pipe, PipeAction, PipeFact, PipelineSettings } from '../types'
import { PIPE_LOG_KEPT } from './defaults'

// The PR pipeline's rules as one pure function: a PR's state and one fact in, the new
// state and the actions out. No herdr, gh, clock or files here; the runner reads facts
// from the world and carries out the actions.
//
// - `spawn` steps are not returned: they are queued in `pipe.waiting` (the runner starts
//   one only below the worker cap, oldest first). `pipe.worker` names the pipeline job
//   running or waiting for its slot; a fix starts only while it is empty.
// - `stage: 'review'` with no `worker` means approved and waiting for CI.
// - Every step is keyed `kind@head` in `pipe.done` and never taken twice.

type Enroll = { repo: string; cwd: string; branch?: string; base?: string; issue?: number; head?: string }

// A report fact may carry what a new pipe needs; the runner adds it for builder-type jobs only.
type Fact = PipeFact & { enroll?: Enroll }

const ENDED = ['merged', 'closed', 'handed']

const shortSha = (sha?: string) => (sha ?? '').slice(0, 8)

function log(p: Pipe, now: number, text: string) {
  p.log = [...p.log, { at: now, text }].slice(-PIPE_LOG_KEPT)
}

function hand(p: Pipe, now: number, reason: string, actions: PipeAction[]) {
  p.stage = 'handed'
  p.reason = reason
  p.waiting = []
  p.worker = undefined
  log(p, now, `handed: ${reason}`)
  if (!p.done.includes(`post:handed@${p.head}`)) {
    p.done = [...p.done, `post:handed@${p.head}`]
    actions.push({ kind: 'post', event: 'handed' })
  }
}

// Queues a step unless its key was taken; false when it was dropped.
function queue(p: Pipe, cfg: PipelineSettings, now: number, action: PipeAction & { kind: 'spawn' }, key: string, actions: PipeAction[]) {
  if (p.done.includes(key)) return false
  if (p.spawns >= cfg.maxSpawns) {
    hand(p, now, 'too many rounds', actions)
    return false
  }
  p.done = [...p.done, key]
  p.spawns += 1
  p.waiting = [...p.waiting, action]
  p.worker = action.worker
  return true
}

function review(p: Pipe, cfg: PipelineSettings, now: number, actions: PipeAction[]) {
  const before = p.done.filter(k => /^review(-old)?@/.test(k)).length
  const worker = before === 0 ? `r${p.pr}` : `r${p.pr}-${before + 1}`
  p.stage = 'review'
  const ok = queue(p, cfg, now, { kind: 'spawn', role: 'review', profile: cfg.profiles.review, worker }, `review@${p.head}`, actions)
  if (ok) log(p, now, `${worker} started`)
  return ok
}

// A fix round: round n is the builder profile up to `rescueAfter`, then the rescue one;
// past `rounds` the PR goes to the coordinator.
function fix(p: Pipe, cfg: PipelineSettings, now: number, actions: PipeAction[]) {
  if (p.round + 1 > cfg.rounds) return hand(p, now, 'round cap', actions)
  const round = p.round + 1
  const profile = round <= cfg.rescueAfter ? cfg.profiles.build : cfg.profiles.rescue
  const worker = `f${p.pr}-${round}`
  const was = p.writer
  if (!queue(p, cfg, now, { kind: 'spawn', role: 'fix', profile, worker }, `fix${round}@${p.head}`, actions)) return
  p.round = round
  p.stage = 'fix'
  if (was) actions.push({ kind: 'stop', worker: was })
  p.writer = worker
  log(p, now, `${worker} started`)
}

// Approved and green at the same head: ready for the coordinator, or merged by the mod.
function ready(p: Pipe, cfg: PipelineSettings, now: number, actions: PipeAction[]) {
  if (p.stage === 'ready' || p.stage === 'merging' || p.worker) return
  if (!p.approved || p.ci !== 'pass' || p.reviewed !== p.head || p.ciHead !== p.head) return
  const key = `post:ready@${p.head}`
  if (p.done.includes(key)) return
  p.done = [...p.done, key]
  if (cfg.merge === 'auto') {
    p.stage = 'merging'
    actions.push({ kind: 'merge' })
  } else {
    p.stage = 'ready'
    actions.push({ kind: 'post', event: 'ready' })
  }
  log(p, now, `approved and CI pass at ${shortSha(p.head)}`)
}

// The head the last fix round started from: it is in the key of the round's step.
const fixBase = (p: Pipe) =>
  p.done
    .filter(k => /^fix\d+@/.test(k))
    .pop()
    ?.replace(/^fix\d+@/, '')

function onReview(p: Pipe, f: Extract<Fact, { kind: 'report' }>, cfg: PipelineSettings, now: number, actions: PipeAction[]) {
  p.worker = undefined
  if (f.status !== 'done') return hand(p, now, `review ${f.status}`, actions)
  if (!f.verdict) return hand(p, now, 'no verdict', actions)
  if (p.head && f.head && p.head !== f.head) {
    // the verdict is for an older commit: review the current one, once per head
    log(p, now, `${f.job} reviewed ${shortSha(f.head)}, head is ${shortSha(p.head)}`)
    if (!review(p, cfg, now, actions) && p.stage !== 'handed') hand(p, now, 'stale review', actions)
    return
  }
  if (!p.head && f.head) p.head = f.head
  p.reviewed = p.head
  if (f.verdict === 'approve') {
    p.approved = true
    p.blockers = undefined
    log(p, now, `${f.job} approved`)
    if (p.ci === 'fail' && p.ciHead === p.head) return fix(p, cfg, now, actions)
    p.stage = 'review'
    return ready(p, cfg, now, actions)
  }
  p.approved = false
  p.blockers = f.file
  log(p, now, `${f.job} changes`)
  fix(p, cfg, now, actions)
}

function onFix(p: Pipe, f: Extract<Fact, { kind: 'report' }>, cfg: PipelineSettings, now: number, actions: PipeAction[]) {
  p.worker = undefined
  if (f.status !== 'done') return hand(p, now, `fix ${f.status}`, actions)
  const base = fixBase(p)
  // CI may have shown the pushed head already; a head that still equals the one the round
  // started from means nothing was pushed
  if (f.head && f.head === base) {
    p.failedRounds += 1
    log(p, now, `${f.job} pushed nothing`)
    return fix(p, cfg, now, actions)
  }
  if (f.head && f.head !== p.head) setHead(p, f.head)
  else if (!f.head) setHead(p, undefined)
  log(p, now, `${f.job} pushed ${shortSha(p.head)}`)
  review(p, cfg, now, actions)
}

// A new head: nothing known about it yet.
function setHead(p: Pipe, head: string | undefined) {
  p.head = head
  p.approved = false
  p.ci = 'unknown'
  p.ciHead = undefined
  p.ciSince = undefined
  p.ciLog = undefined
}

export function step(pipe: Pipe | undefined, fact: Fact, cfg: PipelineSettings, now: number): { pipe?: Pipe; actions: PipeAction[] } {
  const actions: PipeAction[] = []

  if (!pipe) {
    // only a done builder report with one PR, no ask or decision, and what a pipe needs, enrolls
    if (fact.kind !== 'report' || !fact.enroll) return { actions }
    const [pr] = fact.prs
    if (fact.status !== 'done' || fact.prs.length !== 1 || pr === undefined || fact.asks > 0) return { actions }
    const e = fact.enroll
    const p: Pipe = {
      key: `${e.repo}#${pr}`,
      repo: e.repo,
      pr,
      cwd: e.cwd,
      branch: e.branch,
      base: e.base,
      issue: e.issue,
      stage: 'review',
      head: e.head,
      approved: false,
      ci: 'unknown',
      round: 0,
      failedRounds: 0,
      spawns: 0,
      writer: fact.job,
      waiting: [],
      done: [],
      log: [],
      since: now,
    }
    log(p, now, `${fact.job} opened the PR`)
    review(p, cfg, now, actions)
    return { pipe: p, actions }
  }

  if (fact.kind === 'release') return { actions }

  const p: Pipe = { ...pipe, waiting: [...pipe.waiting], done: [...pipe.done], log: [...pipe.log] }

  if (fact.kind === 'resume') {
    if (p.stage !== 'handed') return { pipe, actions }
    p.reason = undefined
    p.round = 0
    p.failedRounds = 0
    p.spawns = 0
    p.worker = undefined
    // the old review key is renamed, not dropped: it still counts for the next worker's name
    p.done = p.done.filter(k => k !== `post:handed@${p.head}`).map(k => (k === `review@${p.head}` ? `review-old@${p.head}` : k))
    log(p, now, 'resumed')
    review(p, cfg, now, actions)
    return { pipe: p, actions }
  }

  if (ENDED.includes(p.stage)) {
    // a hand-merge or a close still ends a handed pipe
    if (p.stage === 'handed' && (fact.kind === 'merged' || fact.kind === 'closed')) {
      p.stage = fact.kind
      log(p, now, fact.kind)
      return { pipe: p, actions }
    }
    return { pipe, actions }
  }

  switch (fact.kind) {
    case 'report': {
      if (!p.worker || fact.job !== p.worker) break
      if (p.stage === 'review') onReview(p, fact, cfg, now, actions)
      else if (p.stage === 'fix') onFix(p, fact, cfg, now, actions)
      break
    }
    case 'ci': {
      if (fact.head !== p.head) {
        const moved = p.head !== undefined
        setHead(p, fact.head)
        if (moved) log(p, now, `head is ${shortSha(fact.head)}`)
      }
      if (p.ci !== fact.ci || p.ciHead !== fact.head) p.ciSince = now
      p.ci = fact.ci
      p.ciHead = fact.head
      p.ciLog = fact.ci === 'fail' ? fact.log : undefined
      if (fact.ci === 'fail') {
        log(p, now, `CI fail at ${shortSha(fact.head)}`)
        if (!p.worker) fix(p, cfg, now, actions)
      } else if (!p.worker && !p.approved && p.reviewed !== p.head && p.stage === 'ready') {
        // someone pushed to a ready PR: the verdict no longer covers it
        review(p, cfg, now, actions)
      } else if (fact.ci === 'pass') ready(p, cfg, now, actions)
      break
    }
    case 'tick': {
      if (p.ci === 'pending' && p.ciSince !== undefined && now - p.ciSince > cfg.ciMaxMinutes * 60_000) {
        hand(p, now, `CI pending for ${cfg.ciMaxMinutes} min`, actions)
      } else if (p.ci === 'none' && p.ciSince !== undefined && now - p.ciSince >= cfg.noCiMinutes * 60_000) {
        // no checks at all for a while: nothing to wait for
        p.ci = 'pass'
        log(p, now, 'no CI')
        ready(p, cfg, now, actions)
      }
      break
    }
    case 'stopped':
      hand(p, now, 'stopped by the coordinator', actions)
      break
    case 'merged':
    case 'closed': {
      const mine = p.stage === 'merging'
      p.stage = fact.kind
      p.waiting = []
      p.worker = undefined
      log(p, now, fact.kind)
      if (fact.kind === 'merged' && mine) actions.push({ kind: 'post', event: 'merged' })
      break
    }
    default:
      // ownerOk and limit belong to later slices
      break
  }
  return { pipe: p, actions }
}
