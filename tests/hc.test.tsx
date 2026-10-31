import { expect } from 'claude-code/testing'
import { BATCH_MS, LOST_REPORT_MS, PROMPT_CHECK_MS, PROMPT_WAIT_MS } from '../hooks/defaults'
import { command, registering, settled, spawn, start, stopAll, test, until } from './harness'

// The hc side of the mod: the guard, how a worker is started, prompted, watched, messaged and
// closed, and what happens when hc says no. The fake in harness.tsx answers like hc 0.1.14 did.

const LINK = 'https://github.com/herdrdev/herdr-core'
const spawnArgs = { tool: 'mcp__herdr-agents__spawn', worker: 'w-hc', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' } as const
const reportsOf = (submitted: string[], name = 'w-hc') => submitted.filter(t => t.includes(`<herdr-agent name="${name}"`))
const jobOf = (store: Map<string, unknown>, name: string) =>
  (store.get('jobs:session-1234') as { jobs: Record<string, Record<string, unknown>> }).jobs[name]!

test('a session outside an hc terminal cannot spawn, and the denial says how to start one', async ($, on) => {
  await start($, on, {}, {}, { HC_TERMINAL_ID: '' })
  const denied = await $.tool.call(spawnArgs)
  expect(denied.deny).toBe(
    `this session is not in an hc terminal. Start it in the Herdr app or with: hc run --bg claude. hc is herdr-core: ${LINK}`,
  )
})

test('a session whose hc cannot be reached cannot spawn; a missing hc is the same denial', async ($, on) => {
  const { runs } = await start($, on)
  runs.set('hc get --json t1', [{ exitCode: 1, stderr: JSON.stringify({ error: { kind: 'unavailable', message: 'no core', hint: '' } }) }])
  expect((await $.tool.call(spawnArgs)).deny).toBe(`cannot reach hc: hc get: no core. hc is herdr-core: ${LINK}`)
  runs.set('hc get --json t1', [{ exitCode: 0, reject: 'spawn hc ENOENT' }])
  expect((await $.tool.call(spawnArgs)).deny).toMatch(/^cannot reach hc: .*ENOENT.*hc is herdr-core/)
})

test('a name over 32 characters or shaped like a terminal address is denied', async ($, on) => {
  const { clock } = await start($, on)
  const call = (worker: string) => $.tool.call({ ...spawnArgs, worker, profile: 'reviewer', cwd: `/repo-${worker}` })
  expect((await call('a'.repeat(33))).deny).toMatch(/worker must match/)
  for (const bad of ['t99', 't1b', 't7x']) expect((await call(bad)).deny).toMatch(/not look like a terminal address/)
  // hc takes these, so the mod does too.
  const good = ['tb', 'test', 'tasks', 't-1', 't1-x', 'w1', 'a'.repeat(32)]
  for (const worker of good) expect((await call(worker)).deny).toBeUndefined()
  await settled()
  await stopAll($, clock, good)
})

test('every hc call runs with no caller, so agents are not sent <hc from> text', async ($, on) => {
  const { clock, hcEnvs, calls, finish, files, typed, herdrCalls } = await start($, on)
  await $.tool.call(spawnArgs)
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-hc/RESULT.md'] = `<!-- report ${token} -->\nDone.`
  await finish('w-hc')
  await clock.advance(BATCH_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-hc' })
  await clock.advance(10_000)
  expect(calls.length).toBeGreaterThan(5)
  expect(hcEnvs).toHaveLength(calls.length)
  // Only the guard's own `hc get t1` could carry the id, and it passes it as an argument, not in the environment.
  expect(hcEnvs.every(env => env?.HC_TERMINAL_ID === '')).toBe(true)
  expect(calls.some(c => c.join(' ') === 'hc get --json t1')).toBe(true)
  // The old herdr CLI is never called.
  expect(herdrCalls).toEqual([])
})

test("the tab goes to the coordinator's space and is named after the worker", async ($, on) => {
  const { clock, shell, calls } = await start($, on)
  await $.tool.call(spawnArgs)
  await settled()
  expect(shell).toContain('herdr-app do tab.rename --id hrd-w-hc --name w-hc')
  expect(calls.find(c => c[1] === 'run')).toEqual(
    expect.arrayContaining(['herdr.space=sp1', 'herdr.tab=hrd-w-hc', 'herdr-agents.role=worker']),
  )
  await stopAll($, clock, ['w-hc'])
})

test('a coordinator outside a Herdr space starts the worker unlabelled, with an hc attach hint, and renames nothing', async ($, on) => {
  const { clock, calls, shell, self } = await start($, on)
  self.labels = {}
  const r = await $.tool.call(spawnArgs)
  expect(r.result).toContain('Not in a Herdr space: watch it with hc attach w-hc.')
  await settled()
  const run = (calls.find(c => c[1] === 'run') ?? []).join(' ')
  expect(run).toContain('--label herdr-agents.role=worker')
  expect(run).not.toContain('herdr.space')
  expect(run).not.toContain('herdr.tab')
  expect(shell.filter(c => c.startsWith('herdr-app'))).toEqual([])
  await stopAll($, clock, ['w-hc'])
})

test('a tab that cannot be renamed does not fail the start; the rename is tried twice', async ($, on) => {
  const { clock, shell, fail, typed } = await start($, on)
  fail.rename = 5
  await $.tool.call(spawnArgs)
  await settled()
  await clock.advance(2000)
  expect(typed).toHaveLength(1)
  expect(shell.filter(c => c.startsWith('herdr-app do tab.rename'))).toHaveLength(2)
  await stopAll($, clock, ['w-hc'])
})

test("a name hc already has live fails the start with hc's message", async ($, on) => {
  const { clock, submitted, addTerm, status } = await start($, on)
  addTerm('w-hc', '/elsewhere', {})
  status['w-hc'] = 'idle'
  await $.tool.call(spawnArgs)
  await settled()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/status="failed">\nThe worker did not start: hc run: w-hc is taken\./)
})

test('a CLI that reports an error while it boots is a failed start', async ($, on) => {
  const { clock, submitted, waitReplies, closed } = await start($, on)
  waitReplies['w-hc'] = [{ ended: true, reason: 'status', status: 'error' }]
  await $.tool.call(spawnArgs)
  await settled()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/status="failed">\nThe worker did not start: the CLI reported an error while it started/)
  expect(closed).toEqual(['w-hc'])
})

