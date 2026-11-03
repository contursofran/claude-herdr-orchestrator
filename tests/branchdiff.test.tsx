import { BATCH_MS } from '../hooks/defaults'
import { expect } from 'claude-code/testing'
import { DIFF_FILES_MAX, parseDiff } from '../hooks/branchdiff'
import { W, reportW } from './workerkit'
import { spawn, start, stopAll, test, until } from './harness'

// A worker's context fill and what its branch changes (#283), from the worker's file and git to the board.

const BOARD = '/home/t/.herdr-agents/board/session-1234.json'
const HEARTBEAT = '/home/t/.herdr-agents/app-mod.json'
const GIT = 'git -C /repo/wt'

test('numstat and name-status give the total and a row per file, by path, binary files counting no lines', () => {
  const diff = parseDiff(
    'main',
    '3\t1\tb.ts\t\n-\t-\timg.png\n10\t0\ta/new.ts\n'.replace('\t\n', '\n'),
    'M\tb.ts\nM\timg.png\nA\ta/new.ts\nD\told.ts\n',
  )
  expect(diff).toEqual({
    base: 'main',
    add: 13,
    del: 1,
    files: [
      { path: 'a/new.ts', status: 'A', add: 10, del: 0 },
      { path: 'b.ts', status: 'M', add: 3, del: 1 },
      { path: 'img.png', status: 'M', add: 0, del: 0 },
      { path: 'old.ts', status: 'D', add: 0, del: 0 },
    ],
    more: 0,
  })
})

test('no change is no diff, and past the cap the total still counts every file', () => {
  expect(parseDiff('main', '', '')).toBeNull()
  const n = DIFF_FILES_MAX + 5
  const names = Array.from({ length: n }, (_, i) => `f${String(i).padStart(3, '0')}.ts`)
  const diff = parseDiff('main', names.map(f => `2\t1\t${f}`).join('\n'), names.map(f => `M\t${f}`).join('\n'))
  expect(diff?.files).toHaveLength(DIFF_FILES_MAX)
  expect(diff).toMatchObject({ add: 2 * n, del: n, more: 5 })
})

const worker = (s: Awaited<ReturnType<typeof start>>) => () =>
  JSON.parse(s.files[BOARD] ?? '{}').workers?.find((w: { name: string }) => w.name === 'w-busy')
const poll = async (s: Awaited<ReturnType<typeof start>>) => {
  for (let i = 0; i < 5; i++) {
    s.files[HEARTBEAT] = JSON.stringify({ at: s.clock.now(), terminals: ['t1'] })
    await s.clock.advance(30_000)
  }
}

test("the board shows a worker's branch against the default branch, and drops it when nothing differs", async ($, on) => {
  const s = await start($, on)
  await spawn($, ['w-busy'], '/repo/wt')
  s.runs.set(`${GIT} symbolic-ref --short refs/remotes/origin/HEAD`, [{ exitCode: 0, stdout: 'origin/develop\n' }])
  s.runs.set(`${GIT} diff --no-renames --numstat origin/develop...HEAD`, [{ exitCode: 0, stdout: '4\t2\ta.ts\n1\t0\tb.ts\n' }])
  s.runs.set(`${GIT} diff --no-renames --name-status origin/develop...HEAD`, [{ exitCode: 0, stdout: 'M\ta.ts\nA\tb.ts\n' }])
  await poll(s)
  await until(s.clock, () => worker(s)()?.diff)
  expect(worker(s)().diff).toEqual({
    base: 'develop',
    add: 5,
    del: 2,
    files: [
      { path: 'a.ts', status: 'M', add: 4, del: 2 },
      { path: 'b.ts', status: 'A', add: 1, del: 0 },
    ],
    more: 0,
  })

  s.runs.set(`${GIT} diff --no-renames --numstat origin/develop...HEAD`, [{ exitCode: 0, stdout: '' }])
  s.runs.set(`${GIT} diff --no-renames --name-status origin/develop...HEAD`, [{ exitCode: 0, stdout: '' }])
  await poll(s)
  await until(s.clock, () => worker(s)()?.diff === undefined)
  expect(worker(s)().diff).toBe(undefined)
  await stopAll($, s.clock, ['w-busy'])
})

