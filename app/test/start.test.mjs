// What a copy of the mod clears when it starts, through main.js itself: a real app start clears, a layout switch or a hot
// reload (a new copy, same run) does not. Its own stand-ins, because main.js pulls in every part of the mod.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { beforeEach, test } from 'node:test'

const state = { props: null, store: {}, closed: [], reads: [], file: null }
globalThis.__startFake = {
  View: class {},
  Popup: { new: () => globalThis.__startFake.div() },
  appHome: () => '/home',
  // Chains anything; records the text it is given.
  div: () => {
    const el = new Proxy(
      { kids: [] },
      {
        get: (t, name) => {
          if (name === 'kids') return t.kids
          if (name === 'when') return (cond, f) => (cond ? f(el) : el)
          if (name === 'child') return kid => (t.kids.push(kid), el)
          return () => el
        },
      },
    )
    return el
  },
  readTextFile: async path => {
    state.reads.push(path)
    return state.file
  },
  theme: () => ({ chrome: '#101010', border: '#202020', dim: '#303030' }),
  Input: {},
  InputState: {},
  closeOverlay: id => state.closed.push(id),
  focused: () => {
    if (state.focusThrows) throw new Error('boom')
    return state.focused ?? null
  },
  terminals: () => {
    if (state.drawThrows) throw new Error('boom')
    return state.terminals ?? []
  },
  settings: () => ({}),
  hc: async () => ({ code: 1, stdout: '' }),
  writeTextFile: async (_path, text) => {
    state.beats.push(JSON.parse(text))
  },
  run: (name, args) => state.ran?.push([name, args]),
  home: () => '/home',
  exec: async (_cmd, args) => {
    await state.boardsGate
    return { code: 0, stdout: args[0] === '-1' ? state.listing : '', stderr: '' }
  },
  watchFolder: () => new Promise(wake => (state.wake = wake)),
  nextCommand: () => state.commands.shift() ?? new Promise(() => {}),
  openOverlay: o => {
    state.opened = o
    return 'o4'
  },
  props: () => state.props,
  shared: k => state.store[k],
  setShared: (k, v) => {
    state.store[k] = v
  },
}
const shim = {
  'gpui-kit': ['View', 'div', 'image', 'svg'],
  'gpui-base': ['Input', 'InputState', 'Popup', 'TextView', 'h_flex', 'v_flex'],
  herdr: [
    'agents',
    'appHome',
    'closeOverlay',
    'exec',
    'focused',
    'hc',
    'home',
    'layout',
    'machines',
    'nextCommand',
    'notify',
    'openOverlay',
    'panes',
    'playSound',
    'props',
    'readTextFile',
    'run',
    'setAgentOrder',
    'setShared',
    'settings',
    'shared',
    'spaces',
    'terminals',
    'theme',
    'watchFolder',
    'window',
    'writeTextFile',
  ],
}
registerHooks({
  resolve: (specifier, context, next) => (shim[specifier] ? { url: `start:${specifier}`, shortCircuit: true } : next(specifier, context)),
  load(url, context, next) {
    if (!url.startsWith('start:')) return next(url, context)
    const source = shim[url.slice('start:'.length)].map(n => `export const ${n} = globalThis.__startFake.${n};`).join('\n')
    return { format: 'module', source, shortCircuit: true }
  },
})

const { AGE_TICK_MS } = await import('../mods/herdr-agents/model.js')
const { default: HerdrAgents } = await import('../mods/herdr-agents/main.js')
const { openBoardPopup, StripState } = await import('../mods/herdr-agents/strip.js')

const newRun = () => {
  delete globalThis.__hrdStarted
}
const cx = { spawn() {}, notify() {}, focus_handle: () => ({}), timer: { every() {}, after() {} } }
const startCopy = role => {
  state.props = { role }
  new HerdrAgents().init(state.props, cx)
}
const left = () => ({ 'hrd.pins': 'o2', 'hrd.popup': 'o3', 'hrd.doneReq': [{ session: 's', key: 'K1' }], 'hrd.read': { a: true } })
const card = { session: 's', key: 'D1' }

beforeEach(() => {
  state.beats = []
  state.drawThrows = false
  state.focusThrows = false
  state.terminals = []
  state.store = {}
  state.closed = []
  newRun()
})

