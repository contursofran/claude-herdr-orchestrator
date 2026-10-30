import { expect } from 'claude-code/testing'
import { appModDraws } from '../hooks/appmod'
import { BAND, settled, start, stopAll, test } from './harness'

// The Herdr app mod's heartbeat (~/.herdr-agents/app-mod.json): the band steps aside while it is fresh and lists this
// session's terminal (HC_TERMINAL_ID, t1 here), and PR polling goes on without the sidebar.

const FILE = '/home/t/.herdr-agents/app-mod.json'
const PANE = { plugin: 'herdr-agents', component: 'Pane', requestId: 'hrd-side', props: { bodyColumns: 80, bodyRows: 30 } } as const

const beat = (at: number, terminals: unknown = ['t1']) => JSON.stringify({ at, terminals })
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
  // Gone with close().
  files[FILE] = beat(clock.now())
  expect(await hidden(band)).toBe(true)
  delete files[FILE]
  expect(await hidden(band)).toBe(false)
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

test('PR checks are polled while the app mod draws the boards, with no sidebar', async ($, on) => {
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = (await ui.find({ key: 'task-acme/app-client#12' }))?.text ?? ''
  expect(row).toMatch(/#12 +hotbar keys +· +✓ +· +◐/)
  await ui.unmount()
  await stopAll($, clock, ['w-done'])
})
