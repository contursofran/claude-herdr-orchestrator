import { expect } from 'claude-code/testing'
import { hcStatusPlugin, OPENCODE_PLUGIN } from '../hooks/opencode'
import { settled, start, stopAll, test } from './harness'

// The opencode plugin that reports a worker's status to hc: when it is written, and what each event reports.

const FILE = '/home/t/.config/opencode/plugins/hc-status.js'
const opencode = { profiles: { oc: { kind: 'opencode', args: [] } } }
const spawnOc = async ($: Parameters<typeof start>[0]) => {
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-oc', profile: 'oc', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
}

test('an opencode worker gets the plugin written when it is missing', async ($, on) => {
  const { clock, files } = await start($, on, opencode)
  expect(files[FILE]).toBeUndefined()
  await spawnOc($)
  expect(files[FILE]).toBe(OPENCODE_PLUGIN)
  await stopAll($, clock, ['w-oc'])
})

test('a plugin that differs is replaced; one that is the same is left alone', async ($, on) => {
  const { clock, files, typed, gate } = await start($, on, opencode)
  files[FILE] = '// an old version'
  await spawnOc($)
  expect(files[FILE]).toBe(OPENCODE_PLUGIN)
  // A write of the same file would wait on the gate, and the second worker would never get its prompt.
  gate(argv => argv[1] === FILE)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-oc2', profile: 'oc', cwd: '/repo/wt2', task: 'Fix it.' })
  await settled()
  expect(typed.filter(t => t.includes('/repo/wt2/.herdr-agents/w-oc2/TASK.md'))).toHaveLength(1)
  await stopAll($, clock, ['w-oc', 'w-oc2'])
})

test('XDG_CONFIG_HOME decides where the plugin goes', async ($, on) => {
  const { clock, files } = await start($, on, opencode, {}, { XDG_CONFIG_HOME: '/xdg' })
  await spawnOc($)
  expect(files['/xdg/opencode/plugins/hc-status.js']).toBe(OPENCODE_PLUGIN)
  expect(files[FILE]).toBeUndefined()
  await stopAll($, clock, ['w-oc'])
})

test("a profile's XDG_CONFIG_HOME and OPENCODE_CONFIG_DIR decide where its plugin goes", async ($, on) => {
  const { clock, files } = await start(
    $,
    on,
    {
      profiles: {
        oc: { kind: 'opencode', args: [], env: { XDG_CONFIG_HOME: '/pxdg' } },
        od: { kind: 'opencode', args: [], env: { OPENCODE_CONFIG_DIR: '/pdir', XDG_CONFIG_HOME: '/pxdg' } },
      },
    },
    {},
    { XDG_CONFIG_HOME: '/xdg' },
  )
  await spawnOc($)
  expect(files['/pxdg/opencode/plugins/hc-status.js']).toBe(OPENCODE_PLUGIN)
  expect(files['/xdg/opencode/plugins/hc-status.js']).toBeUndefined()
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-od', profile: 'od', cwd: '/repo/wt2', task: 'Fix it.' })
  await settled()
  expect(files['/pdir/plugins/hc-status.js']).toBe(OPENCODE_PLUGIN)
  await stopAll($, clock, ['w-oc', 'w-od'])
})

test('a plugin that cannot be written does not stop the worker', async ($, on) => {
  const { clock, files, typed, unwritable } = await start($, on, opencode)
  unwritable.add(FILE)
  await spawnOc($)
  expect(files[FILE]).toBeUndefined()
  expect(typed.filter(t => t.includes('/repo/wt/.herdr-agents/w-oc/TASK.md'))).toHaveLength(1)
  await stopAll($, clock, ['w-oc'])
})

test('workers of other kinds get no plugin', async ($, on) => {
  const { clock, files } = await start($, on, { profiles: { cx: { kind: 'codex', args: [] } } })
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-cx', profile: 'cx', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  expect(Object.keys(files).filter(f => f.endsWith('hc-status.js'))).toEqual([])
  await stopAll($, clock, ['w-cx'])
})

