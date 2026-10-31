import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findId, textOf } from './fake-gpui.mjs'

// A Linux box and a Mac, as `READ_SCRIPT` prints them.
const LINUX = (cpu = 'cpu  4705 150 3120 80000 200 0 45 0 0 0') =>
  [
    'Linux',
    '--cpu',
    cpu,
    '--mem',
    'MemTotal:       16000000 kB',
    'MemAvailable:   11200000 kB',
    '--disk',
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/sda1        100000000  47000000  53000000      47% /',
  ].join('\n')
const MAC = [
  'Darwin',
  '--cpu',
  '      cpu    load average',
  ' us sy id   1m   5m   15m',
  ' 19  9 72  62.09 43.04 29.40',
  ' 33 25 42  62.09 43.04 29.40',
  '--mem',
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                    12249.',
  'Pages active:                                 460082.',
  'Pages inactive:                               455108.',
  'Pages speculative:                              4408.',
  'Pages throttled:                                   0.',
  'Pages wired down:                             229204.',
  'Pages purgeable:                                7251.',
  '"Translation faults":                    14308844874.',
  '25769803776',
  '--disk',
  'Filesystem   1024-blocks      Used Available Capacity  Mounted on',
  '/dev/disk3s1   482797652 395786524  62276292    87%    /System/Volumes/Data',
].join('\n')

const m = await import('../mods/herdr-agents/machinestats.js')

test('Linux: /proc/stat gives a CPU figure only from the second read, as a delta', () => {
  const first = m.readFigures(LINUX(), null)
  assert.equal(first.cpu, null)
  assert.equal(m.statsLine(first), 'RAM 30%  Disk 47%')
  // 1000 more jiffies, 250 of them busy.
  const second = m.readFigures(LINUX('cpu  4855 150 3220 80750 200 0 45 0 0 0'), first.counters)
  assert.equal(second.cpu, 25)
  assert.equal(m.statsLine(second), 'CPU 25%  RAM 30%  Disk 47%')
  assert.equal(m.cpuBetween(first.counters, first.counters), null, 'no time went by')
})

test('macOS: the second iostat sample, vm_stat and the data volume', () => {
  const f = m.readFigures(MAC, null)
  assert.equal(f.cpu, 58)
  assert.equal(f.ram, 70)
  assert.equal(f.disk, 86)
  assert.equal(m.statsLine(f), 'CPU 58%  RAM 70%  Disk 86%')
  assert.equal(f.counters, null)
})

test('a figure that cannot be read is left out, and no figure gives no line', () => {
  const noMem = MAC.replace(/Pages free:.*\n/, '')
  assert.equal(m.statsLine(m.readFigures(noMem, null)), 'CPU 58%  Disk 86%')
  assert.equal(m.statsLine({ cpu: null, ram: null, disk: null }), '')
  assert.equal(m.readFigures('Windows_NT\n--cpu\n', null), null)
  assert.equal(m.readFigures('', null), null)
  assert.equal(m.parseDf('df: /: No such file'), null)
  assert.equal(m.parseMeminfo('MemTotal: 0 kB\nMemAvailable: 0 kB'), null)
})

test('a read shows 0 and 100 as they are', () => {
  assert.equal(m.statsLine({ cpu: 0, ram: 100, disk: 5 }), 'CPU 0%  RAM 100%  Disk 5%')
})

const fakeExec = outputs => {
  const log = { calls: [], running: 0, peak: 0 }
  const exec = async (cmd, args, opts) => {
    log.calls.push([cmd, args[0], opts.on])
    log.running++
    log.peak = Math.max(log.peak, log.running)
    await new Promise(r => setImmediate(r))
    log.running--
    const out = outputs[opts.on ?? ''] ?? null
    if (out instanceof Error) throw out
    return { code: 0, stdout: typeof out === 'function' ? out() : out, stderr: '' }
  }
  return { exec, log }
}

test('reads run on the machine asked for, and a second read of a Linux box has its CPU', async () => {
  let n = 0
  const { exec, log } = fakeExec({
    '': MAC,
    box: () => (n++ ? LINUX('cpu  4855 150 3220 80750 200 0 45 0 0 0') : LINUX()),
  })
  const s = new m.MachineStats(exec)
  assert.equal(await s.readAll([null, 'box']), true)
  assert.deepEqual(log.calls.map(c => c[2]).sort(), [null, 'box'].sort())
  assert.equal(s.line(null), 'CPU 58%  RAM 70%  Disk 86%')
  assert.equal(s.line('box'), 'RAM 30%  Disk 47%')
  assert.equal(await s.readAll([null, 'box']), true, 'the box now has a CPU figure')
  assert.equal(s.line('box'), 'CPU 25%  RAM 30%  Disk 47%')
})

