import { expect } from 'claude-code/testing'
import { spawn, start, stopAll, test } from './harness'

// The board file (bridge.ts): every copy of the app mod redraws the whole window when it is written (#151).

const W = '/repo-w-busy/.herdr-agents/w-busy'
const BOARD = '/home/t/.herdr-agents/board/session-1234.json'

// How many times the board is written: its entry in the fake file system counts each set.
function countWrites(files: Record<string, string>) {
  const count = { writes: 0 }
  let text = files[BOARD]
  Object.defineProperty(files, BOARD, {
    enumerable: true,
    configurable: true,
    get: () => text,
    set: (v: string) => {
      count.writes++
      text = v
    },
  })
  return count
}
const parkedWorker = (files: Record<string, string>) => JSON.parse(files[BOARD]!).workers[0]

test('a parked worker writes the board at most once a minute: its clock, the minute and its checks add no writes', async ($, on) => {
  const { clock, files } = await start($, on)
  await spawn($, ['w-busy'])
  files[`${W}/WAIT.json`] = '{"for":"PR #77 checks","check":"false","every":1,"max":60}'
  await clock.advance(60_000)
  const since = parkedWorker(files).since
  expect(parkedWorker(files)).toMatchObject({ state: 'waiting', note: 'PR #77 checks' })
  expect(typeof since).toBe('number')
  const count = countWrites(files)
  await clock.advance(5 * 60_000)
  expect(count.writes).toBeGreaterThan(0)
  expect(count.writes).toBeLessThanOrEqual(5)
  await stopAll($, clock, ['w-busy'])
})

test('the board gives a parked worker what it waits for and since when, for the app to count from', async ($, on) => {
  const { clock, files } = await start($, on)
  await spawn($, ['w-busy'])
  files[`${W}/WAIT.json`] = '{"for":"CI","check":"false","every":1,"max":60}'
  await clock.advance(60_000)
  const parked = () => (JSON.parse(files[BOARD]!).workers as { name: string; state: string; note: string; since: number }[])[0]!
  const first = parked()
  expect(first).toMatchObject({ name: 'w-busy', state: 'waiting', note: 'CI' })
  expect(typeof first.since).toBe('number')
  await clock.advance(120_000)
  expect(parked().since).toBe(first.since)
  await stopAll($, clock, ['w-busy'])
})

test('the board is written again when something in it changes, with a new time', async ($, on) => {
  const { clock, files } = await start($, on)
  await spawn($, ['w-busy'])
  await clock.advance(60_000)
  const before = JSON.parse(files[BOARD]!)
  const count = countWrites(files)
  files[`${W}/WAIT.json`] = '{"for":"CI","check":"false","every":1,"max":60}'
  await clock.advance(60_000)
  expect(count.writes).toBeGreaterThan(0)
  const after = JSON.parse(files[BOARD]!)
  expect(after.workers[0].note).toBe('CI')
  expect(after.at).toBeGreaterThan(before.at)
  await stopAll($, clock, ['w-busy'])
})

test("an idle coordinator's board keeps a moving time, so it beats a leftover", async ($, on) => {
  const { clock, files } = await start($, on)
  await clock.advance(60_000)
  const first = JSON.parse(files[BOARD]!).at
  await clock.advance(61_000)
  const second = JSON.parse(files[BOARD]!).at
  expect(second).toBeGreaterThan(first)
  await clock.advance(61_000)
  expect(JSON.parse(files[BOARD]!).at).toBeGreaterThan(second)
})

test('a deleted board comes back within 2 minutes', async ($, on) => {
  const { clock, files } = await start($, on)
  await clock.advance(60_000)
  delete files[BOARD]
  await clock.advance(120_000)
  expect(files[BOARD]).toBeDefined()
  expect(JSON.parse(files[BOARD]!).session).toBe('session-1234')
})