test('an opencode worker is waited on for 12 tries before its first prompt, other kinds for 3', async ($, on) => {
  const { clock, calls, waitReplies } = await start($, on, {
    profiles: { oc: { kind: 'opencode', args: [] }, gm: { kind: 'gemini', args: [] } },
  })
  const waits = (name: string) => calls.filter(c => c[0] === 'hc' && c[1] === 'wait' && c.includes(name) && c.includes('5')).length
  for (const [worker, profile, n] of [
    ['w-oc', 'oc', 12],
    ['w-gm', 'gm', 3],
  ] as const) {
    waitReplies[worker] = Array.from({ length: 20 }, () => ({ ended: false, reason: 'timeout', status: 'working' }))
    await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker, profile, cwd: `/repo/${worker}`, task: 'Fix it.' })
    await settled()
    expect(waits(worker)).toBe(n)
  }
  await stopAll($, clock, ['w-oc', 'w-gm'])
})

// A fake `fs`: what the plugin writes in place of /dev/tty is recorded. Paths in `refused` can't be opened.
function fakeTty(refused: string[] = []) {
  const written: { path: string; text: string }[] = []
  const fs = {
    appendFileSync: (path: string, text: string) => {
      if (refused.includes(path)) throw new Error('ENXIO')
      written.push({ path, text })
    },
  }
  const states = () =>
    written.map(w => {
      const m = w.text.match(/^\x1b\]7501;state=(.+):app=opencode\x1b\\$/)
      expect(m).not.toBeNull()
      return m![1]!
    })
  return { fs, states, written }
}
// Loads the plugin as opencode 1 does: its `server` entry.
async function load(env: Record<string, string | undefined>, proc: any = {}, run: any = null) {
  const { fs, states, written } = fakeTty()
  const hooks = await hcStatusPlugin(fs, env, proc, run).server()
  return { hooks: hooks as any, states, written }
}
const ev = (type: string, properties: Record<string, unknown> = {}) => ({ event: { type, properties } })

// Loads the plugin as opencode 2 does: its `setup` entry, with a fake `ctx.event.subscribe`. `emit` hands it events
// (they carry `data`, not `properties`) and returns once it has handled them.
function loadV2(env: Record<string, string | undefined>, proc: any = {}, run: any = null, refused: string[] = []) {
  const tty = fakeTty(refused)
  const queue: any[] = []
  let wake = () => {}
  let aborted = false
  let signal: AbortSignal | undefined
  const subscribe = async function* (opts: { signal: AbortSignal }) {
    signal = opts.signal
    opts.signal.addEventListener('abort', () => wake())
    while (!opts.signal.aborted) {
      if (queue.length > 0) yield queue.shift()
      else await new Promise<void>(r => (wake = r))
    }
    aborted = true
  }
  const dispose = hcStatusPlugin(tty.fs, env, proc, run).setup({ event: { subscribe } })
  const emit = async (...events: [string, Record<string, unknown>?][]) => {
    queue.push(...events.map(([type, data]) => ({ id: 'e', type, data: data ?? {} })))
    wake()
    await settled()
  }
  return { ...tty, dispose, emit, stopped: () => aborted, subscribed: () => signal !== undefined }
}

test('the plugin reports idle on load and maps each opencode event to a state', async () => {
  const { hooks, states } = await load({ HC_TERMINAL_ID: 't9' })
  expect(states()).toEqual(['idle'])
  await hooks['chat.message']({ sessionID: 's1' })
  await hooks['tool.execute.before']({})
  await hooks['tool.execute.after']({})
  await hooks.event(ev('session.status', { sessionID: 's1', status: { type: 'busy' } }))
  await hooks.event(ev('permission.asked', { sessionID: 's1' }))
  await hooks.event(ev('permission.replied', { sessionID: 's1' }))
  await hooks.event(ev('question.asked', { sessionID: 's1' }))
  await hooks.event(ev('session.idle', { sessionID: 's1' }))
  await hooks.event(ev('session.status', { sessionID: 's1', status: { type: 'idle' } }))
  await hooks.event(ev('session.error', { sessionID: 's1' }))
  await hooks.event(ev('message.updated', { sessionID: 's1' }))
  expect(states()).toEqual([
    'idle',
    'working',
    'working',
    'working',
    'working',
    'blocked:kind=permission',
    'working',
    'blocked:kind=question',
    'idle',
    'idle',
    'error',
  ])
})