test('a poll that reads the same numbers asks for no redraw', async () => {
  const { exec } = fakeExec({ '': MAC })
  const s = new m.MachineStats(exec)
  assert.equal(await s.readAll([null]), true)
  let redraws = 0
  for (let i = 0; i < 20; i++) if (await s.readAll([null])) redraws++
  assert.equal(redraws, 0)
})

test('no overlapping reads per machine', async () => {
  const { exec, log } = fakeExec({ '': MAC })
  const s = new m.MachineStats(exec)
  await Promise.all([s.read(null), s.read(null), s.read(null)])
  assert.equal(log.calls.length, 1)
  assert.equal(log.peak, 1)
  assert.equal(s.busy.size, 0)
})

test('a failed read or a machine that is gone shows no line, and the CPU starts over', async () => {
  let fail = false
  const { exec } = fakeExec({ box: () => LINUX() })
  const flaky = async (...a) => {
    if (fail) throw new Error('machine away')
    return exec(...a)
  }
  const s = new m.MachineStats(flaky)
  await s.readAll(['box'])
  assert.equal(s.line('box'), 'RAM 30%  Disk 47%')
  fail = true
  assert.equal(await s.readAll(['box']), true, 'the line went')
  assert.equal(s.line('box'), '')
  assert.equal(s.counters.box, undefined)
  fail = false
  await s.readAll(['box'])
  assert.equal(await s.readAll([]), true, 'a machine not connected is forgotten')
  assert.equal(s.line('box'), '')
  assert.deepEqual(s.counters, {})
})

// The Spaces list, drawn with a stand-in for the app.
const { app } = await import('./fake-gpui.mjs')
const fake = globalThis.__fakeGpui
const colors = {
  chrome: '#101010',
  border: '#202020',
  dim: '#303030',
  hover: '#404040',
  selected: '#505050',
  raised: '#606060',
  foreground: '#ffffff',
  muted: '#707070',
  accent: '#808080',
  ansi1: '#810000',
  ansi2: '#008100',
  ansi3: '#818100',
  ansi4: '#000081',
  ansi5: '#810081',
  ansi6: '#008181',
  unknown: '#909090',
  working: '#a0a0a0',
}
fake.theme = () => colors
fake.v_flex = fake.div
fake.h_flex = fake.div
const both = [
  { id: 's1', name: 'one', machine: null, tabs: [], active: true },
  { id: 's2', name: 'two', machine: 'box', tabs: [], active: false },
]
let open = both
fake.spaces = () => open
fake.panes = () => []
fake.machines = () => [{ name: 'box', layout: 'ready' }]
let active = true
fake.window = () => ({ active })
let railPx = 268
fake.layout = () => ({ id: 'sidebar', size: { px: railPx } })
let known = [{ name: 'box', state: 'connected' }]
fake.hc = async () => ({ code: 0, stdout: JSON.stringify({ machines: known }), stderr: '' })
fake.watchFolder = () => new Promise(() => {})
fake.exec = async (cmd, args, o) => ({ code: 0, stdout: o.on === 'box' ? LINUX() : MAC, stderr: '' })
globalThis.localStorage ??= { getItem: () => null, setItem() {} }
const { SpacesList } = await import('../mods/herdr-agents/spaces.js')

function started() {
  const timers = []
  const jobs = []
  const cx = {
    notified: 0,
    notify() {
      cx.notified++
    },
    timer: { every() {}, after: (ms, fn) => timers.push({ ms, fn }) },
    ticks: () => timers.filter(t => t.ms === m.POLL_MS),
    spawn: fn => jobs.push(fn(cx)),
  }
  const list = new SpacesList()
  list.init(cx)
  return { list, cx, timers, jobs }
}

test('the Spaces list draws a dim line under each connected machine header, not in the rail', async () => {
  const { list, cx, jobs } = started()
  await Promise.all(jobs.splice(0))
  await Promise.all(jobs.splice(0)) // the stats poll started once the machines were known
  assert.ok(cx.notified > 0)
  const t = fake.theme()
  const rows = list.grouped(t, false)
  assert.equal(rows.length > 0, true)
  assert.deepEqual(rows.map(r => r.node.calls.id[0]).slice(0, 3), ['machine-local', 'machine-stats-local', 'space-s1'])
  assert.deepEqual(textOf(rows[1]), ['CPU 58%  RAM 70%  Disk 86%'])
  assert.equal(rows[1].node.calls.text_color[0], t.dim)
  assert.ok(rows.some(r => r.node.calls.id[0] === 'machine-stats-box'))
  const rail = list.grouped(t, true)
  assert.equal(
    rail.some(r => String(r.node.calls.id?.[0]).startsWith('machine-stats')),
    false,
  )
})

