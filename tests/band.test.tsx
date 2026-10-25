import { expect, test } from 'claude-code/testing'
import { BATCH_MS } from '../hooks/defaults'
import { BAND, row, spawn, start, stopAll } from './harness'

// The band above the prompt: what pin_for_owner pins at the top, the workers, and #123 links.
// Run with `claude plugin test .`.

test('a pinned to-do shows at the top, and Done unpins it and tells the coordinator', async ($, on) => {
  const { clock, submitted } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge client #565', from: 'app-client#541' })
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Staging disk at 98 GB free', kind: 'know' })
  // The same text again keeps its id.
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge client #565' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Merge client #565/ }))?.text).toMatch(/☐ Merge client #565\s+T1 · app-client#541/)
  expect((await ui.find({ type: 'Text', text: /98 GB/ }))?.text).toMatch(/ℹ Staging disk at 98 GB free\s+T2 · coordinator/)
  expect(await ui.find({ type: 'Text', text: /T3/ })).toBeUndefined()

  await ui.press({ key: 'tick-t1' })
  expect(await ui.find({ type: 'Text', text: /Merge client #565/ })).toBeUndefined()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/<herdr-owner-done id="T1" from="app-client#541">\nThe owner ticked off: Merge client #565/)

  // A news item is dismissed without a prompt.
  const before = submitted.length
  await ui.press({ key: 'tick-t2' })
  expect(submitted.length).toBe(before)
  await ui.unmount()
})

test('unpin_for_owner removes items by id and names the ones it did not find', async ($, on) => {
  await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Test #526 at http://localhost:5173' })
  const out = await $.tool.call({ tool: 'mcp__herdr-agents__unpin_for_owner', ids: ['T1', 'T9'] })
  expect(JSON.stringify(out)).toMatch(/Unpinned 1\. Not pinned \(already done or wrong id\): T9\. 0 item/)
  // Nothing left to show: the mod passes and the engine draws its own.
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await ui.unmount()
})

test('workers show one per row, two per line, the one that needs the person first', async ($, on) => {
  const { clock } = await start($, on)
  const names = ['w-busy', 'w-done', 'w-stuck']
  await spawn($, names)
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // A blocked worker is reported at once, so it no longer counts as running; the header names the roles.
  expect((await ui.find({ type: 'Text', text: /workers/ }))?.text).toBe('2/4 workers: 2 reviewers')
  for (const name of names) expect(await row(ui, name)).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Reported/ }))?.text).toMatch(/^● w-stuck +reviewer +\S+ +Reported$/)
  // Two lines: the working one first, then the one that is done, on the left; the reported one on the right.
  expect((await ui.find({ key: 'col0' }))?.text).toMatch(/^● w-busy .*Working● w-done .*Done · report pending$/)
  expect((await ui.find({ key: 'col1' }))?.text).toMatch(/^● w-stuck .*Reported$/)
  // Few workers: all show, and Details has nothing more.
  expect((await ui.find({ key: 'workers' }))?.text).toBe('Details')
  await ui.unmount()
  await stopAll($, clock, names)
})

test('compact shows the first two lines of workers; Details shows them all', async ($, on) => {
  const { clock } = await start($, on)
  const names = Array.from({ length: 10 }, (_, i) => `w${String(i).padStart(2, '0')}`)
  await spawn($, names)
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await row(ui, 'w03')).toBeDefined()
  expect(await row(ui, 'w04')).toBeUndefined()
  expect((await ui.find({ key: 'workers' }))?.text).toBe('Details +6')

  await ui.press({ key: 'workers' })
  for (const name of names) expect(await row(ui, name)).toBeDefined()
  expect((await ui.find({ key: 'workers' }))?.text).toBe('Compact')
  await ui.press({ key: 'workers' })
  expect(await row(ui, 'w04')).toBeUndefined()
  await ui.unmount()
  await stopAll($, clock, names)
})