test("a subagent's session does not change the worker's state, except a permission or question it asks", async () => {
  const { hooks, states } = await load({ HC_TERMINAL_ID: 't9' })
  await hooks.event(ev('session.created', { sessionID: 'kid', info: { id: 'kid', parentID: 's1' } }))
  await hooks['chat.message']({ sessionID: 'kid' })
  await hooks.event(ev('session.status', { sessionID: 'kid', status: { type: 'busy' } }))
  await hooks.event(ev('session.idle', { sessionID: 'kid' }))
  await hooks.event(ev('session.error', { sessionID: 'kid' }))
  await hooks['tool.execute.before']({ sessionID: 'kid' })
  await hooks['tool.execute.after']({ sessionID: 'kid' })
  expect(states()).toEqual(['idle'])
  await hooks.event(ev('permission.asked', { sessionID: 'kid' }))
  expect(states()).toEqual(['idle', 'blocked:kind=permission'])
  await hooks['tool.execute.before']({ sessionID: 'kid2' })
  await hooks['tool.execute.before']({ sessionID: 'kid' })
  expect(states()).toEqual(['idle', 'blocked:kind=permission', 'working'])
})

test('an error lasts until the next sign of work; a subagent error does not count', async () => {
  const { hooks, states } = await load({ HC_TERMINAL_ID: 't9' })
  await hooks.event(ev('session.created', { sessionID: 'kid', info: { id: 'kid', parentID: 's1' } }))
  await hooks.event(ev('session.error', { sessionID: 'kid' }))
  await hooks.event(ev('session.idle', { sessionID: 's1' }))
  await hooks.event(ev('session.error', { sessionID: 's1' }))
  await hooks.event(ev('session.status', { sessionID: 's1', status: { type: 'idle' } }))
  await hooks.event(ev('session.idle', { sessionID: 's1' }))
  expect(states()).toEqual(['idle', 'idle', 'error'])
  await hooks['chat.message']({ sessionID: 's1' })
  await hooks.event(ev('session.idle', { sessionID: 's1' }))
  expect(states()).toEqual(['idle', 'idle', 'error', 'working', 'idle'])
  await hooks.event(ev('session.error', { sessionID: 's1' }))
  await hooks.event(ev('session.status', { sessionID: 's1', status: { type: 'busy' } }))
  await hooks.event(ev('session.idle', { sessionID: 's1' }))
  await hooks.event(ev('session.error', { sessionID: 's1' }))
  await hooks['tool.execute.before']({ sessionID: 's1' })
  await hooks.event(ev('session.idle', { sessionID: 's1' }))
  expect(states().slice(5)).toEqual(['error', 'working', 'idle', 'error', 'working', 'idle'])
})

test('outside an hc terminal the plugin does nothing', async () => {
  const { hooks, states } = await load({ HC_TERMINAL_ID: undefined })
  expect(hooks).toEqual({})
  expect(states()).toEqual([])
})

test('the plugin writes to /dev/tty unless HC_STATUS_TTY says otherwise', async () => {
  expect((await load({ HC_TERMINAL_ID: 't9' })).written.map(w => w.path)).toEqual(['/dev/tty'])
  expect((await load({ HC_TERMINAL_ID: 't9', HC_STATUS_TTY: '/x' })).written.map(w => w.path)).toEqual(['/x'])
})