test('a machine that is not connected has no stats row, and the polling timer is one one-shot at a time', async () => {
  const { list, timers, jobs } = started()
  await Promise.all(jobs.splice(0))
  await Promise.all(jobs.splice(0))
  assert.equal(timers.filter(t => t.ms === m.POLL_MS).length, 1, 'one timer waiting')
  list.machines = [{ name: 'box', state: 'asleep' }]
  assert.deepEqual(list.statsTargets(), [null])
  await list.stats.readAll(list.statsTargets())
  const ids = list.grouped(fake.theme(), false).map(r => r.node.calls.id?.[0])
  assert.equal(ids.includes('machine-stats-box'), false)
  assert.equal(ids.includes('machine-stats-local'), true)
})

test('polling with the same numbers redraws nothing', async () => {
  const { list, cx, timers, jobs } = started()
  await Promise.all(jobs.splice(0))
  await Promise.all(jobs.splice(0))
  const before = cx.notified
  for (let i = 0; i < 5; i++) {
    timers
      .splice(
        timers.findIndex(t => t.ms === m.POLL_MS),
        1,
      )[0]
      .fn(cx)
    await Promise.all(jobs.splice(0))
  }
  assert.equal(cx.notified, before)
  assert.equal(timers.filter(t => t.ms === m.POLL_MS).length, 1)
  assert.ok(list.stats.line('box'))
})

test('with no other machine there is no header and nothing is read', async () => {
  open = [both[0]]
  known = []
  try {
    const { list, jobs } = started()
    await Promise.all(jobs.splice(0))
    assert.deepEqual(list.statsTargets(), [])
    const ids = list.grouped(fake.theme(), false).map(r => r.node.calls.id?.[0])
    assert.deepEqual(ids, ['space-s1'])
  } finally {
    open = both
    known = [{ name: 'box', state: 'connected' }]
  }
})

// Blocker 1: a read that never answers.
test('a read that never answers is given up on after the limit, and a late answer is ignored', async () => {
  const late = []
  let hang = true
  const exec = (cmd, args, o) =>
    o.on === 'box' && hang
      ? new Promise(res => late.push(res))
      : Promise.resolve({ code: 0, stdout: o.on === 'box' ? LINUX() : MAC, stderr: '' })
  const s = new m.MachineStats(exec)
  const timers = []
  const after = (ms, fn) => timers.push({ ms, fn })
  let changes = 0
  const done = s.poll([null, 'box'], () => changes++, after)
  await new Promise(r => setImmediate(r))
  assert.equal(s.line(null), 'CPU 58%  RAM 70%  Disk 86%', 'the other machine is not held')
  assert.ok(s.busy.has('box'))
  assert.equal(timers.filter(t => t.ms === m.READ_LIMIT_MS).length, 2, 'each read has a time limit')
  for (const t of timers) t.fn()
  await done
  assert.equal(s.busy.has('box'), false, 'free to be read again')
  hang = false
  await s.read('box', after)
  assert.equal(s.line('box'), 'RAM 30%  Disk 47%')
  late[0]({ code: 0, stdout: 'Linux\n--cpu\n--mem\n--disk\n', stderr: '' })
  await new Promise(r => setImmediate(r))
  assert.equal(s.line('box'), 'RAM 30%  Disk 47%', 'the late answer changed nothing')
})

// Blocker 2: the compact rail and a window in the background.
async function ticked(setup) {
  const calls = []
  try {
    const { list, cx, timers, jobs } = started()
    const orig = list.stats.exec
    list.stats.exec = async (...a) => (calls.push(a), orig(...a))
    await Promise.all(jobs.splice(0))
    await Promise.all(jobs.splice(0))
    calls.length = 0
    const before = cx.notified
    setup(list)
    list.stats.lines = {}
    timers
      .splice(
        timers.findIndex(t => t.ms === m.POLL_MS),
        1,
      )[0]
      .fn(cx)
    await Promise.all(jobs.splice(0))
    return { calls: calls.length, redraws: cx.notified - before, timers: timers.filter(t => t.ms === m.POLL_MS).length }
  } finally {
    railPx = 268
    active = true
  }
}

test('a compact rail reads nothing and redraws nothing, and the timer keeps going', async () => {
  const r = await ticked(() => (railPx = 60))
  assert.deepEqual(r, { calls: 0, redraws: 0, timers: 1 })
  const ok = await ticked(() => {})
  assert.ok(ok.calls > 0 && ok.redraws > 0, 'the same tick with the full rail does read')
})

test('a window in the background reads nothing and redraws nothing, and the timer keeps going', async () => {
  const r = await ticked(() => (active = false))
  assert.deepEqual(r, { calls: 0, redraws: 0, timers: 1 })
})
