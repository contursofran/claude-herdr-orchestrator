import { expect, test } from 'claude-code/testing'
import { step } from '../hooks/pipeline'
import type { Pipe, PipeAction, PipeFact, PipelineSettings } from '../types'

// The pipeline's reducer (pipeline.ts) is pure: facts in, state and actions out.

const CFG: PipelineSettings = {
  enabled: true,
  merge: 'ready',
  rounds: 3,
  rescueAfter: 2,
  profiles: { build: 'builder', review: 'reviewer', rescue: 'opus' },
  cap: null,
  ciEveryMinutes: 2,
  ciMaxMinutes: 60,
  noCiMinutes: 10,
  pauseMinutes: 30,
  maxSpawns: 8,
  ownerTest: [],
}
const MIN = 60_000
const H1 = 'a1a1a1a1'
const H2 = 'b2b2b2b2'
const H3 = 'c3c3c3c3'
const H4 = 'd4d4d4d4'

const built: PipeFact & { enroll: object } = {
  kind: 'report',
  job: 'b5',
  profile: 'builder',
  status: 'done',
  prs: [5],
  asks: 0,
  enroll: { repo: 'o/r', cwd: '/repo-wt/x', branch: 'x', base: 'main', issue: 22, head: H1 },
}
const reviewed = (job: string, verdict: 'approve' | 'changes' | undefined, head: string | undefined, status = 'done'): PipeFact => ({
  kind: 'report',
  job,
  profile: 'reviewer',
  status,
  prs: [],
  verdict,
  head,
  asks: 0,
  file: `/repo-wt/x/RESULT-${job}.md`,
})
const fixed = (job: string, head: string | undefined, status = 'done'): PipeFact => ({
  kind: 'report',
  job,
  profile: 'builder',
  status,
  prs: [],
  head,
  asks: 0,
})
const ci = (head: string, state: Pipe['ci'], log?: string): PipeFact => ({ kind: 'ci', head, ci: state, log })

// Runs facts in order and returns the pipe and every action returned along the way.
function run(facts: PipeFact[], cfg = CFG) {
  let pipe: Pipe | undefined
  let now = 0
  const actions: PipeAction[] = []
  for (const fact of facts) {
    now += MIN
    const out = step(pipe, fact, cfg, now)
    pipe = out.pipe
    actions.push(...out.actions)
  }
  return { pipe: pipe as Pipe, actions }
}
const spawns = (p: Pipe) => p.waiting.filter(a => a.kind === 'spawn').map(a => (a as { worker: string }).worker)

test('a done builder report with one PR and no ask enrolls it and queues a review', () => {
  const { pipe, actions } = run([built])
  expect(pipe).toMatchObject({ key: 'o/r#5', stage: 'review', head: H1, writer: 'b5', worker: 'r5', spawns: 1, round: 0 })
  expect(pipe.waiting).toEqual([{ kind: 'spawn', role: 'review', profile: 'reviewer', worker: 'r5' }])
  expect(actions).toEqual([])
})

test('reports that are not a clean single-PR done do not enroll', () => {
  for (const fact of [
    { ...built, status: 'blocked' },
    { ...built, status: 'failed' },
    { ...built, prs: [] },
    { ...built, prs: [5, 6] },
    { ...built, asks: 1 },
    { ...built, enroll: undefined },
  ] as PipeFact[]) {
    expect(step(undefined, fact, CFG, 0)).toEqual({ pipe: undefined, actions: [] })
  }
})

test('approve at the head and CI pass at the same head is ready, once', () => {
  const { pipe, actions } = run([built, reviewed('r5', 'approve', H1), ci(H1, 'pass'), ci(H1, 'pass')])
  expect(pipe.stage).toBe('ready')
  expect(actions).toEqual([{ kind: 'post', event: 'ready' }])
})