test('the pin bar copy clears what the last run left, on the first start of a run', () => {
  state.store = left()
  startCopy('pinbar')
  assert.deepEqual(state.store, { 'hrd.pins': null, 'hrd.popup': null, 'hrd.doneReq': null, 'hrd.read': { a: true } })
})

test('a pin bar copy started again in the same run keeps open overlays and a queued Done', () => {
  startCopy('pinbar')
  state.store = left()
  startCopy('pinbar')
  assert.deepEqual(state.store, left())
})

test('the next run clears again', () => {
  startCopy('pinbar')
  newRun()
  state.store = left()
  startCopy('pinbar')
  assert.equal(state.store['hrd.pins'], null)
  assert.equal(state.store['hrd.doneReq'], null)
})

test('the strip copy (it draws the card) forgets a card left open by the last run, on the first start of a run', () => {
  state.store = { 'hrd.open': card, 'hrd.pick': card }
  startCopy('strip')
  assert.deepEqual(state.store, { 'hrd.open': null, 'hrd.pick': null })
})

test('a strip copy started again in the same run keeps the open card', () => {
  startCopy('strip')
  state.store = { 'hrd.open': card, 'hrd.pick': card }
  startCopy('strip')
  assert.deepEqual(state.store, { 'hrd.open': card, 'hrd.pick': card })
})

test('the first copies of a run clear their own keys, whichever starts first', () => {
  state.store = { ...left(), 'hrd.open': card }
  startCopy('strip')
  assert.equal(state.store['hrd.pins'], 'o2', 'the strip leaves the overlay ids to the pin bar')
  startCopy('pinbar')
  assert.equal(state.store['hrd.pins'], null)
})

test('a new strip copy replaces the board pop-up the last copy opened, by its shared id', () => {
  globalThis.window = { viewport_size: () => ({ width: 1280, height: 820 }) }
  state.store = { 'hrd.popup': 'o3' }
  openBoardPopup({ session: 's', items: [] })
  assert.deepEqual(state.closed, ['o3'])
  assert.equal(state.store['hrd.popup'], 'o4')
})

test('the board pop-up remembers the terminal to hand back; a card being replaced decides it', () => {
  globalThis.window = { viewport_size: () => ({ width: 1280, height: 820 }) }
  state.focused = { terminal: 't2', space: 'a' }
  state.store = {}
  openBoardPopup({ session: 's', items: [] })
  assert.equal(state.opened.props.back, 't2')
  assert.equal(state.opened.props.space, 'a')
  state.store = { 'hrd.open': { back: 't1', space: 'b' } }
  openBoardPopup({ session: 's', items: [] })
  assert.equal(state.opened.props.back, 't1')
  state.focused = null
})

test('an overlay copy takes the keyboard after its first draw', async () => {
  const handle = {
    focused: 0,
    focus() {
      this.focused++
    },
  }
  const tasks = []
  state.props = { role: 'pins' }
  new HerdrAgents().init(state.props, { ...cx, focus_handle: () => handle, spawn: f => tasks.push(f) })
  assert.equal(handle.focused, 0)
  await tasks[0]({ sleep: async () => {}, notify() {} })
  assert.equal(handle.focused, 1)
})

test("a pins overlay closed by anything else (a click outside, the app's Esc) still hands the keyboard back", async () => {
  state.props = { role: 'pins', back: 't7', space: 'a' }
  state.focused = { terminal: null, space: 'a' }
  state.ran = []
  const copy = new HerdrAgents()
  copy.init(state.props, cx)
  await copy.close()
  assert.deepEqual(state.ran, [['pane.focus', { terminal: 't7' }]])
  state.focused = null
  state.ran = null
})

const startVersion = async file => {
  state.props = { role: 'version' }
  state.reads = []
  state.file = file
  const spawned = []
  const counts = { notify: 0, timers: 0 }
  const copy = new HerdrAgents()
  const own = {
    notify: () => counts.notify++,
    spawn: f => spawned.push(f),
    timer: { every: () => counts.timers++, after: () => counts.timers++ },
  }
  copy.init(state.props, own)
  await Promise.all(spawned.map(f => f(own)))
  return { copy, counts, spawned }
}