test('a trust prompt during boot is answered when the folder is trusted, and the start goes on', async ($, on) => {
  const { clock, typed, keyed, waitReplies, screens } = await start($, on)
  waitReplies['w-hc'] = [{ ended: false, reason: 'status', status: 'blocked' }]
  screens['w-hc'] = 'Do you trust /repo/wt?\n❯ 1. Yes, I trust this folder'
  await $.tool.call(spawnArgs)
  await settled()
  expect(keyed).toEqual([['w-hc', 'down', 'enter']])
  expect(typed).toHaveLength(1)
  await stopAll($, clock, ['w-hc'])
})

test('a trust prompt that reads as idle is answered before the first prompt goes in', async ($, on) => {
  const { clock, typed, keyed, screens, status } = await start($, on)
  screens['w-hc'] = 'Do you trust /repo/wt?\n❯ 1. Yes, I trust this folder'
  status['w-hc'] = 'idle'
  await $.tool.call(spawnArgs)
  await settled()
  expect(keyed).toEqual([['w-hc', 'down', 'enter']])
  expect(typed).toHaveLength(1)
  await stopAll($, clock, ['w-hc'])
})

test('a trust prompt with the folder path wrapped over lines is still answered', async ($, on) => {
  const { clock, typed, keyed, screens, status } = await start($, on)
  screens['w-hc'] = 'Do you trust /re\npo/wt?\n❯ 1. Yes, I trust this folder'
  status['w-hc'] = 'idle'
  await $.tool.call(spawnArgs)
  await settled()
  expect(keyed).toEqual([['w-hc', 'down', 'enter']])
  expect(typed).toHaveLength(1)
  await stopAll($, clock, ['w-hc'])
})

