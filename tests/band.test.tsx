import { expect } from 'claude-code/testing'
import { BATCH_MS } from '../hooks/defaults'
import { BAND, row, spawn, start, stopAll, test } from './harness'

// The band above the prompt: what pin_for_owner pins at the top, the workers, and #123 links.
// Run with `claude plugin test .`.

test('a tick reads the settings file twice at most: for the state file and for the band', async ($, on) => {
  const { clock, reads } = await start($, on)
  await spawn($, ['w-busy'])
  await clock.advance(3000)
  const settings = () => reads.filter(path => path.endsWith('/.claude/herdr-agents.json')).length
  const before = settings()
  await clock.advance(10 * 3000)
  expect(settings() - before).toBeGreaterThan(0)
  expect(settings() - before).toBeLessThanOrEqual(10 * 2)
  await stopAll($, clock, ['w-busy'])
})

test('a pinned to-do shows at the top, and Done unpins it and tells the coordinator', async ($, on) => {
  const { clock, submitted } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge client #565', from: 'app-client#541' })
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Staging disk at 98 GB free', kind: 'know' })
  // The same text again keeps its id.
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge client #565' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // The #numbers link once the start-up refresh, which runs in the background, has learned /repo's
  // GitHub remote. A Link's found text is its href, then what it draws: the line as drawn leaves the hrefs out.
  const line = async (text: RegExp) =>
    (await ui.find({ type: 'Text', text }))?.text.replace(/https:\/\/github\.com\/[^#]+?\/issues\/\d+/g, '')
  expect(await line(/Merge client/)).toMatch(/☐ Merge client #565\s+T1 · app-client#541/)
  expect(await line(/98 GB/)).toMatch(/ℹ Staging disk at 98 GB free\s+T2 · coordinator/)
  expect(await ui.find({ type: 'Text', text: /T3/ })).toBeUndefined()

  await ui.press({ key: 'tick-t1' })
  expect(await ui.find({ type: 'Text', text: /Merge client/ })).toBeUndefined()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/<herdr-owner-done id="T1" from="app-client#541">\nThe owner ticked off: Merge client #565/)
  expect(submitted.at(-1)).not.toContain('state file')

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
  // A blocked worker has reported, but it waits for someone, so it still counts; the header names the roles.
  expect((await ui.find({ type: 'Text', text: /workers/ }))?.text).toBe('3/4 workers: 3 reviewers')
  for (const name of names) expect(await row(ui, name)).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Blocked/ }))?.text).toMatch(/^● w-stuck +reviewer +\S+ +Blocked · answer it in its tab$/)
  // Two lines: the blocked one and the working one first, then the one that is done.
  expect((await ui.find({ key: 'col0' }))?.text).toMatch(/^● w-stuck .*Blocked · answer it in its tab● w-busy .*Working$/)
  expect((await ui.find({ key: 'col1' }))?.text).toMatch(/^● w-done .*Done · report pending$/)
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
  'the band reads worker states from the waits and the sweep, under 3 hc calls per worker-minute',
  { timeoutMs: 20_000 },
  async ($, on) => {
    const { clock, calls, emit } = await start($, on)
    const names = ['w-a', 'w-b', 'w-c']
    await spawn($, names)
    for (const name of names) await emit(name, 'working')
    calls.length = 0
    await clock.advance(10 * 60_000)
    // No `hc get` per worker: one `hc ls` a minute is all the hc calls there are.
    expect(calls.filter(c => c[1] === 'get')).toEqual([])
    expect(calls.length / (names.length * 10)).toBeLessThan(3)
    // Exactly the sweep's list each minute: the 3 s ticks, the band and the report check add no call.
    expect(calls.map(c => c.join(' '))).toEqual(Array(10).fill('hc ls --json --label herdr-agents.role=worker'))

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
  // hc is down for the next minute: the sweep's list and every `hc get` fail. The band keeps
  // the state it last saw, and no failed call shows the worker gone.
  fail.list = 100
  // Only for the undone-change check: an hc get per row would turn these failed gets into Tab gone.
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

test('a status a wait or the sweep sees reaches the band row, with no hc get', async ($, on) => {
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
  // Set without emit, so no wait ends on it: the sweep sees it a minute on and reports the worker blocked: the row reads Blocked, not Reported.
  status['w-x'] = 'blocked'
  await clock.advance(60_000)
  expect(await band()).toMatch(/^● w-x +reviewer +\S+ +Blocked · answer it in its tab$/)
  expect(calls.filter(c => c[1] === 'get')).toEqual([])
  await stopAll($, clock, ['w-x'])
})

test('a starting worker shows as starting until its terminal is made', async ($, on) => {
  const { clock, gate, emit } = await start($, on)
  const release = gate(argv => argv[0] === 'hc' && argv[1] === 'run')
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-x', profile: 'builder', cwd: '/repo-w-x', task: 'x' })
  await clock.settle()
  await clock.advance(3000)
  const band = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const text = (await ui.find({ key: 'col0' }))?.text ?? ''
    await ui.unmount()
    return text
  }
  expect(await band()).toMatch(/^● w-x +builder +\S+ +starting$/)
  release()
  await clock.settle()
  await emit('w-x', 'working')
  await clock.advance(3000)
  expect(await band()).toMatch(/^● w-x +builder +\S+ +Working$/)
  await stopAll($, clock, ['w-x'])
})

// The version is read once per mod folder and kept, so the unreadable case runs before the readable one.
test("the band shows no version when the mod's plugin.json cannot be read", async ($, on) => {
  await start($, on)
  await spawn($, ['w-busy'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^v\d/ })).toBeUndefined()
  expect(await row(ui, 'w-busy')).toBeDefined()
  await ui.unmount()
})