test('CI pass before the verdict waits for it', () => {
  const { pipe, actions } = run([built, ci(H1, 'pass')])
  expect(pipe.stage).toBe('review')
  expect(actions).toEqual([])
  const next = step(pipe, reviewed('r5', 'approve', H1), CFG, 9 * MIN)
  expect(next.pipe?.stage).toBe('ready')
  expect(next.actions).toEqual([{ kind: 'post', event: 'ready' }])
})

test('merge auto asks the runner to merge instead of posting ready', () => {
  const { pipe, actions } = run([built, reviewed('r5', 'approve', H1), ci(H1, 'pass')], { ...CFG, merge: 'auto' })
  expect(pipe.stage).toBe('merging')
  expect(actions).toEqual([{ kind: 'merge' }])
})

test('changes start fix round 1 with the builder, stop the writer and keep the review path', () => {
  const { pipe, actions } = run([built, reviewed('r5', 'changes', H1)])
  expect(pipe).toMatchObject({
    stage: 'fix',
    round: 1,
    worker: 'f5-1',
    writer: 'f5-1',
    blockers: '/repo-wt/x/RESULT-r5.md',
    approved: false,
  })
  expect(pipe.waiting.at(-1)).toEqual({ kind: 'spawn', role: 'fix', profile: 'builder', worker: 'f5-1' })
  expect(actions).toEqual([{ kind: 'stop', worker: 'b5' }])
})

test('round 3 uses the rescue profile and round 4 is handed with the round cap', () => {
  const rounds = run([
    built,
    reviewed('r5', 'changes', H1),
    fixed('f5-1', H2),
    reviewed('r5-2', 'changes', H2),
    fixed('f5-2', H3),
    reviewed('r5-3', 'changes', H3),
  ])
  expect(rounds.pipe.round).toBe(3)
  expect(rounds.pipe.waiting.at(-1)).toMatchObject({ role: 'fix', profile: 'opus', worker: 'f5-3' })
  const last = run([
    ...[],
    built,
    reviewed('r5', 'changes', H1),
    fixed('f5-1', H2),
    reviewed('r5-2', 'changes', H2),
    fixed('f5-2', H3),
    reviewed('r5-3', 'changes', H3),
    fixed('f5-3', H4),
    reviewed('r5-4', 'changes', H4),
  ])
  expect(last.pipe).toMatchObject({ stage: 'handed', reason: 'round cap', waiting: expect.any(Array) })
  expect(last.actions.at(-1)).toEqual({ kind: 'post', event: 'handed' })
})

test('CI fail while the reviewer runs waits, then one fix gets both inputs', () => {
  const mid = run([built, ci(H1, 'fail', '/repo-wt/x/.herdr-agents/pipe-5/CI-a1a1a1a1.log')])
  expect(mid.pipe.worker).toBe('r5')
  expect(spawns(mid.pipe)).toEqual(['r5'])
  expect(mid.pipe.round).toBe(0)
  const out = step(mid.pipe, reviewed('r5', 'changes', H1), CFG, 9 * MIN)
  expect(out.pipe).toMatchObject({
    stage: 'fix',
    round: 1,
    blockers: '/repo-wt/x/RESULT-r5.md',
    ciLog: '/repo-wt/x/.herdr-agents/pipe-5/CI-a1a1a1a1.log',
  })
  expect(spawns(out.pipe!)).toEqual(['r5', 'f5-1'])
})

test('approve with CI failed at that head starts a fix with the log only', () => {
  const mid = run([built, ci(H1, 'fail', 'log')])
  const out = step(mid.pipe, reviewed('r5', 'approve', H1), CFG, 9 * MIN)
  expect(out.pipe).toMatchObject({ stage: 'fix', round: 1, blockers: undefined, ciLog: 'log' })
})

test('CI fail with no worker running starts a fix', () => {
  const { pipe } = run([built, reviewed('r5', 'approve', H1), ci(H1, 'pending'), ci(H1, 'fail', 'log')])
  expect(pipe).toMatchObject({ stage: 'fix', worker: 'f5-1', ciLog: 'log' })
})

