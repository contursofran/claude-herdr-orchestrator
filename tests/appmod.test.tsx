import { expect } from 'claude-code/testing'
import { appModDraws } from '../hooks/appmod'
import { BAND, settled, start, stopAll, test } from './harness'

// The Herdr app mod's heartbeat (~/.herdr-agents/app-mod.json): the band steps aside while it is fresh and lists this
// session's terminal (HC_TERMINAL_ID, t1 here), and PR polling goes on.

const FILE = '/home/t/.herdr-agents/app-mod.json'
const BOARD = '/home/t/.herdr-agents/board/session-1234.json'

const beat = (at: number, terminals: unknown = ['t1'], core?: string) => JSON.stringify({ at, terminals, ...(core ? { core } : {}) })
const hidden = async (band: { redraw: () => Promise<unknown>; find: (q: object) => Promise<unknown> }) => {
  await band.redraw()
  // The band draws the pinned to-do; stepping aside leaves the engine's own band.
  return (await band.find({ type: 'Text', text: /Merge server/ })) === undefined
}

test('a fresh heartbeat that lists this terminal hides the band, and every other case keeps it', async ($, on) => {
  const { clock, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge server #77' })
  await clock.advance(3000)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const now = clock.now()

  // No file: the band stays.
  expect(await hidden(band)).toBe(false)
  // Fresh and listed: it steps aside.
  files[FILE] = beat(now)
  expect(await hidden(band)).toBe(true)
  // Listed with other machines' addresses around it: still this terminal's.
  files[FILE] = beat(now, ['m/t1', 't1'])
  expect(await hidden(band)).toBe(true)
  // Not listed (another terminal, another machine's t1).
  files[FILE] = beat(now, ['t2', 'm/t1'])
  expect(await hidden(band)).toBe(false)
  files[FILE] = beat(now, [])
  expect(await hidden(band)).toBe(false)
  // Corrupt, or the wrong shape.
  files[FILE] = '{"at": 12'
  expect(await hidden(band)).toBe(false)
  files[FILE] = JSON.stringify({ terminals: ['t1'] })
  expect(await hidden(band)).toBe(false)
  files[FILE] = beat(now, 't1')
  expect(await hidden(band)).toBe(false)
  // Stale: the mod crashed or the layout was switched, and the band returns within 90 s.
  files[FILE] = beat(now)
  expect(await hidden(band)).toBe(true)
  await clock.advance(89_000)
  expect(await hidden(band)).toBe(true)
  await clock.advance(2_000)
  expect(await hidden(band)).toBe(false)
  await band.unmount()
})

// No band.redraw() below: the coordinator's own timer has to bring the band back (an idle session redraws nothing else).
test('the band returns by itself once the heartbeat stops, and once the file is deleted', async ($, on) => {
  const { clock, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge server #77' })
  await clock.advance(3000)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const shows = async () => (await band.find({ type: 'Text', text: /Merge server/ })) !== undefined
  expect(await shows()).toBe(true)

  // The app mod starts drawing: the band steps aside at the next tick.
  files[FILE] = beat(clock.now())
  await clock.advance(3000)
  expect(await shows()).toBe(false)
  // It crashes: no more beats, and the band is back once the file is 90 s old.
  await clock.advance(60_000)
  expect(await shows()).toBe(false)
  await clock.advance(33_000)
  expect(await shows()).toBe(true)

  // It comes back, then closes (a switch to main removes the file).
  files[FILE] = beat(clock.now())
  await clock.advance(3000)
  expect(await shows()).toBe(false)
  delete files[FILE]
  await clock.advance(3000)
  expect(await shows()).toBe(true)
  await band.unmount()
})

// What the mod writes while a part fails to draw (app/test/start.test.mjs): the same file with no terminals.
test('a heartbeat that stops listing this terminal brings the band back by itself, and listing it again hides it', async ($, on) => {
  const { clock, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge server #77' })
  await clock.advance(3000)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const shows = async () => (await band.find({ type: 'Text', text: /Merge server/ })) !== undefined
  files[FILE] = beat(clock.now())
  await clock.advance(3000)
  expect(await shows()).toBe(false)
  files[FILE] = beat(clock.now(), [])
  await clock.advance(3000)
  expect(await shows()).toBe(true)
  files[FILE] = beat(clock.now())
  await clock.advance(3000)
  expect(await shows()).toBe(false)
  await band.unmount()
})

test('a heartbeat of another hc core does not hide the band; one with no core, or the same core, does', async ($, on) => {
  const { clock, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge server #77' })
  await clock.advance(3000)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await hidden(band)).toBe(false)
  files[FILE] = beat(clock.now(), ['t1'], 'core-B')
  expect(await hidden(band)).toBe(false)
  files[FILE] = beat(clock.now(), ['t1'], 'core-A')
  expect(await hidden(band)).toBe(true)
  // An older mod writes no core: matched on the terminal alone.
  files[FILE] = beat(clock.now())
  expect(await hidden(band)).toBe(true)
  await band.unmount()
})

test('a session outside an hc terminal keeps its band whatever the file says', async ($, on) => {
  const { clock, files } = await start($, on, {}, {}, { HC_TERMINAL_ID: '' })
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge server #77' })
  await clock.advance(3000)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  files[FILE] = beat(clock.now(), ['', 't1'])
  expect(await hidden(band)).toBe(false)
  await band.unmount()
})

test('appModDraws: fresh and listed only, and not from a clock far ahead', () => {
  expect(appModDraws(beat(1000), 't1', 1000 + 89_999)).toBe(true)
  expect(appModDraws(beat(1000), 't1', 1000 + 90_000)).toBe(false)
  expect(appModDraws(beat(1000 + 90_000), 't1', 1000)).toBe(false)
  expect(appModDraws(beat(1000), '', 1000)).toBe(false)
  expect(appModDraws('', 't1', 1000)).toBe(false)
})

test('PR checks are polled while the app mod draws the boards', async ($, on) => {
  const { clock, typed, files, prs } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'w-done',
    profile: 'builder',
    cwd: '/repo/wt',
    task: '# Build #12: hotbar keys',
  })
  await settled()
  await clock.settle()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-done/RESULT.md'] =
    `<!-- report ${token} -->\nOpened https://github.com/acme/app-client/pull/15. Tests pass.`
  await clock.advance(3000)
  prs['acme/app-client#15'] = { state: 'OPEN', statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }] }
  files[FILE] = beat(clock.now())
  // The 2-minute tick polls; the heartbeat is refreshed as the mod does every 30 s.
  for (let i = 0; i < 5; i++) {
    await clock.advance(30_000)
    files[FILE] = beat(clock.now())
  }
  const row = (JSON.parse(files[BOARD]!).tasks as { key: string; stages: string[] }[]).find(t => t.key === 'acme/app-client#12')
  expect(row?.stages.slice(0, 4)).toEqual(['none', 'done', 'none', 'run'])
  await stopAll($, clock, ['w-done'])
})