test('a CLI that reports a word and then exits is a failed start', async ($, on) => {
  const { clock, submitted, waitReplies } = await start($, on)
  waitReplies['w-hc'] = [{ ended: true, reason: 'exit', status: 'idle', exit_code: 1 }]
  await $.tool.call(spawnArgs)
  await settled()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/status="failed">\nThe worker did not start: the CLI exited \(code 1\)/)
})

test('a prompt other than the trust prompt during boot is a failed start', async ($, on) => {
  const { clock, submitted, keyed, waitReplies, screens } = await start($, on)
  waitReplies['w-hc'] = [{ ended: false, reason: 'status', status: 'blocked' }]
  screens['w-hc'] = 'Allow this MCP server?'
  await $.tool.call(spawnArgs)
  await settled()
  await clock.advance(BATCH_MS)
  expect(keyed).toEqual([])
  expect(submitted.at(-1)).toMatch(/The worker did not start: the CLI is blocked during startup/)
})

test('a prompt hc reports as not started with no status is delivered; the quiet-screen rule judges the worker', async ($, on) => {
  const { clock, submitted, typed, noStatus, screens, store } = await start($, on)
  noStatus.add('w-hc')
  screens['w-hc'] = '⏺ Working on it.\n────\n❯ \n────\n  aerolab · wt · Haiku 5.5 (xhigh)'
  await $.tool.call(spawnArgs)
  await settled()
  expect(typed).toHaveLength(1)
  expect(jobOf(store, 'w-hc')).toMatchObject({ status: 'running' })
  await clock.advance(7 * 60_000)
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)[0]).toMatch(/stopped \(unknown, screen unchanged for 5 min\) without writing RESULT\.md/)
  await stopAll($, clock, ['w-hc'])
})

test('a prompt that finds the text still in the input box presses Enter instead of typing it again', async ($, on) => {
  const { clock, typed, keyed, stalls, screens, onKeys } = await start($, on)
  // The first try starts no work, and the screen shows the prompt unsent; the Enter starts it.
  stalls['w-hc'] = 1
  screens['w-hc'] = 'Your task is in /repo/wt/.herdr-agents/w-hc/TASK.md. Read it and do it.'
  onKeys['w-hc'] = 'working'
  await $.tool.call(spawnArgs)
  await settled()
  await clock.advance(PROMPT_WAIT_MS)
  expect(typed).toHaveLength(1)
  expect(keyed).toEqual([['w-hc', 'enter']])
  await stopAll($, clock, ['w-hc'])
})

// Seen with a real builder: hc says idle and started: false for 56 s, as Claude starts no turn until its
// session.start hooks are done, and a copy typed meanwhile ran after the first (hc-check, app-s0-spike).
test('a prompt the CLI sits on is not typed again while it starts its turn', async ($, on) => {
  const { clock, calls, typed, holds, screens, status } = await start($, on)
  holds.add('w-hc')
  await $.tool.call(spawnArgs)
  await settled()
  await clock.advance(56_000)
  expect(typed).toHaveLength(1)
  holds.delete('w-hc')
  screens['w-hc'] = ''
  status['w-hc'] = 'working'
  await clock.advance(PROMPT_WAIT_MS)
  expect(typed).toHaveLength(1)
  expect(calls.filter(c => c[1] === 'read' && c.includes('--lines'))).toEqual([])
  await stopAll($, clock, ['w-hc'])
})

test('a prompt the CLI still sits on after the wait, shown as its paste placeholder, is submitted and not typed again', async ($, on) => {
  const { clock, calls, typed, keyed, holds, onKeys } = await start($, on)
  holds.add('w-hc')
  onKeys['w-hc'] = 'working'
  await $.tool.call(spawnArgs)
  await settled()
  await clock.advance(PROMPT_WAIT_MS)
  expect(typed).toHaveLength(1)
  expect(keyed).toEqual([['w-hc', 'enter']])
  // The screen was read (that is how the placeholder was seen), and only its visible part.
  const reads = calls.filter(c => c[1] === 'read')
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.filter(c => c.includes('--lines'))).toEqual([])
  await stopAll($, clock, ['w-hc'])
})

