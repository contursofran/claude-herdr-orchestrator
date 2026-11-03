import { expect } from 'claude-code/testing'
import { failedJob, parseLog, runIdOf } from '../hooks/failure'
import { settled, start, stopAll, test, until } from './harness'

// The job and tests behind a failed CI (#282), from `gh pr view` and the failed job's log to the board.

const BOARD = '/home/t/.herdr-agents/board/session-1234.json'
const HEARTBEAT = '/home/t/.herdr-agents/app-mod.json'
const R = 'acme/app-client'
const URL = `https://github.com/${R}/actions/runs/777/job/1`

test('the failed job, its run time and its run come from the checks', () => {
  const checks = [
    { name: 'lint', conclusion: 'SUCCESS' },
    { name: 'test', conclusion: 'FAILURE', detailsUrl: URL, startedAt: '2026-11-02T10:00:00Z', completedAt: '2026-11-02T10:03:05Z' },
  ]
  expect(failedJob(checks, 'abc')).toMatchObject({ head: 'abc', job: 'test', url: URL, seconds: 185, tests: [], failed: null })
  expect(failedJob([{ name: 'lint', conclusion: 'SUCCESS' }], 'abc')).toBeNull()
  expect(failedJob([{ context: 'ci/legacy', state: 'ERROR' }], 'abc')).toMatchObject({ job: 'ci/legacy', url: null, seconds: null })
  expect(runIdOf(URL)).toBe('777')
  expect(runIdOf('https://ci.example.com/build/1')).toBeNull()
  expect(runIdOf(null)).toBeNull()
})

test('a very long test name is cut before it goes on the board', () => {
  const log = `(fail) ${'x'.repeat(500)}\n0 pass\n1 fail\n`
  expect(parseLog(log).tests[0]).toHaveLength(200)
})

test('a bun log gives the failing tests and totals, a few names and how many more', () => {
  const line = (t: string) => `test\tRun tests\t2026-11-02T10:00:00.0000000Z ${t}`
  const log = [
    line('(fail) a > one [1.20ms]'),
    line('(fail) a > two'),
    line('(fail) b > three'),
    line('(fail) b > four'),
    line('(fail) a > one [1.20ms]'),
    line(' 46 pass'),
    line(' 4 fail'),
  ].join('\n')
  expect(parseLog(log)).toEqual({ failed: 4, passed: 46, tests: ['a > one', 'a > two', 'b > three'], more: 1 })
})

test('a vitest log reads too, and a log with nothing recognisable gives nothing', () => {
  expect(parseLog(' FAIL  src/a.test.ts > adds\n Tests  1 failed | 9 passed (10)\n')).toEqual({
    failed: 1,
    passed: 9,
    tests: ['src/a.test.ts > adds'],
    more: 0,
  })
  expect(parseLog('npm ERR! something\n')).toEqual({ failed: null, passed: null, tests: [], more: 0 })
})

async function onePr($: Parameters<typeof start>[0], on: Parameters<typeof start>[1]) {
  const s = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'r-15', profile: 'reviewer', cwd: '/repo', task: `Review ${R} PR #15` })
  await settled()
  const poll = async () => {
    for (let i = 0; i < 5; i++) {
      s.files[HEARTBEAT] = JSON.stringify({ at: s.clock.now(), terminals: ['t1'] })
      await s.clock.advance(30_000)
    }
  }
  const row = () => JSON.parse(s.files[BOARD] ?? '{}').tasks?.find((t: { pr: number }) => t.pr === 15)
  const logReads = () => s.shell.filter(c => c.startsWith('gh run view')).length
  return { ...s, poll, row, logReads }
}

const failing = (head: string) => ({
  state: 'OPEN',
  headRefOid: head,
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      name: 'test',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: URL,
      startedAt: '2026-11-02T10:00:00Z',
      completedAt: '2026-11-02T10:01:00Z',
    },
  ],
  mergeable: 'MERGEABLE',
  baseRefName: 'main',
  files: [],
})

test('a failing PR gets its tests on the board, the log is read once per head, and a pass clears it', async ($, on) => {
  const { clock, prs, runLogs, poll, row, logReads } = await onePr($, on)
  runLogs['777'] = '(fail) a > one\n(fail) a > two\n 46 pass\n 2 fail\n'
  prs[`${R}#15`] = failing('h1')
  await poll()
  await until(clock, () => row()?.ciFailure)
  expect(row().ciFailure).toEqual({ job: 'test', url: URL, seconds: 60, failed: 2, passed: 46, tests: ['a > one', 'a > two'], more: 0 })
  expect(logReads()).toBe(1)

  // Same head, read again: no second log read.
  await poll()
  await poll()
  expect(logReads()).toBe(1)

  // A new head that fails reads the log again.
  runLogs['777'] = '(fail) a > three\n 47 pass\n 1 fail\n'
  prs[`${R}#15`] = failing('h2')
  await poll()
  await until(clock, () => row()?.ciFailure?.tests[0] === 'a > three')
  expect(logReads()).toBe(2)

  // Passing: nothing to show.
  prs[`${R}#15`] = { state: 'OPEN', headRefOid: 'h3', statusCheckRollup: [], mergeable: 'MERGEABLE', baseRefName: 'main', files: [] }
  await poll()
  await until(clock, () => row()?.ciFailure === null)
  expect(logReads()).toBe(2)
  await stopAll($, clock, ['r-15'])
})

test('a log that cannot be read still names the failed job, and is not asked for again', async ($, on) => {
  const { clock, prs, poll, row, logReads } = await onePr($, on)
  prs[`${R}#15`] = failing('h1')
  await poll()
  await until(clock, () => row()?.ciFailure)
  expect(row().ciFailure).toMatchObject({ job: 'test', failed: null, tests: [], more: 0 })
  await poll()
  expect(logReads()).toBe(1)
  await stopAll($, clock, ['r-15'])
})