test('a merged PR gets its merge time from the same gh call, and is not asked again once it has one', async ($, on) => {
  const { clock, typed, files, prs, shell } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'w-done',
    profile: 'builder',
    cwd: '/repo/wt',
    task: '# Build #12: hotbar keys',
  })
  await settled()
  await clock.settle()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-done/RESULT.md'] =
    `<!-- report ${token} -->\nOpened https://github.com/acme/app-client/pull/15. Tests pass.`
  await clock.advance(3000)
  const task = () => (JSON.parse(files[BOARD]!).tasks as { key: string; pr?: number; isMerged: boolean; mergedAt?: number | null }[])[0]!
  const asked = () => shell.filter(c => c.startsWith('gh pr view 15')).length
  const tick = async () => {
    for (let i = 0; i < 5; i++) {
      await clock.advance(30_000)
      files[FILE] = beat(clock.now())
    }
  }
  files[FILE] = beat(clock.now())
  prs['acme/app-client#15'] = { state: 'OPEN', statusCheckRollup: [] }
  await tick()
  expect(task()).toMatchObject({ pr: 15, isMerged: false, mergedAt: null })
  expect(shell.find(c => c.startsWith('gh pr view 15'))).toContain('state,mergedAt,statusCheckRollup')

  // It merges: the one gh call brings the time, as ms, to the board.
  prs['acme/app-client#15'] = { state: 'MERGED', mergedAt: '2026-10-30T20:00:00Z', statusCheckRollup: [] }
  await tick()
  expect(task()).toMatchObject({ isMerged: true, mergedAt: Date.parse('2026-10-30T20:00:00Z') })
  const after = asked()
  await tick()
  await tick()
  expect(asked(), 'a merged PR with its time is not asked about again').toBe(after)
  await stopAll($, clock, ['w-done'])
})