// What hc and ps answer for a terminal whose program, started as `cmd`, has pid 100. hc gives what it started,
// the login-shell form, and ps what runs after the exec.
const LOGIN_SHELL = ['/bin/zsh', '-ilc', 'exec "$@"', 'zsh', '/usr/bin/env', 'A=b']
const answers = (cmd: string[], root: Record<string, unknown> = { pid: 100 }) => {
  const asked: string[] = []
  const run = (tool: string, args: string[]) => {
    if (tool === 'hc') return JSON.stringify({ address: 't9', argv: [...LOGIN_SHELL, ...cmd], ...root })
    asked.push(args[1]!)
    if (Number(args[3]) !== 100) throw new Error(`no process ${args[3]}`)
    return args[1] === 'comm=' ? `${cmd[0]}\n` : args[1] === 'tty=' ? 'ttys013\n' : `${cmd.join(' ')}\n`
  }
  return { run, asked }
}

test("a nested opencode (not the terminal's own program) reports nothing and adds no hooks", async () => {
  const { run } = answers(['claude'])
  const { hooks, written } = await load({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 150 }, run)
  expect(hooks).toEqual({})
  expect(written).toEqual([])
})

test("opencode reports when it is the terminal's own program, and needs no ps for that", async () => {
  const { run, asked } = answers(['claude'])
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 100, ppid: 1 }, run)).states()).toEqual(['idle'])
  expect(asked).toEqual([])
})

test("opencode 2's server reports below its own program, however that was installed", () => {
  for (const program of [
    'opencode',
    '/home/t/.opencode/bin/opencode',
    '/home/my tools/opencode',
    '/home/t/node_modules/opencode-ai/bin/opencode.exe',
  ]) {
    const { run } = answers([program, '--standalone'])
    expect(loadV2({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 100 }, run).states()).toEqual(['idle'])
  }
})

test('an agent that starts opencode as its direct child reports nothing, whatever its other arguments say', async () => {
  for (const cmd of [
    ['claude', '--model', 'opus'],
    ['claude', 'use opencode to fix it'],
    ['claude', 'opencode'],
    ['claude', '--add-dir', '/home/t/opencode'],
    ['claude', '--add-dir', '/home/t/.config/opencode', '--model', 'opus'],
    ['claude', '--add-dir=/home/t/opencode'],
    ['claude', 'opencode-go/deepseek'],
    ['node', '/home/t/opencode'],
    ['/home/t/opencode/claude'],
    ['/home/t/notopencode'],
    ['opencode-wrapper', 'opencode'],
    ['/bin/zsh'],
  ]) {
    const { run } = answers(cmd)
    const { hooks, written } = await load({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 100 }, run)
    expect(hooks).toEqual({})
    expect(written).toEqual([])
  }
})

test("the server of an opencode 2 an agent started reports nothing and doesn't subscribe", async () => {
  const { run } = answers(['claude'])
  const { dispose, subscribed, written } = loadV2({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 150 }, run)
  await settled()
  expect(dispose).toBeUndefined()
  expect(subscribed()).toBe(false)
  expect(written).toEqual([])
})

test("an opencode below the terminal's opencode but not its child reports nothing", async () => {
  // A background server left by a terminal: its parent is pid 1.
  const orphan = await load({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 1 }, answers(['opencode']).run)
  expect(orphan.written).toEqual([])
  // A shell in between: the worker's own bash tool, say.
  const shell = await load({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 150 }, answers(['opencode']).run)
  expect(shell.written).toEqual([])
})

test('when hc or ps cannot tell, opencode still starts and reports', async () => {
  const boom = () => {
    throw new Error('no hc')
  }
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 2, ppid: 1 }, boom)).states()).toEqual(['idle'])
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 2, ppid: 1 }, () => 'not json')).states()).toEqual(['idle'])
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 2, ppid: 1 }, () => '{}')).states()).toEqual(['idle'])
  const noPs = answers(['claude'], { pid: 99 })
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 99 }, noPs.run)).states()).toEqual(['idle'])
  const blank = answers([''])
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 100 }, blank.run)).states()).toEqual(['idle'])
})