test('the version copy reads its file once, with no timer, no boards and no shared state', async () => {
  const { copy, counts, spawned } = await startVersion('{"version":"1.2.3","commit":"abc1234"}')
  assert.deepEqual(state.reads, ['/home/mods/herdr-agents/version.json'])
  assert.equal(spawned.length, 1)
  assert.equal(counts.timers, 0)
  assert.equal(counts.notify, 1)
  assert.equal(copy.boards, undefined)
  assert.deepEqual(state.store, {})
  assert.equal(copy.render().kids[0].kids[0], 'herdr-agents 1.2.3 · abc1234')
})

test('a version copy with a missing or bad file draws no text and does not redraw', async () => {
  for (const file of [null, 'not json']) {
    const { copy, counts } = await startVersion(file)
    assert.equal(counts.notify, 0)
    assert.deepEqual(copy.render().kids, [])
  }
})

test('before the file is read the version copy draws no text', () => {
  state.props = { role: 'version' }
  assert.deepEqual(new HerdrAgents().render().kids, [])
})

// The timers a copy starts, by interval; `tick` runs its age timer with this copy's own cx.
function startTimed(props) {
  state.props = props
  const every = {}
  const counts = { notify: 0 }
  const own = {
    notify: () => counts.notify++,
    spawn() {},
    focus_handle: () => ({}),
    timer: { every: (ms, f) => (every[ms] = f), after() {} },
  }
  const copy = new HerdrAgents()
  copy.init(state.props, own)
  return { copy, counts, every, tick: () => every[AGE_TICK_MS](own) }
}

test('only the copies that draw ages and have no timer for them start the age timer', () => {
  globalThis.localStorage = { getItem: () => null, setItem() {} }
  for (const role of ['pinbar', 'strip', 'sheet', 'pins', 'board']) assert.ok(startTimed({ role, list: [] }).every[AGE_TICK_MS], role)
  for (const role of ['agents', 'version']) assert.equal(startTimed({ role, session: 's' }).every[AGE_TICK_MS], undefined, role)
})

test('a pins copy on screen redraws when an age moves with the clock, and not within the minute', t => {
  let clock = 1_000_000_000 + 2 * 60_000
  t.mock.method(Date, 'now', () => clock)
  const { copy, counts, tick } = startTimed({ role: 'pins', view: 'list', width: 100, height: 100, list: [{ id: 'a', at: 1_000_000_000 }] })
  copy.render()
  clock += 30_000
  tick()
  assert.equal(counts.notify, 0)
  clock += 30_000
  tick()
  assert.equal(counts.notify, 1)
})

test('the board pop-up redraws when a merge age moves with the clock, and not within the minute', t => {
  const T0 = 1_000_000_000
  let clock = T0 + 2 * 60_000
  t.mock.method(Date, 'now', () => clock)
  const board = {
    session: 's',
    tasks: [
      { key: 'a', pr: 5, isMerged: true, mergedAt: T0 },
      { key: 'b', pr: 6, isMerged: false },
    ],
  }
  const { copy, counts, tick } = startTimed({ role: 'board', session: 's', board, height: 300 })
  copy.render()
  clock += 30_000
  tick()
  assert.equal(counts.notify, 0)
  clock += 30_000
  tick()
  assert.equal(counts.notify, 1)
})

test('the board pop-up with no merged row asks for no redraw as the clock moves', t => {
  let clock = 1_000_000_000
  t.mock.method(Date, 'now', () => clock)
  const board = { session: 's', tasks: [{ key: 'a', pr: 5, isMerged: false }] }
  const { copy, counts, tick } = startTimed({ role: 'board', session: 's', board, height: 300 })
  copy.render()
  clock += 10 * 60_000
  tick()
  assert.equal(counts.notify, 0)
})

test('a closed card or sheet asks for no redraw as the clock moves', t => {
  let clock = 1_000_000_000
  t.mock.method(Date, 'now', () => clock)
  for (const role of ['strip', 'sheet']) {
    const { counts, tick } = startTimed({ role })
    clock += 10 * 60_000
    tick()
    assert.equal(counts.notify, 0, role)
  }
})