test('a merged PR already stored with no merge time is asked once to fill it, then left alone', async ($, on) => {
  // State kept before `mergedAt` existed: the stored merged PR reads back without it (while `old` is set).
  let old = false
  on('state.get', async (_, e, next) => {
    const read = await next(e)
    const value = read.value?.value as { prs?: Record<string, { mergedAt?: unknown }> } | undefined
    if (!old || e.key !== 'boardState' || !value?.prs) return read
    const prs = Object.fromEntries(Object.entries(value.prs).map(([k, { mergedAt: _, ...rest }]) => [k, rest]))
    return { value: { value: { ...value, prs }, version: read.value!.version } }
  })
  const { clock, typed, files, prs, shell } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'w-done',
    profile: 'builder',
    cwd: '/repo/wt',
    task: '# Build #12: hotbar keys',
  })
  await settled()
  await clock.settle()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-done/RESULT.md'] =
    `<!-- report ${token} -->\nOpened https://github.com/acme/app-client/pull/15. Tests pass.`
  await clock.advance(3000)
  const asked = () => shell.filter(c => c.startsWith('gh pr view 15')).length
  const tick = async () => {
    for (let i = 0; i < 5; i++) {
      await clock.advance(30_000)
      files[FILE] = beat(clock.now())
    }
  }
  files[FILE] = beat(clock.now())
  prs['acme/app-client#15'] = { state: 'OPEN', statusCheckRollup: [] }
  await tick()
  // It is stored as merged, without its time.
  old = true
  prs['acme/app-client#15'] = { state: 'MERGED', statusCheckRollup: [] }
  await tick()
  const stored = asked()
  // gh now has the time: the stored PR is asked once more, and the time reaches the board.
  prs['acme/app-client#15'] = { state: 'MERGED', mergedAt: '2026-10-30T20:00:00Z', statusCheckRollup: [] }
  await tick()
  expect(asked(), 'a stored merged PR with no time is asked again').toBeGreaterThan(stored)
  old = false
  await tick()
  const filled = asked()
  expect(JSON.parse(files[BOARD]!).tasks[0]).toMatchObject({ isMerged: true, mergedAt: Date.parse('2026-10-30T20:00:00Z') })
  await tick()
  await tick()
  expect(asked(), 'once filled it is not asked again').toBe(filled)
  await stopAll($, clock, ['w-done'])
})

test('a merged PR with no merge time is asked once more and then left alone, even if gh gives none', async ($, on) => {
  const { clock, typed, files, prs, shell } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'w-done',
    profile: 'builder',
    cwd: '/repo/wt',
    task: '# Build #12: hotbar keys',
  })
  await settled()
  await clock.settle()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-done/RESULT.md'] =
    `<!-- report ${token} -->\nOpened https://github.com/acme/app-client/pull/15. Tests pass.`
  await clock.advance(3000)
  const asked = () => shell.filter(c => c.startsWith('gh pr view 15')).length
  const tick = async () => {
    for (let i = 0; i < 5; i++) {
      await clock.advance(30_000)
      files[FILE] = beat(clock.now())
    }
  }
  files[FILE] = beat(clock.now())
  prs['acme/app-client#15'] = { state: 'MERGED', statusCheckRollup: [] } // gh says merged and no time
  await tick()
  const after = asked()
  expect(after).toBeGreaterThan(0)
  await tick()
  await tick()
  expect(asked()).toBe(after)
  expect(JSON.parse(files[BOARD]!).tasks[0]).toMatchObject({ isMerged: true, mergedAt: null })
  await stopAll($, clock, ['w-done'])
})
