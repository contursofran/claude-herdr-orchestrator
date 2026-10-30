// What a copy of the mod clears when it starts, through main.js itself: a real app start clears, a layout switch or a hot
// reload (a new copy, same run) does not. Its own stand-ins, because main.js pulls in every part of the mod.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { beforeEach, test } from 'node:test'

const state = { props: null, store: {}, closed: [] }
globalThis.__startFake = {
  View: class {},
  closeOverlay: id => state.closed.push(id),
  openOverlay: () => 'o4',
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
