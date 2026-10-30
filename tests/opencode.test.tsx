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

// Loads the plugin with a fake `fs`: what it writes in place of /dev/tty is recorded.
async function load(env: Record<string, string | undefined>, proc: any = {}, run: any = null) {
  const written: { path: string; text: string }[] = []
  const fs = { appendFileSync: (path: string, text: string) => void written.push({ path, text }) }
  const hooks = await hcStatusPlugin(fs, env, proc, run)()
  const states = () =>
    written.map(w => {
      const m = w.text.match(/^\x1b\]7501;state=(.+):app=opencode\x1b\\$/)
      expect(m).not.toBeNull()
      return m![1]!
    })
  return { hooks: hooks as any, states, written }
}
const ev = (type: string, properties: Record<string, unknown> = {}) => ({ event: { type, properties } })

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

const hcGet = (pid: unknown) => () => JSON.stringify({ address: 't9', pid })

test("a nested opencode (not the terminal's own program) reports nothing and adds no hooks", async () => {
  const { hooks, written } = await load({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 150 }, hcGet(100))
  expect(hooks).toEqual({})
  expect(written).toEqual([])
})

test("opencode reports when hc says it is the terminal's program, or its launcher is", async () => {
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 100, ppid: 1 }, hcGet(100))).states()).toEqual(['idle'])
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 200, ppid: 100 }, hcGet(100))).states()).toEqual(['idle'])
})

test('when hc cannot tell, opencode still starts and reports', async () => {
  const boom = () => {
    throw new Error('no hc')
  }
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 2, ppid: 1 }, boom)).states()).toEqual(['idle'])
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 2, ppid: 1 }, () => 'not json')).states()).toEqual(['idle'])
  expect((await load({ HC_TERMINAL_ID: 't9' }, { pid: 2, ppid: 1 }, () => '{}')).states()).toEqual(['idle'])
})

test('the file written for opencode is plain JavaScript made from the plugin function', () => {
  expect(OPENCODE_PLUGIN).toContain(hcStatusPlugin.toString())
  expect(OPENCODE_PLUGIN).not.toMatch(/: any\b/)
  expect(OPENCODE_PLUGIN).toMatch(
    /export const HcStatusPlugin = hcStatusPlugin\(fs, process\.env, \{ pid: process\.pid, ppid: process\.ppid \}, /,
  )
  expect(OPENCODE_PLUGIN).toContain(']7501;state=')
})