// The placeholder of an earlier prompt can stay in the transcript above the input box.
test('a paste placeholder far above the input box is not taken for the prompt, so a dropped one is typed again', async ($, on) => {
  const { clock, typed, keyed, stalls, screens } = await start($, on)
  stalls['w-hc'] = 1
  screens['w-hc'] = `❯ [Pasted text #1]\n${'⏺ Earlier output.\n'.repeat(12)}────\n❯ \n────`
  await $.tool.call(spawnArgs)
  await settled()
  await clock.advance(PROMPT_WAIT_MS)
  await until(clock, () => typed.length === 2)
  expect(typed).toHaveLength(2)
  expect(keyed).toEqual([])
  await stopAll($, clock, ['w-hc'])
})

test('a follow-up to a worker at turn 3 that never reaches it is typed again: only a rise above turn 3 counts as started', async ($, on) => {
  const { clock, typed, files, finish, stalls, turns } = await start($, on)
  await $.tool.call(spawnArgs)
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-hc/RESULT.md'] = `<!-- report ${token} -->\nDone.`
  await finish('w-hc')
  await clock.advance(BATCH_MS)
  turns['w-hc'] = 3
  stalls['w-hc'] = 1
  const sent = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-hc', text: 'Use option B.' })
  await until(clock, () => typed.length === 2)
  await clock.advance(PROMPT_WAIT_MS)
  await until(clock, () => typed.length === 3)
  await sent
  expect(typed).toHaveLength(3)
  expect(typed[2]).toBe(typed[1])
  await stopAll($, clock, ['w-hc'])
})

test('slow hc calls do not stretch a prompt past its deadline: no further try is made', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, typed, keyed, stalls, gate } = await start($, on)
  stalls['w-hc'] = 9
  await $.tool.call(spawnArgs)
  await settled()
  // Two `hc get` calls that take 5 and 2 minutes: the wait for the second try is far from over, yet the deadline is.
  const first = gate(argv => argv[1] === 'get')
  const second = gate(argv => argv[1] === 'get')
  await clock.advance(PROMPT_CHECK_MS)
  await clock.advance(5 * 60_000)
  first()
  await clock.advance(PROMPT_CHECK_MS)
  await clock.advance(2 * 60_000)
  second()
  // Past the deadline no try follows: not typed again, not submitted. Without it, the 90 s wait would go on from 0 and try again.
  await clock.advance(PROMPT_WAIT_MS * 3)
  expect(typed).toHaveLength(1)
  expect(keyed).toEqual([])
  await stopAll($, clock, ['w-hc'])
})

test('a short turn that started and ended between two looks counts as started', async ($, on) => {
  const { clock, typed, holds, screens, status, turns } = await start($, on)
  holds.add('w-hc')
  await $.tool.call(spawnArgs)
  await settled()
  // Back at an empty input box, status done: only the turn count says the prompt ran.
  holds.delete('w-hc')
  screens['w-hc'] = ''
  status['w-hc'] = 'done'
  turns['w-hc'] = 1
  await clock.advance(PROMPT_WAIT_MS * 2)
  expect(typed).toHaveLength(1)
  await stopAll($, clock, ['w-hc'])
})

test('a prompt that really was dropped is typed again once the wait is over, and not before', async ($, on) => {
  const { clock, typed, stalls } = await start($, on)
  stalls['w-hc'] = 1
  await $.tool.call(spawnArgs)
  await settled()
  await clock.advance(PROMPT_WAIT_MS - 5000)
  expect(typed).toHaveLength(1)
  await clock.advance(5000)
  await until(clock, () => typed.length === 2)
  expect(typed[1]).toBe(typed[0])
  await stopAll($, clock, ['w-hc'])
})