test('the band ends its top row with the mod version, dim, after the context size', async ($, on) => {
  const { recorded } = await start($, on)
  recorded.modPlugin = JSON.stringify({ name: 'herdr-agents', version: '0.14.0' })
  await spawn($, ['w-busy'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^v\d/ }))?.text).toBe('v0.14.0')
  expect(await row(ui, 'w-busy')).toBeDefined()
  await ui.unmount()
})

// A worker that reports with `status: blocked` in its header (a real RESULT.md), as the band and the state file show it.
async function blockedReport($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
  const h = await start($, on)
  const { clock, files, emit, typed } = h
  files['/repo/COORDINATOR-STATE.md'] = '# S\n'
  await spawn($, ['w-a'])
  await emit('w-a', 'working')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] =
    `<!-- report ${token} -->\n\`\`\`report\nstatus: blocked\nsummary: needs an answer\n\`\`\`\nWhich branch?`
  await clock.advance(12_000)
  await emit('w-a', 'done')
  await clock.advance(3000)
  const band = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const text = (await ui.find({ key: 'col0' }))?.text ?? ''
    await ui.unmount()
    return text
  }
  return { ...h, band, token }
}

test('a report with status: blocked shows Blocked, and a message to the worker ends it', async ($, on) => {
  const { band, clock } = await blockedReport($, on)
  expect(await band()).toMatch(/^● w-a +reviewer +\S+ +Blocked · answer it in its tab$/)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'Use main.' })
  await clock.advance(3000)
  expect(await band()).not.toMatch(/Blocked/)
})

test('a blocked report delivered early stays Blocked while its turn finishes', async ($, on) => {
  const { clock, files, emit, typed } = await start($, on)
  files['/repo/COORDINATOR-STATE.md'] = '# S\n'
  await spawn($, ['w-a'])
  await emit('w-a', 'working')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] =
    `<!-- report ${token} -->\n\`\`\`report\nstatus: blocked\nsummary: needs an answer\n\`\`\`\nWhich branch?`
  // Delivered early: the worker still works, finishing its last message.
  await clock.advance(12_000)
  const band = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const text = (await ui.find({ key: 'col0' }))?.text ?? ''
    await ui.unmount()
    return text
  }
  expect(await band()).toMatch(/Blocked/)
  // A sweep sees it working: that is its report's turn, not an answer.
  await clock.advance(60_000)
  expect(await band()).toMatch(/Blocked/)
  await emit('w-a', 'done')
  await clock.advance(3000)
  expect(await band()).toMatch(/Blocked/)
})