test('a verdict for an older head queues a new review, once per head', () => {
  const moved = run([built, ci(H2, 'pending')])
  expect(moved.pipe.head).toBe(H2)
  const stale = step(moved.pipe, reviewed('r5', 'approve', H1), CFG, 9 * MIN)
  expect(stale.pipe).toMatchObject({ stage: 'review', worker: 'r5-2', approved: false })
  expect(spawns(stale.pipe!)).toEqual(['r5', 'r5-2'])
  // a second stale verdict for the same head is not reviewed again
  const again = step(stale.pipe, reviewed('r5-2', 'approve', H1), CFG, 10 * MIN)
  expect(again.pipe).toMatchObject({ stage: 'handed', reason: 'stale review' })
})

test('a fix that leaves the head as it was is a failed round and starts the next one', () => {
  const { pipe } = run([built, reviewed('r5', 'changes', H1), fixed('f5-1', H1)])
  expect(pipe).toMatchObject({ failedRounds: 1, round: 2, stage: 'fix', worker: 'f5-2' })
})

test('a fix that pushed a new head clears the old verdict and is reviewed again', () => {
  const { pipe } = run([built, reviewed('r5', 'changes', H1), fixed('f5-1', H2)])
  expect(pipe).toMatchObject({ stage: 'review', head: H2, approved: false, ci: 'unknown', worker: 'r5-2', reviewed: H1 })
})

test('CI showing the pushed head before the fix report is not a failed round', () => {
  const { pipe } = run([built, reviewed('r5', 'changes', H1), ci(H2, 'pending'), fixed('f5-1', H2)])
  expect(pipe).toMatchObject({ failedRounds: 0, stage: 'review', head: H2, ci: 'pending', worker: 'r5-2' })
})

test('a fix that is not done is handed', () => {
  const { pipe, actions } = run([built, reviewed('r5', 'changes', H1), fixed('f5-1', undefined, 'blocked')])
  expect(pipe).toMatchObject({ stage: 'handed', reason: 'fix blocked' })
  expect(actions.at(-1)).toEqual({ kind: 'post', event: 'handed' })
})

test('a review without a verdict is handed', () => {
  const { pipe, actions } = run([built, reviewed('r5', undefined, H1)])
  expect(pipe).toMatchObject({ stage: 'handed', reason: 'no verdict', waiting: [] })
  expect(actions).toEqual([{ kind: 'post', event: 'handed' }])
})

test('a fact repeated does not queue a second step', () => {
  const first = run([built, reviewed('r5', 'changes', H1)])
  const again = step(first.pipe, reviewed('r5', 'changes', H1), CFG, 9 * MIN)
  expect(again.actions).toEqual([])
  expect(spawns(again.pipe!)).toEqual(spawns(first.pipe))
  const ready = run([built, reviewed('r5', 'approve', H1), ci(H1, 'pass')])
  expect(step(ready.pipe, ci(H1, 'pass'), CFG, 9 * MIN).actions).toEqual([])
})

test('a report from a job that is not the pipe worker is ignored', () => {
  const { pipe } = run([built])
  const out = step(pipe, fixed('b5', H2), CFG, 9 * MIN)
  expect(out.pipe).toEqual(pipe)
  expect(out.actions).toEqual([])
})

test('too many spawns hands the PR', () => {
  const { pipe } = run([built, reviewed('r5', 'changes', H1), fixed('f5-1', H2)], { ...CFG, maxSpawns: 2 })
  expect(pipe).toMatchObject({ stage: 'handed', reason: 'too many rounds' })
})

test('a stop by the coordinator hands the PR', () => {
  const { pipe, actions } = run([built, { kind: 'stopped' }])
  expect(pipe).toMatchObject({ stage: 'handed', reason: 'stopped by the coordinator' })
  expect(actions).toEqual([{ kind: 'post', event: 'handed' }])
})

