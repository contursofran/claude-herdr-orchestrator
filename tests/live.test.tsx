import { expect } from 'claude-code/testing'
import { commandLabel, liveFields } from '../hooks/live'
import { LIVE_COMMAND_MS, LIVE_SAVE_MS } from '../hooks/defaults'
import { W, turnEnd } from './workerkit'
import { spawn, start, stopAll, test, until } from './harness'

// What a row says an agent is doing (#277): a worker records it to a file, its coordinator puts that on the board.

const BOARD = '/home/t/.herdr-agents/board/session-1234.json'
const LIVE = `${W}/LIVE.json`
const IN_WORKER = { HERDR_AGENTS_ROLE: 'worker', HERDR_AGENTS_LIVE: LIVE }

test('commandLabel names the step that does the work, up to its first flag', () => {
  expect(commandLabel('npm test')).toBe('npm test')
  expect(commandLabel('cd /repo && FOO=secret npm test -- --watch | tail -5')).toBe('npm test')
  expect(commandLabel('git push --force origin main')).toBe('git push')
  expect(commandLabel('curl https://x.test/a?token=abc')).toBe('curl')
  expect(commandLabel('cat <<EOF\nsecret\nEOF')).toBe('cat <<EOF')
  expect(commandLabel('git commit -m "a; b"')).toBe('git commit')
  expect(commandLabel('cd /repo')).toBe('cd /repo')
  expect(commandLabel('')).toBe('')
})

test('liveFields: nothing after the turn, a tool only once it has run a while, the output time rounded up to the minute', () => {
  const live = { inTurn: true, outputAt: 61_000, command: 'npm test', commandAt: 100_000 }
  expect(liveFields({ ...live, inTurn: false }, 200_000)).toEqual({})
  expect(liveFields(null, 200_000)).toEqual({})
  expect(liveFields(live, 100_000 + LIVE_COMMAND_MS - 1)).toEqual({ outputAt: 120_000 })
  expect(liveFields(live, 100_000 + LIVE_COMMAND_MS)).toEqual({ command: 'npm test', commandAt: 100_000, outputAt: 120_000 })
})

test('a worker records its turn and the tool it runs in its file', async ($, on) => {
  let finish = () => {}
  on('tool.call', { tool: 'Bash' }, () => new Promise(resolve => (finish = () => resolve({ result: { stdout: '' } } as never))) as never)
  const { clock, files } = await start($, on, {}, {}, IN_WORKER)
  const live = () => JSON.parse(files[LIVE] ?? '{}')
  await $.turn.start({ text: 'Go.', turnId: 't1' })
  expect(live()).toMatchObject({ inTurn: true, command: null })

  const call = $.tool.call({ tool: 'Bash', command: 'cd /repo && npm test' } as never)
  await until(clock, () => live().command === 'npm test')
  expect(live().command).toBe('npm test')
  const startedAt = live().commandAt
  await clock.advance(60_000)
  finish()
  await call
  await until(clock, () => live().command === null)
  expect(live().command).toBe(null)
  expect(live().outputAt).toBe(startedAt + 60_000)

  await $.turn.complete(turnEnd('t1'))
  expect(live().inTurn).toBe(false)
})

test('a stream counts as output, and its chunks pass through', async ($, on) => {
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', index: 0, text: 'hi' } as never
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [] } as never
  })
  const { clock, files } = await start($, on, {}, {}, IN_WORKER)
  const live = () => JSON.parse(files[LIVE] ?? '{}')
  await $.turn.start({ text: 'Go.', turnId: 't1' })
  const startedAt = live().outputAt
  await clock.advance(LIVE_SAVE_MS)
  const seen: string[] = []
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'haiku', messageCount: 1 } as never))
    seen.push((chunk as { kind: string }).kind)
  expect(seen).toEqual(['text'])
  await until(clock, () => live().outputAt > startedAt)
  expect(live().outputAt).toBe(startedAt + LIVE_SAVE_MS)
})