test('git failing leaves the worker with no diff and no error, and nothing is read while no app draws the board', async ($, on) => {
  const s = await start($, on)
  await spawn($, ['w-busy'], '/repo/wt')
  for (let i = 0; i < 5; i++) await s.clock.advance(30_000)
  expect(s.shell.some(c => c.includes(' diff '))).toBe(false)
  await poll(s)
  expect(s.shell.some(c => c.includes(' diff '))).toBe(true)
  expect(worker(s)().diff).toBe(undefined)
  await stopAll($, s.clock, ['w-busy'])
})

test("a worker's context is a percent of its window, kept between turns, and absent on an older worker", async ($, on) => {
  const s = await start($, on)
  await spawn($, ['w-busy'], '/repo/wt')
  await s.clock.advance(3000)
  expect(worker(s)().context).toBe(undefined)
  s.files[`${W}/LIVE.json`] = JSON.stringify({
    inTurn: false,
    outputAt: 0,
    command: null,
    commandAt: null,
    context: { tokens: 82_000, limit: 200_000 },
  })
  await s.clock.advance(3000)
  expect(worker(s)().context).toBe(41)
  s.files[`${W}/LIVE.json`] = JSON.stringify({
    inTurn: false,
    outputAt: 0,
    command: null,
    commandAt: null,
    context: { tokens: 900_000, limit: 200_000 },
  })
  await s.clock.advance(3000)
  expect(worker(s)().context).toBe(100)
  await stopAll($, s.clock, ['w-busy'])
})

test('a finished worker triggers no git calls and keeps the diff it had', async ($, on) => {
  const s = await start($, on)
  await spawn($, ['w-busy'], '/repo/wt')
  s.runs.set(`${GIT} symbolic-ref --short refs/remotes/origin/HEAD`, [{ exitCode: 0, stdout: 'origin/develop\n' }])
  s.runs.set(`${GIT} diff --no-renames --numstat origin/develop...HEAD`, [{ exitCode: 0, stdout: '4\t2\ta.ts\n' }])
  s.runs.set(`${GIT} diff --no-renames --name-status origin/develop...HEAD`, [{ exitCode: 0, stdout: 'M\ta.ts\n' }])
  // Steps of 10 s with a live heartbeat, so the worker can end 80 s after the poll that read its diff and be on the board at the next.
  const step = async (ms: number) => {
    for (let t = 0; t < ms; t += 10_000) {
      s.files[HEARTBEAT] = JSON.stringify({ at: s.clock.now(), terminals: ['t1'] })
      await s.clock.advance(10_000)
    }
  }
  while (!worker(s)()?.diff) await step(10_000)
  const diff = worker(s)().diff
  await step(70_000)
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone.`
  await s.finish('w-busy')
  s.shell.length = 0
  await step(50_000)
  expect(worker(s)()).toMatchObject({ state: 'reported' })
  expect(s.shell.some(c => c.includes(' diff ') || c.includes('symbolic-ref'))).toBe(false)
  expect(worker(s)().diff).toEqual(diff)
  await stopAll($, s.clock, ['w-busy'])
})

test('LIVE.json is read once per row per tick, for a finished row too', async ($, on) => {
  const s = await start($, on)
  await reportW($, s)
  s.files[`${W}/LIVE.json`] = JSON.stringify({ inTurn: false, outputAt: 0, command: null, commandAt: null })
  s.reads.length = 0
  await s.clock.advance(3000)
  const once = s.reads.filter(p => p === `${W}/LIVE.json`).length
  expect(once).toBe(1)
})