// Each $.tool.register waits 8 s for a tool an --agent's tools line never lets in, and Claude starts no turn until
// session.start is done: seven tools held a builder's first prompt for 56 s.
test("a worker's session does not wait for its tools to register", async ($, on) => {
  let release = () => {}
  registering.until = new Promise<void>(resolve => (release = resolve))
  const { clock, tools } = await start($, on, {}, {}, { HERDR_AGENTS_ROLE: 'worker' })
  expect(Object.keys(tools)).toEqual([])
  release()
  registering.until = undefined
  await until(clock, () => Object.keys(tools).length === 7)
  expect(Object.keys(tools)).toContain('spawn')
})

test("a worker's tools that fail to register are reported in a toast, not dropped", async ($, on) => {
  registering.fail = 'no such tool'
  try {
    const { clock, toasts } = await start($, on, {}, {}, { HERDR_AGENTS_ROLE: 'worker' })
    await until(clock, () => toasts.some(t => t.includes('registering its tools failed')))
    expect(toasts.filter(t => t.includes('registering its tools failed'))).toHaveLength(1)
  } finally {
    registering.fail = undefined
  }
})

test('a prompt hc refuses because the worker is blocked is reported at once as not typed', async ($, on) => {
  const { clock, submitted, status, gate } = await start($, on)
  const release = gate(argv => argv[1] === 'send')
  await $.tool.call(spawnArgs)
  await settled()
  status['w-hc'] = 'blocked'
  release()
  await settled()
  await clock.advance(LOST_REPORT_MS + BATCH_MS)
  expect(reportsOf(submitted)[0]).toMatch(
    /status="blocked">\nThe worker stopped \(it waits at an approval or question, so the text was not typed\)/,
  )
})

test('a prompt hc refuses because the terminal finished is reported as gone', async ($, on) => {
  const { clock, submitted, terms, gate } = await start($, on)
  const release = gate(argv => argv[1] === 'send')
  await $.tool.call(spawnArgs)
  await settled()
  terms.get('w-hc')!.finished = true
  release()
  await settled()
  await clock.advance(LOST_REPORT_MS + BATCH_MS)
  expect(reportsOf(submitted)[0]).toMatch(/The worker stopped \(its terminal is gone\)/)
})

