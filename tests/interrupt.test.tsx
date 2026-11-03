import { expect } from 'claude-code/testing'
import { BATCH_MS, QUIET_MS, SWEEP_MS } from '../hooks/defaults'
import { start, stopAll, test, until } from './harness'
import { W, codex, jobOf, spawnBusy } from './workerkit'

// The interrupt tool (#90): a worker's turn ends with its stop key, it keeps its context, and only the corrected turn's report counts.

const FILE = '/home/t/.herdr-agents/board/session-1234.json'
const INBOX = '/home/t/.herdr-agents/board/session-1234.actions'
const pressed = (calls: string[][]) => calls.filter(c => c[0] === 'hc' && c[1] === 'interrupt')
const interrupt = ($: Parameters<typeof start>[0], worker = 'w-busy') => $.tool.call({ tool: 'mcp__herdr-agents__interrupt', worker })
const tokenIn = (text?: string) => text?.match(/<!-- report (\S+) -->/)?.[1]
const lastToken = (typed: string[]) => [...typed].reverse().map(tokenIn).find(Boolean)

test('an interrupt, then a correction: only the corrected turn reports', async ($, on) => {
  const { clock, submitted, typed, files, calls, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  const first = tokenIn(typed[0])

  const out = JSON.stringify(await interrupt($))
  expect(out).toContain('Interrupted w-busy')
  expect(pressed(calls)).toHaveLength(1)
  await emit('w-busy', 'idle')
  await clock.advance(BATCH_MS + 3000)
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'running', interrupted: true })
  expect(submitted.filter(s => s.includes('<herdr-agent'))).toEqual([])

  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Use the other file.' })
  await clock.settle()
  const told = typed.at(-1) ?? ''
  expect(told).toContain('interrupted on purpose')
  expect(told).toContain('Use the other file.')
  const second = lastToken(typed)
  expect(second).not.toBe(first)
  expect(jobOf(store, 'w-busy').interrupted).toBeUndefined()

  // A report under the old token, however late, is not this turn's.
  files[`${W}/RESULT.md`] = `<!-- report ${first} -->\nThe old way.`
  await clock.advance(BATCH_MS + 6000)
  expect(submitted.join('\n')).not.toContain('The old way.')

  files[`${W}/RESULT.md`] = `<!-- report ${second} -->\nThe corrected way.`
  await clock.advance(BATCH_MS + 6000)
  expect(submitted.join('\n')).toContain('The corrected way.')
  await stopAll($, clock, ['w-busy'])
})

test('it presses nothing on a worker that is not mid-turn, and says why', async ($, on) => {
  const { clock, typed, files, calls, status } = await start($, on)
  expect(JSON.stringify(await interrupt($, 'w-none').catch(e => String(e)))).toContain('no worker w-none')
  await spawnBusy($, 'builder')

  for (const [word, says] of [
    ['idle', 'not mid-turn'],
    ['done', 'not mid-turn'],
    ['blocked', 'waits at a prompt'],
  ] as const) {
    status['w-busy'] = word
    expect(JSON.stringify(await interrupt($).catch(e => String(e)))).toContain(says)
  }
  status['w-busy'] = 'working'
  files[`${W}/RESULT.md`] = `<!-- report ${tokenIn(typed[0])} -->\nDone.`
  expect(JSON.stringify(await interrupt($).catch(e => String(e)))).toContain('already wrote its report')
  expect(pressed(calls)).toEqual([])
  await stopAll($, clock, ['w-busy'])
})

test('with no correction it is reported as interrupted, not as finished', async ($, on) => {
  const { clock, submitted, screens, emit } = await start($, on)
  await spawnBusy($, 'builder')
  await interrupt($)
  screens['w-busy'] = 'Interrupted · What should Claude do instead?'
  await emit('w-busy', 'idle')
  await clock.advance(QUIET_MS + 2 * SWEEP_MS + BATCH_MS)
  const said = submitted.join('\n')
  expect(said).toContain('it was interrupted and no correction came')
  expect(said).not.toContain('status="done"')
  await stopAll($, clock, ['w-busy'])
})

test('its wait ends with its turn, and messages held for that turn are named, not sent later', async ($, on) => {
  const { clock, files, store } = await start($, on, codex)
  await spawnBusy($, 'x')
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also this.' })
  files[`${W}/WAIT.json`] = '{"for":"ci","check":"ci","every":1,"max":60}'
  const out = JSON.stringify(await interrupt($))
  expect(out).toContain('1 message(s) held for it were dropped')
  expect(`${W}/WAIT.json` in files).toBe(false)
  expect(jobOf(store, 'w-busy').queued).toEqual([])
  await stopAll($, clock, ['w-busy'])
})

test('hc still reporting it working is said as such, and a correction still goes in', async ($, on) => {
  const { clock, typed, interruptOutcome } = await start($, on, codex)
  await spawnBusy($, 'x')
  interruptOutcome['w-busy'] = 'still_working'
  expect(JSON.stringify(await interrupt($))).toContain('still reports it (still_working)')
  const before = lastToken(typed)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Do this instead.' })
  await clock.settle()
  expect(typed.at(-1)).toContain('Do this instead.')
  expect(lastToken(typed)).not.toBe(before)
  await stopAll($, clock, ['w-busy'])
})

test('the owner typing in its tab ends the wait for a correction', async ($, on) => {
  const { clock, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  await interrupt($)
  await emit('w-busy', 'idle')
  await emit('w-busy', 'working')
  expect(jobOf(store, 'w-busy').interrupted).toBeUndefined()
  await stopAll($, clock, ['w-busy'])
})

test('Interrupt on the board presses it, tells the coordinator and shows the worker waiting', async ($, on) => {
  const { clock, submitted, files, calls, emit } = await start($, on)
  await spawnBusy($, 'builder')
  files[`${INBOX}/1-int.json`] = JSON.stringify({ action: 'interrupt', worker: 'w-busy' })
  files[`${INBOX}/2-int.json`] = JSON.stringify({ action: 'interrupt', worker: 'w-none' })
  const boardSays = () => JSON.parse(files[FILE] ?? '{}')
  await clock.advance(3000)
  await until(clock, () => boardSays().actions?.length === 2)
  await emit('w-busy', 'idle')
  await clock.advance(BATCH_MS + 6000)
  await until(clock, () => boardSays().workers?.[0]?.state === 'waiting')
  const board = boardSays()
  expect(board.actions).toEqual([
    { id: '1-int.json', ok: true, message: 'interrupted w-busy' },
    { id: '2-int.json', ok: false, message: 'no worker w-none' },
  ])
  expect(pressed(calls)).toHaveLength(1)
  expect(submitted.join('\n')).toContain('status="interrupted"')
  expect(submitted.join('\n')).toContain('The owner pressed Interrupt')
  expect(board.workers.find((w: { name: string }) => w.name === 'w-busy')).toMatchObject({
    state: 'waiting',
    note: 'a correction, after an interrupt',
  })
  await stopAll($, clock, ['w-busy'])
})