test('an open card (drawn by the strip), an open sheet and the pin bar redraw when the age they show moves, and not within the minute', t => {
  const T0 = 1_000_000_000
  let clock = T0 + 2 * 60_000
  t.mock.method(Date, 'now', () => clock)
  const need = { key: 'D1', kind: 'ask', isOpen: true, at: T0 }
  const pin = { key: 'K1', kind: 'know', isOpen: true, at: T0, title: 'p', text: 'p' }
  const board = { session: 's', needs: [need, pin] }
  const copies = {
    strip: startTimed({ role: 'strip' }),
    sheet: startTimed({ role: 'sheet' }),
    pinbar: startTimed({ role: 'pinbar' }),
  }
  state.store['hrd.open'] = { session: 's', key: 'D1' }
  state.store['hrd.sheet'] = { session: 's', key: 'D1' }
  for (const { copy } of Object.values(copies)) copy.boards.files = { s: board }
  copies.pinbar.copy.pin.ui(board, { notify() {}, timer: { after() {} }, spawn() {} })
  for (const [role, { counts, tick, copy }] of Object.entries(copies)) {
    state.props = { role } // props() answers for one copy at a time here
    copy.ages.drawn(copy.agedTimes(), clock)
    clock += 30_000
    tick()
    assert.equal(counts.notify, 0, `${role} within the minute`)
    clock += 30_000
    tick()
    assert.equal(counts.notify, 1, `${role} past the minute`)
    clock -= 60_000
  }
})

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve))
}

// A pins copy with its board reader running; `write` is a board write the watcher reports.
async function startPinsWatch(props) {
  const tasks = []
  const counts = { notify: 0 }
  const own = {
    notify: () => counts.notify++,
    sleep: async () => {},
    focus_handle: () => ({ focus() {} }),
    timer: { every() {}, after() {} },
  }
  state.props = { role: 'pins', session: 's', overlay: 'o9', width: 470, height: 300, back: 't7', space: 'a', ...props }
  state.store['hrd.pins'] = 'o9'
  state.closed = []
  state.file = null
  const copy = new HerdrAgents()
  copy.init(state.props, { ...own, spawn: f => tasks.push(f) })
  const openKeys = keys => JSON.stringify({ session: 's', needs: keys.map(key => ({ key, kind: 'know', isOpen: true, text: key })) })
  const write = async keys => {
    state.file = openKeys(keys)
    state.wake(['/home/.herdr-agents/board/s.json'])
    await settle()
  }
  state.file = openKeys(props.list.map(p => p.key))
  tasks[1](own)
  await settle()
  return { copy, counts, write }
}
const twoPins = [
  { id: 's:K1', key: 'K1', title: 'K1', text: 'K1', at: 0 },
  { id: 's:K2', key: 'K2', title: 'K2', text: 'K2', at: 0 },
]

test('an open popover: its first board read draws nothing new, a resolved pin redraws, an unrelated write does not', async () => {
  const { counts, write } = await startPinsWatch({ view: 'all', list: twoPins })
  assert.equal(counts.notify, 0, 'the first read matches the list it opened with')
  await write(['K1', 'K2', 'K3'])
  assert.equal(counts.notify, 0, 'a change to no pin it lists')
  await write(['K2'])
  assert.equal(counts.notify, 1)
  assert.deepEqual(state.closed, [])
})

test('an open popover closes when its last pin is resolved', async () => {
  const { write } = await startPinsWatch({ view: 'all', list: twoPins })
  await write([])
  assert.deepEqual(state.closed, ['o9'])
  assert.equal(state.store['hrd.pins'], null)
})

test("a watcher closing its overlay hands the keyboard back through the close call, and leaves a newer overlay's id", async () => {
  const { copy, write } = await startPinsWatch({ view: 'all', list: twoPins })
  state.store['hrd.pins'] = 'o10'
  await write([])
  assert.deepEqual(state.closed, ['o9'])
  assert.equal(state.store['hrd.pins'], 'o10')
  state.focused = { terminal: null, space: 'a' }
  state.ran = []
  await copy.close()
  assert.deepEqual(state.ran, [['pane.focus', { terminal: 't7' }]])
  state.focused = null
  state.ran = null
})

test('an open drop panel closes when its pin is resolved, not when another is', async () => {
  const { counts, write } = await startPinsWatch({ view: 'panel', id: 's:K1', list: twoPins })
  await write(['K1'])
  assert.deepEqual(state.closed, [])
  assert.equal(counts.notify, 1)
  await write([])
  assert.deepEqual(state.closed, ['o9'])
})