test('a #123 links to the issue or PR of the repo named before it', async ($, on) => {
  const { clock } = await start($, on)
  await spawn($, ['b-srv'], '/srv')
  await clock.advance(3000)
  await $.tool.call({
    tool: 'mcp__herdr-agents__pin_for_owner',
    text: 'Merge client #565 and #566, then server #12 and web #4; see acme/other#3 and PR #9',
  })
  // A bare #7 from a worker takes the worker's repo.
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Test #7', from: 'b-srv' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // A Link's found text is its href, then what it draws.
  const hrefs = (await ui.findAll({ type: 'Link' })).map(l => `${String(l.text).replace(String(l.props.href), '')} ${l.props.href}`)
  expect(hrefs).toEqual([
    '#565 https://github.com/acme/app-client/issues/565',
    '#566 https://github.com/acme/app-client/issues/566',
    '#12 https://github.com/acme/app-server/issues/12',
    '#4 https://github.com/acme/website/issues/4',
    '#3 https://github.com/acme/other/issues/3',
    '#9 https://github.com/acme/other/issues/9',
    '#7 https://github.com/acme/app-server/issues/7',
  ])
  // The line reads as written; only the #numbers are links.
  expect((await ui.find({ type: 'Text', text: /^Merge client/ }))?.text.replace(/https:\/\/github\.com\/[^#]+?\/issues\/\d+/g, '')).toBe(
    'Merge client #565 and #566, then server #12 and web #4; see acme/other#3 and PR #9',
  )
  await ui.unmount()
  await stopAll($, clock, ['b-srv'])
})

// It runs 10 minutes of ticks and sweeps, which a busy CI runner can take most of the default 5 s over.
test(
  'the band reads worker states from the waits and the sweep, under 3 herdr calls per worker-minute',
  { timeoutMs: 20_000 },
  async ($, on) => {
    const { clock, calls, emit } = await start($, on)
    const names = ['w-a', 'w-b', 'w-c']
    await spawn($, names)
    for (const name of names) await emit(name, 'working')
    calls.length = 0
    await clock.advance(10 * 60_000)
    // No `agent get` per worker any more: one `agent list` a minute is all the herdr calls there are.
    expect(calls.filter(c => c[2] === 'get')).toEqual([])
    expect(calls.length / (names.length * 10)).toBeLessThan(3)
    // Exactly the sweep's list each minute: the 3 s ticks, the band and the report check add no call.
    expect(calls.map(c => c.join(' '))).toEqual(Array(10).fill('herdr agent list'))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const shown = [(await ui.find({ key: 'col0' }))?.text, (await ui.find({ key: 'col1' }))?.text].join('\n')
    for (const name of names) expect(shown).toMatch(new RegExp(`${name} +reviewer +\\S+ +Working`))
    await ui.unmount()
    await stopAll($, clock, names)
  },
)

test("one failed sweep keeps the band's last state", async ($, on) => {
  const { clock, fail } = await start($, on)
  await spawn($, ['w-busy'])
  await clock.advance(60_000)
  // herdr is down for the next minute: the sweep's list and every `agent get` fail. The band keeps
  // the state it last saw, and no failed call shows the worker gone.
  fail.list = 100
  // Only for the undone-change check: an agent get per row would turn these failed gets into Tab gone.
  fail.get = 100
  await clock.advance(60_000)
  fail.list = 0
  fail.get = 0
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'col0' }))?.text).toMatch(/^● w-busy +reviewer +\S+ +Working$/)
  expect(await ui.find({ type: 'Text', text: /Tab gone/ })).toBeUndefined()
  await ui.unmount()
  await stopAll($, clock, ['w-busy'])
})

test('a status a wait or the sweep sees reaches the band row, with no agent get', async ($, on) => {
  const { clock, calls, emit, status } = await start($, on)
  await spawn($, ['w-x'])
  await emit('w-x', 'working')
  calls.length = 0
  // Mounts the band afresh and returns its first column, where the one worker's row is.
  const band = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const text = (await ui.find({ key: 'col0' }))?.text ?? ''
    await ui.unmount()
    return text
  }
  await clock.advance(3000)
  expect(await band()).toMatch(/^● w-x +reviewer +\S+ +Working$/)
  // A wait ends on 'done' before any report: the band shows it at its next tick.
  await emit('w-x', 'done')
  await clock.advance(3000)
  expect(await band()).toMatch(/^● w-x +reviewer +\S+ +Done · report pending$/)
  // Set without emit, so no wait ends on it: the sweep sees it a minute on, reports the worker blocked, and the row reads Reported.
  status['w-x'] = 'blocked'
  await clock.advance(60_000)
  expect(await band()).toMatch(/^● w-x +reviewer +\S+ +Reported$/)
  expect(calls.filter(c => c[2] === 'get')).toEqual([])
  await stopAll($, clock, ['w-x'])
})
