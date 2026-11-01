import { expect } from 'claude-code/testing'
import { BATCH_MS } from '../hooks/defaults'
import { BAND, spawn, start, stopAll, test } from './harness'

// The one line above the prompt, what pin_for_owner keeps, and the worker states the board shows.
// Run with `claude plugin test .`.

const BOARD = '/home/t/.herdr-agents/board/session-1234.json'
const INBOX = '/home/t/.herdr-agents/board/session-1234.actions'
type Worker = { name: string; state: string; note: string | null; since: number | null }
const workersIn = (files: Record<string, string>) => JSON.parse(files[BOARD] ?? '{}').workers as Worker[]
const stateOf = (files: Record<string, string>, name: string) => workersIn(files)?.find(w => w.name === name)?.state

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

test('with nothing waiting the band draws nothing of its own, and one line once something waits', async ($, on) => {
  const { clock } = await start($, on)
  await spawn($, ['w-busy'])
  await clock.advance(3000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // Workers alone are no reason to draw: the mod passes and the engine draws its own.
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()

  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge client #565' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /waiting/ }))?.text).toBe('1 waiting (reply in chat): Merge client #565')

  // A question goes first, on its first line alone.
  await $.tool.call({
    tool: 'mcp__herdr-agents__ask_owner',
    question: 'Sort bags by type?\nThe client sorts by weight today.',
    from: 'w-busy',
  })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /waiting/ }))?.text).toBe('2 waiting (reply in chat): Sort bags by type?')
  await ui.unmount()

  // A survey keeps the space to itself.
  const survey = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' })
  expect(await survey.find({ type: 'Text', text: /waiting/ })).toBeUndefined()
  await survey.unmount()
  await stopAll($, clock, ['w-busy'])
})

test('the same to-do text keeps its id; done tells the coordinator, and news goes without a prompt', async ($, on) => {
  const { clock, submitted, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge client #565', from: 'app-client#541' })
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Staging disk at 98 GB free', kind: 'know' })
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge client #565' })
  await clock.advance(3000)
  const open = () => (JSON.parse(files[BOARD]!).needs as { key: string; isOpen: boolean }[]).filter(n => n.isOpen).map(n => n.key)
  expect(open()).toEqual(['T1', 'T2'])

  files[`${INBOX}/1.json`] = JSON.stringify({ action: 'done', key: 'T1' })
  await clock.advance(3000)
  expect(open()).toEqual(['T2'])
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/<herdr-owner-done id="T1" from="app-client#541">\nThe owner ticked off: Merge client/)
  expect(submitted.at(-1)).not.toContain('state file')

  const before = submitted.length
  files[`${INBOX}/2.json`] = JSON.stringify({ action: 'done', key: 'T2' })
  await clock.advance(3000 + BATCH_MS)
  expect(open()).toEqual([])
  expect(submitted.length).toBe(before)
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

test('worker states come from the waits and the sweep, under 3 hc calls per worker-minute', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, calls, emit, files } = await start($, on)
  const names = ['w-a', 'w-b', 'w-c']
  await spawn($, names)
  for (const name of names) await emit(name, 'working')
  calls.length = 0
  await clock.advance(10 * 60_000)
  // No `hc get` per worker: one `hc ls` a minute is all the hc calls there are.
  expect(calls.filter(c => c[1] === 'get')).toEqual([])
  expect(calls.length / (names.length * 10)).toBeLessThan(3)
  // Exactly the sweep's list each minute: the 3 s ticks and the report check add no call.
  expect(calls.map(c => c.join(' '))).toEqual(Array(10).fill('hc ls --json --label herdr-agents.role=worker'))
  for (const name of names) expect(stateOf(files, name)).toBe('working')
  await stopAll($, clock, names)
})

test('one failed sweep keeps the last state', async ($, on) => {
  const { clock, fail, files } = await start($, on)
  await spawn($, ['w-busy'])
  await clock.advance(60_000)
  // hc is down for the next minute: the sweep's list and every `hc get` fail. The board keeps
  // the state it last saw, and no failed call shows the worker gone.
  fail.list = 100
  // Only for the undone-change check: an hc get per row would turn these failed gets into a gone tab.
  fail.get = 100
  await clock.advance(60_000)
  fail.list = 0
  fail.get = 0
  await clock.advance(3000)
  expect(stateOf(files, 'w-busy')).toBe('working')
  await stopAll($, clock, ['w-busy'])
})