test('merged or closed by hand ends the pipe without a prompt', () => {
  for (const kind of ['merged', 'closed'] as const) {
    const { pipe, actions } = run([built, { kind }])
    expect(pipe).toMatchObject({ stage: kind, waiting: [] })
    expect(actions).toEqual([])
  }
})

test('the mod merging a PR posts merged', () => {
  const { actions } = run([built, reviewed('r5', 'approve', H1), ci(H1, 'pass'), { kind: 'merged' }], { ...CFG, merge: 'auto' })
  expect(actions.at(-1)).toEqual({ kind: 'post', event: 'merged' })
})

test('CI pending past ciMaxMinutes is handed; none past noCiMinutes counts as pass', () => {
  const pending = run([built, ci(H1, 'pending')])
  expect(step(pending.pipe, { kind: 'tick' }, CFG, 30 * MIN).pipe?.stage).toBe('review')
  const late = step(pending.pipe, { kind: 'tick' }, CFG, 62 * MIN + MIN)
  expect(late.pipe).toMatchObject({ stage: 'handed', reason: 'CI pending for 60 min' })
  const none = run([built, reviewed('r5', 'approve', H1), ci(H1, 'none')])
  expect(none.pipe.stage).toBe('review')
  const done = step(none.pipe, { kind: 'tick' }, CFG, 20 * MIN)
  expect(done.pipe?.stage).toBe('ready')
  expect(done.actions).toEqual([{ kind: 'post', event: 'ready' }])
})

test('release removes the pipe; resume restarts a handed one with fresh rounds', () => {
  const owned = run([built])
  expect(step(owned.pipe, { kind: 'release' }, CFG, 9 * MIN)).toEqual({ pipe: undefined, actions: [] })
  const handed = run([built, reviewed('r5', undefined, H1)])
  const back = step(handed.pipe, { kind: 'resume' }, CFG, 9 * MIN)
  expect(back.pipe).toMatchObject({ stage: 'review', reason: undefined, round: 0, spawns: 1, worker: 'r5-2' })
})

test('facts do not change the pipe they were given', () => {
  const { pipe } = run([built])
  const copy = structuredClone(pipe)
  step(pipe, reviewed('r5', 'changes', H1), CFG, 9 * MIN)
  expect(pipe).toEqual(copy)
})

test('an approved pipe waiting for CI re-reviews when the head moves', () => {
  const { pipe } = run([built, reviewed('r5', 'approve', H1), ci(H2, 'pass')])
  expect(pipe?.head).toBe(H2)
  expect(pipe?.worker).toBe('r5-2')
  expect(pipe?.waiting).toContainEqual(expect.objectContaining({ kind: 'spawn', role: 'review' }))
})

test('a late CI result for an old head does not move the head back', () => {
  const { pipe } = run([
    built,
    reviewed('r5', 'changes', H1),
    { kind: 'report', job: 'f5-1', profile: 'builder', status: 'done', prs: [5], asks: 0, head: H2 },
    ci(H1, 'fail', 'log'),
  ])
  expect(pipe?.head).toBe(H2)
  expect(pipe?.ci).toBe('unknown')
  expect(pipe?.stage).toBe('review')
})

test("a failed fact hands the PR back with the runner's reason, once", () => {
  const { pipe, actions } = run([built, { kind: 'failed', reason: 'could not start r5: reviewer is turned off' }])
  expect(pipe?.stage).toBe('handed')
  expect(pipe?.reason).toBe('could not start r5: reviewer is turned off')
  expect(pipe?.waiting).toEqual([])
  expect(actions).toEqual([{ kind: 'post', event: 'handed' }])
  const again = step(pipe, { kind: 'failed', reason: 'x' }, CFG, 0)
  expect(again.actions).toEqual([])
})