test('a resolved pin stops counting for the age clock', async () => {
  const { copy, write } = await startPinsWatch({ view: 'all', list: twoPins.map((p, i) => ({ ...p, at: 100 + i })) })
  assert.deepEqual(copy.agedTimes(), [100, 101])
  await write(['K2'])
  assert.deepEqual(copy.agedTimes(), [101])
})

test('commands before the first board read wait for it: the last one then does its job, once', async () => {
  globalThis.window = { viewport_size: () => ({ width: 1280, height: 820 }) }
  let endRead
  state.boardsGate = new Promise(resolve => (endRead = resolve))
  state.props = { role: 'strip' }
  state.opened = null
  state.listing = 's.json'
  state.commands = [Promise.resolve('herdr-agents.pick1'), Promise.resolve('herdr-agents.board')]
  state.terminals = [{ address: 't1', state: 'live', program: { agent: true } }]
  state.focused = { terminal: 't1', space: 'a' }
  state.file = JSON.stringify({ session: 's', coordinator: { terminal: 't1' }, needs: [], tasks: [] })
  const own = { notify() {}, sleep: async () => {}, focus_handle: () => ({}), timer: { every() {}, after() {} }, spawn: f => f(own) }
  new HerdrAgents().init(state.props, own)
  await settle()
  assert.equal(state.opened, null, 'no board yet')
  endRead()
  await settle()
  assert.equal(state.opened?.props?.session, 's', 'the pop-up opened on the board just read')
  state.opened = null
  await settle()
  assert.equal(state.opened, null, 'once')
  state.focused = null
  state.boardsGate = null
})

test('later reads run nothing and leave the board to the draw; a command then runs at once', async () => {
  globalThis.window = { viewport_size: () => ({ width: 1280, height: 820 }) }
  state.opened = null
  const own = { notify() {}, spawn: f => f(own) }
  const part = new StripState()
  part.onBoardsRead(own, () => ({ session: 's' }))
  assert.equal(state.opened, null, 'nothing waited')
  part.onBoardsRead(own, () => ({ session: 'other' }))
  assert.equal(part.board.session, 's')
  state.commands = [Promise.resolve('herdr-agents.board')]
  part.listen(own)
  await settle()
  assert.equal(state.opened.props.session, 's')
})

test('a command with no board after the first read opens nothing', async () => {
  state.opened = null
  const own = { notify() {}, spawn: f => f(own) }
  const part = new StripState()
  part.waiting = 'herdr-agents.board'
  part.onBoardsRead(own, () => null)
  await settle()
  assert.equal(state.opened, null)
  assert.equal(part.waiting, null, 'it does not fire later, when a board appears')
})

test('the waiting command runs as its own task: its failure does not reach the board reader', async () => {
  const tasks = []
  const own = { notify() {}, spawn: f => tasks.push(f) }
  const part = new StripState()
  part.waiting = 'herdr-agents.board'
  part.command = () => {
    throw new Error('command failed')
  }
  assert.doesNotThrow(() => part.onBoardsRead(own, () => ({ session: 's' })))
  assert.equal(tasks.length, 1)
  await assert.rejects(tasks[0](own), /command failed/)
})

// A draw that throws: the copy runs the spawned note like the app does, and writes counts the setShared calls.
const failKey = role => `hrd.drawFailed.${role}`
const drawCx = () => {
  const pending = []
  const c = { ...cx, sleep: async () => {}, spawn: f => pending.push(f(c)), notify() {} }
  c.settle = async () => {
    while (pending.length) await pending.shift()
  }
  return c
}
const drawCopy = role => {
  state.props = { role }
  const c = drawCx()
  const copy = new HerdrAgents()
  copy.init(state.props, cx) // the boards' and keys' own loops stay out of it
  return { copy, c, draw: async () => (copy.render(c), await c.settle()) }
}
const live = () => {
  state.terminals = [{ address: 't1', state: 'live', program: { agent: true } }]
}

