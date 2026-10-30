// What a copy of the mod clears when it starts, through main.js itself: a real app start clears, a layout switch or a hot
// reload (a new copy, same run) does not. Its own stand-ins, because main.js pulls in every part of the mod.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { beforeEach, test } from 'node:test'

const state = { props: null, store: {}, closed: [], reads: [], file: null }
globalThis.__startFake = {
  View: class {},
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
  closeOverlay: id => state.closed.push(id),
  focused: () => state.focused ?? null,
  run: () => {},
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
  'gpui-base': ['h_flex', 'v_flex'],
  herdr: [
    'agents',
    'appHome',
    'closeOverlay',
    'exec',
    'focused',
    'hc',
    'home',
    'layout',
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

const { default: HerdrAgents } = await import('../mods/herdr-agents/main.js')
const { openBoardPopup } = await import('../mods/herdr-agents/strip.js')

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

test('the card copy forgets a card left open by the last run, on the first start of a run', () => {
  state.store = { 'hrd.open': card, 'hrd.pick': card }
  startCopy('card')
  assert.deepEqual(state.store, { 'hrd.open': null, 'hrd.pick': null })
})

test('a card copy started again in the same run keeps the open card', () => {
  startCopy('card')
  state.store = { 'hrd.open': card, 'hrd.pick': card }
  startCopy('card')
  assert.deepEqual(state.store, { 'hrd.open': card, 'hrd.pick': card })
})

test('the first copies of a run clear their own keys, whichever starts first', () => {
  state.store = { ...left(), 'hrd.open': card }
  startCopy('card')
  assert.equal(state.store['hrd.pins'], 'o2', 'the card leaves the overlay ids to the pin bar')
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