test('a status a wait or the sweep sees reaches the board, with no hc get', async ($, on) => {
  const { clock, calls, emit, status, files } = await start($, on)
  await spawn($, ['w-x'])
  await emit('w-x', 'working')
  calls.length = 0
  await clock.advance(3000)
  expect(stateOf(files, 'w-x')).toBe('working')
  // A wait ends on 'done' before any report: the board shows it at its next tick.
  await emit('w-x', 'done')
  await clock.advance(3000)
  expect(stateOf(files, 'w-x')).toBe('done')
  // Set without emit, so no wait ends on it: the sweep sees it a minute on and reports the worker blocked.
  status['w-x'] = 'blocked'
  await clock.advance(60_000)
  expect(stateOf(files, 'w-x')).toBe('blocked')
  expect(calls.filter(c => c[1] === 'get')).toEqual([])
  await stopAll($, clock, ['w-x'])
})

test('a starting worker shows as starting until its terminal is made', async ($, on) => {
  const { clock, gate, emit, files } = await start($, on)
  const release = gate(argv => argv[0] === 'hc' && argv[1] === 'run')
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-x', profile: 'builder', cwd: '/repo-w-x', task: 'x' })
  await clock.settle()
  await clock.advance(3000)
  expect(stateOf(files, 'w-x')).toBe('starting')
  release()
  await clock.settle()
  await emit('w-x', 'working')
  await clock.advance(3000)
  expect(stateOf(files, 'w-x')).toBe('working')
  await stopAll($, clock, ['w-x'])
})

// A worker that reports with `status: blocked` in its header (a real RESULT.md), as the board and the state file show it.
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
  return { ...h, token }
}

test('a report with status: blocked shows blocked, and a message to the worker ends it', async ($, on) => {
  const { clock, files } = await blockedReport($, on)
  expect(stateOf(files, 'w-a')).toBe('blocked')
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'Use main.' })
  await clock.advance(3000)
  expect(stateOf(files, 'w-a')).not.toBe('blocked')
})

test('a blocked report delivered early stays blocked while its turn finishes', async ($, on) => {
  const { clock, files, emit, typed } = await start($, on)
  files['/repo/COORDINATOR-STATE.md'] = '# S\n'
  await spawn($, ['w-a'])
  await emit('w-a', 'working')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] =
    `<!-- report ${token} -->\n\`\`\`report\nstatus: blocked\nsummary: needs an answer\n\`\`\`\nWhich branch?`
  // Delivered early: the worker still works, finishing its last message.
  await clock.advance(12_000)
  expect(stateOf(files, 'w-a')).toBe('blocked')
  // A sweep sees it working: that is its report's turn, not an answer.
  await clock.advance(60_000)
  expect(stateOf(files, 'w-a')).toBe('blocked')
  await emit('w-a', 'done')
  await clock.advance(3000)
  expect(stateOf(files, 'w-a')).toBe('blocked')
})

test('stopping a worker whose report said blocked ends blocked and keeps its report line', async ($, on) => {
  const { clock, files } = await blockedReport($, on)
  await clock.advance(3000)
  expect(stateOf(files, 'w-a')).toBe('blocked')
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-a' })
  await clock.advance(3000)
  expect(stateOf(files, 'w-a')).not.toBe('blocked')
  expect(files['/repo/COORDINATOR-STATE.md']).toMatch(/w-a \(reviewer\) done: \S*RESULT-\S+\.md\n/)
})

test('a worker blocked after its early report leaves blocked once it works again', async ($, on) => {
  const { clock, files, emit, typed } = await start($, on)
  await spawn($, ['w-a'])
  await emit('w-a', 'working')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${token} -->\nDone, but one question.`
  // The report is delivered while the worker still works (its turn has not ended).
  await clock.advance(12_000)
  expect(stateOf(files, 'w-a')).toBe('reported')
  // Its turn goes on and stops at an approval.
  await emit('w-a', 'blocked')
  await clock.advance(3000)
  expect(stateOf(files, 'w-a')).toBe('blocked')
  // The owner answers in its tab: it works again, and the state goes without any message.
  // Nothing waits on it by now, so the sweep, a minute on, sees it work.
  await emit('w-a', 'working')
  await clock.advance(60_000)
  expect(stateOf(files, 'w-a')).not.toBe('blocked')
})

test('a worker blocked with no report leaves blocked when it is stopped', async ($, on) => {
  const { clock, emit, files } = await start($, on)
  await spawn($, ['w-a'])
  await emit('w-a', 'blocked')
  await clock.advance(3000)
  expect(stateOf(files, 'w-a')).toBe('blocked')
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-a' })
  await clock.advance(3000)
  expect(stateOf(files, 'w-a')).not.toBe('blocked')
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