test('the watch ignores heartbeats and reads a line that arrives in pieces', async ($, on) => {
  const { clock, submitted, typed, files, emit, heartbeat, pieces, calls } = await start($, on)
  pieces.split = true
  await $.tool.call({ ...spawnArgs, worker: 'w-busy' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nDone.`
  await heartbeat('w-busy')
  expect(reportsOf(submitted, 'w-busy')).toEqual([])
  // The snapshot said working; 'done' arrives as one line in two pieces and the turn is over.
  await emit('w-busy', 'done')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted, 'w-busy')).toHaveLength(1)
  expect(calls.filter(c => c[1] === 'events')).toHaveLength(1)
})

test('a watch is dropped when its terminal finishes: nothing is reported until the sweeps miss it', async ($, on) => {
  const { clock, submitted, gone, streams } = await start($, on)
  await $.tool.call(spawnArgs)
  await settled()
  expect(streams).toHaveLength(1)
  gone.add('w-hc')
  await clock.settle()
  // The child is let go with the loop, and no settle follows.
  expect(streams).toHaveLength(0)
  expect(reportsOf(submitted)).toEqual([])
  await clock.advance(60_000)
  await clock.advance(60_000)
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)[0]).toMatch(/status="gone">\nThe worker stopped \(its tab is gone\)/)
})

test('a CLI error from the watch, or from the sweep, is reported as status error', async ($, on) => {
  const { clock, submitted, emit, status } = await start($, on)
  await spawn($, ['w-watch'])
  await emit('w-watch', 'error')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted, 'w-watch')[0]).toMatch(/status="error">\nThe worker stopped \(its CLI reported an error\)/)

  await spawn($, ['w-sweep'])
  // Set without emit: no event, so the sweep is what sees it.
  status['w-sweep'] = 'error'
  await clock.advance(60_000)
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted, 'w-sweep')[0]).toMatch(/status="error">\nThe worker stopped \(its CLI reported an error\)/)
  await stopAll($, clock, ['w-watch', 'w-sweep'])
})

test('a report wins over an error status', async ($, on) => {
  const { clock, submitted, typed, files, emit } = await start($, on)
  await $.tool.call(spawnArgs)
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-hc/RESULT.md'] = `<!-- report ${token} -->\nDone, then it crashed.`
  await emit('w-hc', 'error')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)[0]).toMatch(/status="done">\nDone, then it crashed\./)
})

test('a finished terminal left behind does not deny a builder in its folder; a live one does', async ($, on) => {
  const { clock, terms } = await start($, on)
  await $.tool.call(spawnArgs)
  await settled()
  terms.get('w-hc')!.finished = true
  const next = await $.tool.call({ ...spawnArgs, worker: 'w-next' })
  expect(next.deny).toBeUndefined()
  await settled()
  const third = await $.tool.call({ ...spawnArgs, worker: 'w-third' })
  expect(third.deny).toMatch(/w-next \(builder\) is still open in \/repo\/wt/)
  await stopAll($, clock, ['w-hc', 'w-next'])
})

test('stop kills the terminal before it removes it, and a terminal hc no longer knows still counts as closed', async ($, on) => {
  const { clock, calls, store, gone } = await start($, on)
  await spawn($, ['w-a', 'w-b'])
  const stopped = await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-a' })
  expect(JSON.stringify(stopped)).toContain('Stopped w-a and closed its tab.')
  const ops = calls.map(c => c.join(' ')).filter(c => /^hc (kill|rm) --json w-a$/.test(c))
  expect(ops).toEqual(['hc kill --json w-a', 'hc rm --json w-a'])

  gone.add('w-b')
  const other = await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-b' })
  expect(JSON.stringify(other)).toContain('Stopped w-b and closed its tab.')
  expect(jobOf(store, 'w-b')).toMatchObject({ closed: true })
  await clock.advance(10_000)
})

test('a terminal that is slow to die is removed on the second try, a second later', async ($, on) => {
  const { clock, calls, stubborn, removed } = await start($, on)
  await spawn($, ['w-slow'])
  stubborn['w-slow'] = 1
  const stopping = $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-slow' })
  await clock.advance(1000)
  expect(JSON.stringify(await stopping)).toContain('Stopped w-slow and closed its tab.')
  expect(calls.filter(c => c[1] === 'rm')).toHaveLength(2)
  expect(removed).toEqual(['w-slow'])
  await clock.advance(10_000)
})

test('a job stored by the herdr version is swept as gone: hc has no such worker', async ($, on) => {
  const job = {
    name: 'w-old',
    profile: 'builder',
    cwd: '/repo/wt',
    dir: '/repo/wt/.herdr-agents/w-old',
    startedAt: 900_000,
    status: 'running',
    token: 'tok-old',
    tab: 't-old',
    pane: 'p-old',
  }
  const { clock, submitted, gone } = await start($, on, {}, { 'jobs:session-1234': { at: 990_000, jobs: { 'w-old': job } } })
  gone.add('w-old')
  await clock.settle()
  await clock.advance(60_000)
  await clock.advance(60_000)
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted, 'w-old')[0]).toMatch(/status="gone">\nThe worker stopped \(its tab is gone\)/)
  // A message to it goes down the lost-prompt path: hc has no such terminal.
  const sent = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-old', text: 'Hello?' })
  expect(sent.result).toContain('Sent to w-old')
  await clock.advance(LOST_REPORT_MS)
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted, 'w-old').at(-1)).toMatch(/status="blocked">\nThe worker stopped \(its terminal is gone\)/)
})

test('a running job in the store is watched again after a reload', async ($, on) => {
  const job = {
    name: 'w-run',
    profile: 'builder',
    cwd: '/repo/wt',
    dir: '/repo/wt/.herdr-agents/w-run',
    startedAt: 900_000,
    status: 'running',
    token: 'tok-run',
    address: 't12',
  }
  const { clock, calls, streams } = await start($, on, {}, { 'jobs:session-1234': { at: 990_000, jobs: { 'w-run': job } } })
  await clock.settle()
  expect(calls.map(c => c.join(' '))).toContain('hc events --terminal w-run --json')
  expect(streams).toHaveLength(1)
  await stopAll($, clock, ['w-run'])
})

// A blocked worker is answered through hc's refusal: forced for a question, never for a permission.
test('a message to a worker blocked at a question is sent with --force', async ($, on) => {
  const { clock, sends, status, blockedKind } = await start($, on)
  await $.tool.call(spawnArgs)
  await settled()
  status['w-hc'] = 'blocked'
  blockedKind['w-hc'] = 'question'
  const r = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-hc', text: 'Use option B.' })
  expect(JSON.stringify(r)).toContain('Sent to w-hc')
  expect(sends.at(-1)).toMatchObject({ name: 'w-hc', force: true })
  expect(sends.at(-1)?.text).toContain('extra message')
  await stopAll($, clock, ['w-hc'])
})

test('a message to a worker blocked at a permission or an unnamed prompt is denied and changes nothing', async ($, on) => {
  const { clock, sends, status, blockedKind, store, files } = await start($, on)
  await $.tool.call(spawnArgs)
  await settled()
  const before = JSON.stringify(jobOf(store, 'w-hc'))
  const sent = sends.length
  const files0 = Object.keys(files).length
  status['w-hc'] = 'blocked'
  blockedKind['w-hc'] = 'permission'
  const denied = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-hc', text: 'Go on.' })
  expect(denied.deny).toMatch(/waits at a permission prompt that only the person can answer/)
  delete blockedKind['w-hc']
  const unnamed = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-hc', text: 'Go on.' })
  expect(unnamed.deny).toMatch(/waits at an approval or question that only the person can answer/)
  expect(sends).toHaveLength(sent)
  expect(JSON.stringify(jobOf(store, 'w-hc'))).toBe(before)
  expect(Object.keys(files)).toHaveLength(files0)
  await stopAll($, clock, ['w-hc'])
})

test('a message hc refuses to type is a denial, not an error', async ($, on) => {
  const { clock, terms } = await start($, on)
  await $.tool.call(spawnArgs)
  await settled()
  terms.get('w-hc')!.finished = true
  const denied = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-hc', text: 'Anyone there?' })
  expect(denied.deny).toMatch(/could not type the message into w-hc: hc send: w-hc has finished/)
  await stopAll($, clock, ['w-hc'])
})

// Prune: the worktree stays while anything works in it, and only the mod's own workers are closed.
const PR =
  'gh pr list --repo acme/app-client --head fix-x --state merged --json number,headRefOid --jq .[0] | "\\(.number) \\(.headRefOid)"'
const pruneJob = {
  name: 'w-done',
  profile: 'builder',
  cwd: '/repo/wt',
  dir: '/repo/wt/.herdr-agents/w-done',
  startedAt: 900_000,
  endedAt: 950_000,
  status: 'reported',
  closed: false,
  token: 'tok-done',
}
const prunable = async ($: Parameters<typeof start>[0], on: Parameters<typeof start>[1], job: object = pruneJob) => {
  const h = await start($, on, {}, { 'jobs:session-1234': { at: 990_000, jobs: { 'w-done': job } } })
  h.files['/repo/wt/x'] = ''
  h.runs.set('git -C /repo/wt rev-parse --path-format=absolute --git-common-dir', [{ exitCode: 0, stdout: '/repo/.git\n' }])
  h.runs.set('git --git-dir=/repo/.git worktree list --porcelain', [
    { exitCode: 0, stdout: 'worktree /repo\nbranch refs/heads/main\n\nworktree /repo/wt\nbranch refs/heads/fix-x\n' },
  ])
  h.runs.set('git -C /repo/wt status --porcelain', [{ exitCode: 0, stdout: '' }])
  h.runs.set(PR, [{ exitCode: 0, stdout: '12 abc123\n' }])
  h.runs.set('git -C /repo/wt rev-parse HEAD', [{ exitCode: 0, stdout: 'abc123\n' }])
  h.runs.set('git --git-dir=/repo/.git worktree remove /repo/wt', [{ exitCode: 0 }])
  return h
}

test('prune keeps a worktree while a terminal of someone else works in it', async ($, on) => {
  const { clock, closed, addTerm, status, shell } = await prunable($, on)
  addTerm('stranger', '/repo/wt', {})
  status.stranger = 'working'
  await clock.settle()
  await command($, 'hrd-prune')
  expect(shell.some(c => c.includes('worktree remove'))).toBe(false)
  expect(closed).toEqual([])
})

const WORKER = { 'herdr-agents.role': 'worker' }
const removes = (shell: string[]) => shell.some(c => c.includes('worktree remove'))

test("prune closes the mod's own idle workers in a merged worktree", async ($, on) => {
  const { clock, closed, removed, addTerm, status, shell } = await prunable($, on)
  addTerm('w-done', '/repo/wt', WORKER)
  status['w-done'] = 'idle'
  await clock.settle()
  const out = await command($, 'hrd-prune')
  expect(shell).toContain('git --git-dir=/repo/.git worktree remove /repo/wt')
  expect(JSON.stringify(out)).toContain('app-client#12')
  expect(closed).toEqual(['w-done'])
  expect(removed).toEqual(['w-done'])
})

test('prune keeps a worktree whose job is still running while its worker sits idle between turns', async ($, on) => {
  const { clock, closed, addTerm, status, shell } = await prunable($, on, {
    ...pruneJob,
    endedAt: undefined,
    status: 'running',
    address: 'w-done',
  })
  addTerm('w-done', '/repo/wt', WORKER)
  status['w-done'] = 'idle'
  await clock.settle()
  await command($, 'hrd-prune')
  expect(removes(shell)).toBe(false)
  expect(closed).toEqual([])
})

test('prune keeps a worktree whose job is parked on a WAIT.json', async ($, on) => {
  const wait = { for: 'CI', check: 'true', every: 1, max: 30, since: 900_000 }
  const { clock, shell } = await prunable($, on, { ...pruneJob, endedAt: undefined, status: 'running', wait })
  await clock.settle()
  await command($, 'hrd-prune')
  expect(removes(shell)).toBe(false)
})

test('prune keeps a worktree where an unlabelled terminal sits idle', async ($, on) => {
  const { clock, closed, addTerm, status, shell } = await prunable($, on)
  addTerm('stranger', '/repo/wt', {})
  status.stranger = 'idle'
  await clock.settle()
  await command($, 'hrd-prune')
  expect(removes(shell)).toBe(false)
  expect(closed).toEqual([])
})

test('prune keeps a worktree where an unlabelled terminal reports no status', async ($, on) => {
  const { clock, addTerm, noStatus, shell } = await prunable($, on)
  addTerm('stranger', '/repo/wt', {})
  noStatus.add('stranger')
  await clock.settle()
  await command($, 'hrd-prune')
  expect(removes(shell)).toBe(false)
})

test('prune keeps a worktree where a labelled worker reports no status', async ($, on) => {
  const { clock, closed, addTerm, noStatus, shell } = await prunable($, on)
  addTerm('w-done', '/repo/wt', WORKER)
  noStatus.add('w-done')
  await clock.settle()
  await command($, 'hrd-prune')
  expect(removes(shell)).toBe(false)
  expect(closed).toEqual([])
})

test('prune does nothing when either terminal list fails', async ($, on) => {
  const { clock, runs, addTerm, status, shell } = await prunable($, on)
  addTerm('w-done', '/repo/wt', WORKER)
  status['w-done'] = 'idle'
  runs.set('hc ls --json --label herdr-agents.role=worker', [{ exitCode: 1, stderr: 'no core' }])
  await clock.settle()
  const out = await command($, 'hrd-prune')
  expect(removes(shell)).toBe(false)
  expect(JSON.stringify(out)).not.toContain('app-client#12')
})