test("the board shows a working worker's file, and never a worker in any other state", async ($, on) => {
  const s = await start($, on)
  await spawn($, ['w-busy'], '/repo/wt')
  const onBoard = () => JSON.parse(s.files[BOARD] ?? '{}').workers?.find((w: { name: string }) => w.name === 'w-busy')
  const now = await s.clock.now()
  s.files[LIVE] = JSON.stringify({ inTurn: true, outputAt: now, command: 'npm test', commandAt: now - LIVE_COMMAND_MS })
  await s.clock.advance(3000)
  expect(onBoard().command).toBe('npm test')
  expect(onBoard().commandAt).toBe(now - LIVE_COMMAND_MS)
  expect(onBoard().outputAt).toBe(Math.ceil(now / 60_000) * 60_000)

  await s.emit('w-busy', 'blocked')
  await s.clock.advance(3000)
  expect(onBoard()?.command).toBe(undefined)
  await stopAll($, s.clock, ['w-busy'])
})

test("the coordinator's own turn goes on the board, and leaves it when the turn ends", async ($, on) => {
  const { clock, files } = await start($, on)
  const coordinator = () => JSON.parse(files[BOARD] ?? '{}').coordinator
  await $.turn.start({ text: 'Go.', turnId: 't1' })
  await clock.advance(3000)
  expect(Number.isFinite(coordinator().outputAt)).toBe(true)
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(3000)
  expect(coordinator().outputAt).toBe(undefined)
})

test('a worker records its context fill after each turn, with the window when it is known', async ($, on) => {
  on('session.measure', () => ({ changed: ['context'] }))
  const { clock, files } = await start($, on, {}, {}, IN_WORKER)
  await $.session.measure({ context: { tokens: 82_000, window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
  await until(clock, () => JSON.parse(files[LIVE] ?? '{}').context)
  expect(JSON.parse(files[LIVE] ?? '{}').context).toEqual({ tokens: 82_000, limit: 200_000 })
  // Kept when the next turn starts and ends.
  await $.turn.start({ text: 'Go.', turnId: 't1' })
  expect(JSON.parse(files[LIVE] ?? '{}').context).toEqual({ tokens: 82_000, limit: 200_000 })
})

test('a worker records no context when the window is not known', async ($, on) => {
  on('session.measure', () => ({ changed: ['context'] }))
  const { clock, files } = await start($, on, {}, {}, IN_WORKER)
  await $.session.measure({ context: { tokens: 82_000 }, rateLimits: [], changed: ['context'] } as never)
  await clock.advance(3000)
  expect(JSON.parse(files[LIVE] ?? '{}').context).toBe(undefined)
})

test('the coordinator counts its turn: start sets turnAt and zero tools, each tool adds one, the end clears them', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '' } }) as never)
  const { clock, files } = await start($, on, {}, {}, IN_WORKER)
  const live = () => JSON.parse(files[LIVE] ?? '{}')
  await $.turn.start({ text: 'Go.', turnId: 't1' })
  expect(live().turnAt).toBe(await clock.now())
  expect(live().tools).toBe(0)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pwd' } as never)
  await until(clock, () => live().tools === 2)
  expect(live().tools).toBe(2)
  await $.turn.complete(turnEnd('t1'))
  expect(live().turnAt).toBe(null)
  expect(live().tools).toBe(0)
})

test("only the coordinator's board row has the turn start (to the minute) and the tool count, not a worker's", async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '' } }) as never)
  const s = await start($, on)
  await spawn($, ['w-busy'], '/repo/wt')
  const board = () => JSON.parse(s.files[BOARD] ?? '{}')
  await $.turn.start({ text: 'Go.', turnId: 't1' })
  const startedAt = await s.clock.now()
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await s.clock.advance(3000)
  expect(board().coordinator.turnAt).toBe(Math.floor(startedAt / 60_000) * 60_000)
  expect(board().coordinator.tools).toBe(1)
  s.files[LIVE] = JSON.stringify({ inTurn: true, outputAt: startedAt, turnAt: startedAt, tools: 4, command: null, commandAt: null })
  await s.clock.advance(3000)
  const worker = board().workers.find((w: { name: string }) => w.name === 'w-busy')
  expect(worker.turnAt).toBe(undefined)
  expect(worker.tools).toBe(undefined)
  await $.turn.complete(turnEnd('t1'))
  await s.clock.advance(3000)
  expect(board().coordinator.turnAt).toBe(undefined)
  await stopAll($, s.clock, ['w-busy'])
})
