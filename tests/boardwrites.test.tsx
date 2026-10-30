import { expect } from 'claude-code/testing'
import { BAND, spawn, start, stopAll, test } from './harness'

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

test('a parked worker writes the board once: its clock, the minute and its checks do not', async ($, on) => {
  const { clock, files } = await start($, on)
  await spawn($, ['w-busy'])
  files[`${W}/WAIT.json`] = '{"for":"PR #77 checks","check":"false","every":1,"max":60}'
  await clock.advance(60_000)
  const since = parkedWorker(files).since
  expect(parkedWorker(files)).toMatchObject({ state: 'waiting', note: 'PR #77 checks' })
  expect(typeof since).toBe('number')
  const count = countWrites(files)
  await clock.advance(5 * 60_000)
  expect(count.writes).toBe(0)
  await stopAll($, clock, ['w-busy'])
})

test('the band still shows the clock of a parked worker, and it runs on', async ($, on) => {
  const { clock, files } = await start($, on)
  await spawn($, ['w-busy'])
  files[`${W}/WAIT.json`] = '{"for":"CI","check":"false","every":1,"max":60}'
  await clock.advance(60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const clockShown = async () => {
    await band.redraw()
    return (await band.find({ type: 'Text', text: /⏸ \d\d:\d\d · CI/ }))?.text.match(/\d\d:\d\d/)?.[0]
  }
  const first = await clockShown()
  expect(first).toBeDefined()
  await clock.advance(120_000)
  const later = await clockShown()
  expect(later).toBeDefined()
  expect(later).not.toBe(first)
  await band.unmount()
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
