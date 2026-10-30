import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { app, findId, textOf } from './fake-gpui.mjs'

// After the fake is registered: these import `gpui-kit` and `herdr`.
const { pinsView } = await import('../mods/herdr-agents/pinbar.js')
const { PinCtl } = await import('../mods/herdr-agents/pinctl.js')
const { clearStaleOverlays } = await import('../mods/herdr-agents/cardstate.js')
const { openPins } = await import('../mods/herdr-agents/pinsctl.js')

const pin = (key, extra = {}) => ({
  id: `s:${key}`,
  key,
  title: `${key} title`,
  summary: '',
  tag: null,
  who: 'builder',
  text: `${key} full text`,
  at: 0,
  unread: true,
  ...extra,
})
const list = [pin('K1'), pin('K2', { tag: 'PR', at: Date.now() - 120_000 })]
const cx = { notify() {}, timer: { after() {} }, spawn() {} }
const down = (el, id) => findId(el, id).node.calls.on_mouse_down[1]({}, cx)

beforeEach(() => {
  app.store = {}
  app.opened = []
  app.closed = []
  globalThis.window = undefined
})

test('the drop panel draws: text, then who, age and tag, with a line height the app can use', () => {
  app.props = { view: 'panel', session: 's', id: 's:K2', list, width: 900, height: 200, overlay: 'o1' }
  const root = pinsView(new Set())
  assert.deepEqual(textOf(findId(root, 'pin-full')), ['K2 full text'])
  assert.deepEqual(textOf(findId(root, 'pin-context')), ['builder · 2m · PR'])
})

test('the popover draws with read and unread pins: only an unread one has a dot colour', () => {
  app.store['hrd.read'] = { 's:K1': true }
  app.props = { view: 'all', session: 's', list, width: 470, height: 300, overlay: 'o1' }
  const root = pinsView(new Set())
  const text = textOf(root)
  assert.ok(text.includes('K1 title') && text.includes('K2 title'))
  assert.ok(text.includes('Pinned by your agents · 2'))
  const dot = id => findId(root, `pin-open-${id}`).node.kids[0].node.calls.bg
  assert.equal(dot('K1'), undefined)
  assert.ok(dot('K2'))
})

test('two Dones in one tick are both asked for, and the pin bar drains both into its outbox', () => {
  app.props = { view: 'all', session: 's', list, width: 470, height: 300, overlay: 'o1' }
  const gone = new Set()
  const root = pinsView(gone)
  down(root, 'pin-done-K1')
  down(root, 'pin-done-K2')
  assert.deepEqual([...gone], ['s:K1', 's:K2'])

  const ctl = new PinCtl()
  ctl.ui(null, cx)
  assert.deepEqual(
    ctl.outbox.queue.map(q => q.key),
    ['K1', 'K2'],
  )
  assert.deepEqual(app.store['hrd.doneReq'], [], 'drained')
  ctl.ui(null, cx)
  assert.equal(ctl.outbox.queue.length, 2, 'a drained request is not taken again')
})

test('a pin waiting on a Done is left out of what the overlays open with', () => {
  const needs = ['K1', 'K2'].map(key => ({ key, kind: 'know', isOpen: true, text: `${key} text` }))
  const board = { session: 's', needs }
  const ctl = new PinCtl()
  ctl.ui(board, cx).onDone({ key: 'K1' }, cx)
  const ui = ctl.ui(board, cx)
  ui.onAll(cx)
  assert.deepEqual(
    app.opened.at(-1).props.list.map(p => p.key),
    ['K2'],
  )
  ui.onRead('s:K2', cx)
  assert.deepEqual(
    app.opened.at(-1).props.list.map(p => p.key),
    ['K2'],
  )
})

test('openPins limits the popover to the window, and tells the view that height', () => {
  globalThis.window = { viewport_size: () => ({ width: 1400, height: 500 }) }
  openPins('s', [pin('K1'), pin('K2'), pin('K3'), pin('K4')], 'all', { bar: { x: 200, y: 42, width: 900, height: 38 } })
  const o = app.opened[0]
  assert.equal(o.height, 500 - 84 - 8)
  assert.equal(o.props.height, o.height)
})

test('openPins limits the popover by the zoom the app draws it at', () => {
  globalThis.window = { viewport_size: () => ({ width: 900, height: 420 }) }
  app.settings = { zoom: 1.2 }
  openPins('s', [pin('K1'), pin('K2'), pin('K3'), pin('K4')], 'all', { bar: { x: 200, y: 42, width: 700, height: 38 } })
  assert.equal(app.opened[0].height, (420 - 84 - 8) / 1.2)
  app.settings = null
})

test('clearStaleOverlays forgets overlay ids and requests of the last run, and writes nothing when there are none', () => {
  const store = { 'hrd.pins': 'o1', 'hrd.popup': 'o2', 'hrd.doneReq': [{ session: 's', key: 'K1' }], 'hrd.read': { a: true } }
  const writes = []
  const set = (k, v) => {
    writes.push(k)
    store[k] = v
  }
  clearStaleOverlays(k => store[k], set)
  assert.deepEqual(store, { 'hrd.pins': null, 'hrd.popup': null, 'hrd.doneReq': null, 'hrd.read': { a: true } })
  writes.length = 0
  clearStaleOverlays(k => store[k], set)
  assert.deepEqual(writes, [])
})