test("opencode 2's events map to states, and it reports idle on load", async () => {
  const { dispose, emit, states, stopped } = loadV2({ HC_TERMINAL_ID: 't9' })
  expect(states()).toEqual(['idle'])
  await emit(
    ['session.created', { sessionID: 's1' }],
    ['session.execution.started', { sessionID: 's1' }],
    ['permission.asked', { sessionID: 's1', id: 'p' }],
    ['permission.replied', { sessionID: 's1', requestID: 'p', reply: 'once' }],
    ['form.created', { form: { id: 'f', sessionID: 's1', metadata: { kind: 'question' } } }],
    ['form.replied', { id: 'f', sessionID: 's1', answer: {} }],
    ['session.execution.succeeded', { sessionID: 's1' }],
    ['session.execution.started', { sessionID: 's1' }],
    ['form.created', { form: { id: 'g', sessionID: 's1' } }],
    ['form.cancelled', { id: 'g', sessionID: 's1' }],
    ['session.execution.interrupted', { sessionID: 's1', reason: 'user' }],
    ['session.usage.updated', { sessionID: 's1' }],
    ['session.execution.failed', { sessionID: 's1' }],
    ['session.execution.succeeded', { sessionID: 's1' }],
  )
  expect(states()).toEqual([
    'idle',
    'working',
    'blocked:kind=permission',
    'working',
    'blocked:kind=question',
    'working',
    'idle',
    'working',
    'blocked:kind=question',
    'working',
    'idle',
    'error',
  ])
  expect(stopped()).toBe(false)
  dispose!()
  await settled()
  expect(stopped()).toBe(true)
})

test("in opencode 2 a subagent's session only counts for a permission or question it asks", async () => {
  const { emit, states } = loadV2({ HC_TERMINAL_ID: 't9' })
  await emit(
    ['session.created', { sessionID: 'kid', parentID: 's1' }],
    ['session.execution.started', { sessionID: 'kid' }],
    ['session.execution.succeeded', { sessionID: 'kid' }],
    ['session.execution.interrupted', { sessionID: 'kid' }],
    ['session.execution.failed', { sessionID: 'kid' }],
  )
  expect(states()).toEqual(['idle'])
  await emit(
    ['permission.asked', { sessionID: 'kid' }],
    ['permission.replied', { sessionID: 'kid' }],
    ['form.created', { form: { sessionID: 'kid' } }],
    ['form.replied', { sessionID: 'kid' }],
    ['form.created', { form: { sessionID: 'kid' } }],
    ['form.cancelled', { sessionID: 'kid' }],
  )
  expect(states()).toEqual([
    'idle',
    'blocked:kind=permission',
    'working',
    'blocked:kind=question',
    'working',
    'blocked:kind=question',
    'working',
  ])
})

test("outside an hc terminal (opencode 2's shared server) setup does nothing", async () => {
  const { dispose, subscribed, written } = loadV2({ HC_TERMINAL_ID: undefined })
  await settled()
  expect(dispose).toBeUndefined()
  expect(subscribed()).toBe(false)
  expect(written).toEqual([])
})

// The --standalone server: hc says its parent is the terminal's opencode, and /dev/tty is refused. `ttys` is what
// each `ps -o tty=` does in turn (the last one repeats): an answer, or an error if it is null. `at(ms)` sets the time.
function noTty(ttys: (string | null)[], refused: string[] = []) {
  const asked: string[][] = []
  let time = 1_000_000
  const run = (cmd: string, args: string[]) => {
    if (cmd === 'hc') return JSON.stringify({ pid: 100, argv: [...LOGIN_SHELL, 'opencode', '--standalone'] })
    if (args[1] === 'comm=') return 'opencode\n'
    asked.push(args)
    const answer = ttys[Math.min(asked.length, ttys.length) - 1]
    if (answer === null || answer === undefined) throw new Error('ps failed')
    return answer
  }
  const worker = loadV2({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 100, now: () => time }, run, ['/dev/tty', ...refused])
  return {
    ...worker,
    asked,
    at: (ms: number) => (time = 1_000_000 + ms),
    work: () => worker.emit(['session.execution.started', { sessionID: 's1' }]),
  }
}