test('stopping a worker whose report said blocked ends Blocked and keeps its report line', async ($, on) => {
  const { band, clock, files } = await blockedReport($, on)
  await clock.advance(3000)
  expect(await band()).toMatch(/Blocked/)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-a' })
  await clock.advance(3000)
  expect(await band()).not.toMatch(/Blocked/)
  expect(files['/repo/COORDINATOR-STATE.md']).toMatch(/w-a \(reviewer\) done: \S*RESULT-\S+\.md\n/)
})

test('a worker blocked after its early report leaves Blocked once it works again', async ($, on) => {
  const { clock, files, emit, typed } = await start($, on)
  await spawn($, ['w-a'])
  await emit('w-a', 'working')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${token} -->\nDone, but one question.`
  // The report is delivered while the worker still works (its turn has not ended).
  await clock.advance(12_000)
  const band = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const text = (await ui.find({ key: 'col0' }))?.text ?? ''
    await ui.unmount()
    return text
  }
  expect(await band()).toMatch(/Reported/)
  // Its turn goes on and stops at an approval.
  await emit('w-a', 'blocked')
  await clock.advance(3000)
  expect(await band()).toMatch(/Blocked/)
  // The owner answers in its tab: it works again, and the label goes without any message.
  // Nothing waits on it by now, so the sweep, a minute on, sees it work.
  await emit('w-a', 'working')
  await clock.advance(60_000)
  expect(await band()).not.toMatch(/Blocked/)
})

test('a worker blocked with no report leaves Blocked when it is stopped', async ($, on) => {
  const { clock, emit } = await start($, on)
  await spawn($, ['w-a'])
  await emit('w-a', 'blocked')
  await clock.advance(3000)
  const band = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const text = (await ui.find({ key: 'col0' }))?.text ?? ''
    await ui.unmount()
    return text
  }
  expect(await band()).toMatch(/Blocked/)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-a' })
  await clock.advance(3000)
  expect(await band()).not.toMatch(/Blocked/)
})

test('a Markdown edit draws no row, unless it failed, was cut off or the view shows everything', async ($, on) => {
  await start($, on)
  const use = (tool: string, file_path: string, more = {}) =>
    $.ui.mount({
      plugin: 'herdr-agents',
      component: 'ToolUse',
      surface: 'terminal',
      props: { tool_use_id: 'x', tool, input: { file_path }, isRunning: false, isErrored: false, isInterrupted: false, ...more },
    })
  const result = (tool: string, filePath: string, more = {}) =>
    $.ui.mount({
      plugin: 'herdr-agents',
      component: 'ToolResult',
      surface: 'terminal',
      props: { tool_use_id: 'x', tool, output: { filePath }, isErrored: false, ...more },
    })
  const drawn = async (mounted: ReturnType<typeof use> | ReturnType<typeof result>) => {
    const ui = await mounted
    const found = await ui.find({ type: 'Text', text: /engine band/ })
    await ui.unmount()
    return found !== undefined
  }

  for (const [tool, path] of [
    ['Edit', '/repo/COORDINATOR-STATE.md'],
    ['Write', '/repo/docs/NOTES.MD'],
    ['Edit', '/repo/a.markdown'],
  ]) {
    expect(await drawn(use(tool!, path!))).toBe(false)
    expect(await drawn(result(tool!, path!))).toBe(false)
  }

  // Other files and other tools are drawn as ever.
  expect(await drawn(use('Edit', '/repo/hooks/band.tsx'))).toBe(true)
  expect(await drawn(result('Write', '/repo/hooks/md'))).toBe(true)
  expect(await drawn(use('Read', '/repo/README.md'))).toBe(true)

  // What the owner still has to see.
  expect(await drawn(use('Edit', '/repo/a.md', { isErrored: true }))).toBe(true)
  expect(await drawn(use('Edit', '/repo/a.md', { isInterrupted: true }))).toBe(true)
  expect(await drawn(use('Edit', '/repo/a.md', { isExpanded: true }))).toBe(true)
  expect(await drawn(result('Edit', '/repo/a.md', { isErrored: true }))).toBe(true)
  expect(await drawn(result('Edit', '/repo/a.md', { isExpanded: true }))).toBe(true)
})