for (const role of ['strip', 'pinbar']) {
  test(`a ${role} that throws records it and draws nothing; a later good draw clears it`, async () => {
    const { draw } = drawCopy(role)
    state.drawThrows = true
    await draw()
    assert.equal(state.store[failKey(role)], 'boom')
    state.drawThrows = false
    await draw()
    assert.equal(state.store[failKey(role)], null)
  })
}

test('a part that keeps failing or keeps drawing writes nothing again, so it starts no redraws', async () => {
  const { draw } = drawCopy('strip')
  let writes = 0
  const real = state.store
  state.store = new Proxy(real, {
    set(t, k, v) {
      writes++
      t[k] = v
      return true
    },
  })
  await draw()
  await draw()
  assert.equal(writes, 0, 'good draws are silent')
  state.drawThrows = true
  await draw()
  await draw()
  assert.equal(writes, 1, 'one write for the failure')
})

test('a draw that changes nothing spawns no task and sleeps no sleep(0)', async () => {
  const { copy, c } = drawCopy('strip')
  let spawns = 0
  let sleeps = 0
  const { spawn } = c
  c.spawn = f => (spawns++, spawn(f))
  c.sleep = async () => void sleeps++
  const draw = async () => (copy.render(c), await c.settle())
  await draw()
  assert.deepEqual([spawns, sleeps], [0, 0], 'a good draw after good draws')
  state.drawThrows = true
  await draw()
  assert.deepEqual([spawns, sleeps], [1, 1], 'the failure is written')
  await draw()
  assert.deepEqual([spawns, sleeps], [1, 1], 'a failure that goes on')
})

test('the write waits until the draw is over, for a failure and for its clearing', async () => {
  const { copy, c } = drawCopy('strip')
  state.drawThrows = true
  copy.render(c)
  assert.equal(state.store[failKey('strip')], undefined, 'not written during the failing draw')
  await c.settle()
  assert.equal(state.store[failKey('strip')], 'boom')
  state.drawThrows = false
  copy.render(c)
  assert.equal(state.store[failKey('strip')], 'boom', 'not cleared during the good draw')
  await c.settle()
  assert.equal(state.store[failKey('strip')], null)
})

test('the sheet is not a band part: its throw stays the app’s', () => {
  state.props = { role: 'sheet' }
  const copy = new HerdrAgents()
  copy.boards = { list: () => [] }
  state.drawThrows = true
  assert.throws(() => copy.render(drawCx()), /boom/)
})

for (const role of ['strip', 'pinbar']) {
  test(`the heartbeat lists no terminal while the ${role} fails, at once, and lists again after a good draw`, async () => {
    live()
    const boards = [{ session: 's', coordinator: { terminal: 't1' } }]
    const bar = drawCopy('pinbar')
    bar.copy.boards.list = () => boards
    const listed = async () => {
      await bar.c.settle()
      return state.beats.at(-1)?.terminals
    }
    // Another part's failure reaches the pin bar through shared; the pin bar's own comes from its own draw, by a throw
    // the beat itself doesn't hit (it reads terminals, not focus).
    const setFailed = async failed => {
      if (role === 'pinbar') {
        state.focusThrows = failed
        await bar.draw()
      } else state.store[failKey(role)] = failed ? 'boom' : null
    }
    // Nothing failed: redraws write no beat of their own.
    await bar.draw()
    assert.equal(state.beats.length, 0)
    // The redraw after the failure beats with no terminals.
    await setFailed(true)
    await bar.draw()
    assert.deepEqual(await listed(), [])
    const after = state.beats.length
    await bar.draw()
    assert.equal(state.beats.length, after, 'a failure that goes on writes no more beats between timer beats')
    // A timer beat during the failure stays empty.
    bar.copy.beat(bar.c)
    assert.deepEqual(await listed(), [])
    await setFailed(false)
    await bar.draw()
    assert.deepEqual(await listed(), ['t1'])
  })
}

test('a new run forgets last run’s failures; a closing part forgets only its own', async () => {
  state.store = { [failKey('pinbar')]: 'old', [failKey('strip')]: 'old' }
  const strip = drawCopy('strip')
  await strip.copy.close()
  assert.equal(state.store[failKey('strip')], null)
  assert.equal(state.store[failKey('pinbar')], 'old')
  startCopy('pinbar')
  assert.equal(state.store[failKey('pinbar')], null)
})