test('with no /dev/tty (the --standalone server) reports go to the terminal of its parent', async () => {
  const w = noTty(['ttys013\n'])
  await w.work()
  expect(w.written.map(x => x.path)).toEqual(['/dev/ttys013', '/dev/ttys013'])
  expect(w.asked).toEqual([['-o', 'tty=', '-p', '100']])
})

test('a ps that keeps failing is asked once a minute, not on every event, and a later good answer is used', async () => {
  const w = noTty([null, null, 'ttys013\n'])
  await w.work()
  await w.work()
  expect(w.asked).toHaveLength(1)
  expect(w.written).toEqual([])
  w.at(59_999)
  await w.work()
  expect(w.asked).toHaveLength(1)
  w.at(60_000)
  await w.work()
  expect(w.asked).toHaveLength(2)
  expect(w.written).toEqual([])
  w.at(120_000)
  await w.work()
  w.at(120_001)
  await w.work()
  expect(w.asked).toHaveLength(3)
  expect(w.written.map(x => x.path)).toEqual(['/dev/ttys013', '/dev/ttys013'])
})

test('an answer that is no terminal is not kept as the path, and a later good one is used', async () => {
  for (const none of ['', '??\n', '?\n', '-\n']) {
    const w = noTty([none, 'pts/3\n'])
    await w.work()
    expect(w.written).toEqual([])
    w.at(60_000)
    await w.work()
    w.at(60_001)
    await w.work()
    expect(w.asked).toHaveLength(2)
    expect(w.written.map(x => x.path)).toEqual(['/dev/pts/3', '/dev/pts/3'])
  }
})

test('a terminal that refuses the write is asked about again a minute later', async () => {
  const w = noTty(['ttys013\n', 'ttys014\n'], ['/dev/ttys013'])
  await w.work()
  expect(w.written).toEqual([])
  w.at(60_000)
  await w.work()
  expect(w.written.map(x => x.path)).toEqual(['/dev/ttys014'])
})

test('with neither terminal a report is dropped and opencode carries on', async () => {
  const boom = () => {
    throw new Error('no ps')
  }
  const noParent = loadV2({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 100 }, boom, ['/dev/tty'])
  await noParent.emit(['session.execution.started', { sessionID: 's1' }])
  expect(noParent.written).toEqual([])
  // An HC_STATUS_TTY that fails is not replaced.
  const asked: string[] = []
  const given = loadV2(
    { HC_TERMINAL_ID: 't9', HC_STATUS_TTY: '/x' },
    {},
    (cmd: string) => {
      asked.push(cmd)
      return cmd === 'ps' ? 'ttys013' : '{}'
    },
    ['/x'],
  )
  expect(given.written).toEqual([])
  expect(asked).toEqual(['hc'])
})

test('the file written for opencode is plain JavaScript made from the plugin function', () => {
  expect(OPENCODE_PLUGIN).toContain(hcStatusPlugin.toString())
  expect(OPENCODE_PLUGIN).not.toMatch(/: any\b/)
  expect(OPENCODE_PLUGIN).toMatch(/const plugin = hcStatusPlugin\(fs, process\.env, \{ pid: process\.pid, ppid: process\.ppid \}, /)
  expect(OPENCODE_PLUGIN).toContain(']7501;state=')
})

// opencode 2 refuses a plugin whose default export has no `id` and `setup`, and opencode 1 reads `server`.
test('the file exports both entries from the plugin as its default', () => {
  expect(OPENCODE_PLUGIN).toContain('export default { id: "hc.status", ...plugin };')
  const plugin = hcStatusPlugin({}, {})
  expect(typeof plugin.server).toBe('function')
  expect(typeof plugin.setup).toBe('function')
})
