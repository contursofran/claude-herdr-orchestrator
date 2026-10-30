import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { app, findId, textOf } from './fake-gpui.mjs'

// After the fake is registered: these import `gpui-kit` and `herdr`.
const { closePinsOverlay, pinbar, pinsView } = await import('../mods/herdr-agents/pinbar.js')
const { sheetView } = await import('../mods/herdr-agents/sheetmodel.js')
const { PinCtl } = await import('../mods/herdr-agents/pinctl.js')
const { clearStaleOverlays } = await import('../mods/herdr-agents/cardstate.js')
const { openPins } = await import('../mods/herdr-agents/pinsctl.js')
const { releasePopup } = await import('../mods/herdr-agents/popup.js')
const { ROWS_SETTLE_MS, allPinsHeight, doneAction, pinsOverlayEmpty } = await import('../mods/herdr-agents/model.js')

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
  app.ran = []
  app.focused = null
  app.closeThrows = false
  globalThis.window = undefined
})

test('the drop panel draws: text, then who, age and tag, with a line height the app can use', () => {
  app.props = { view: 'panel', session: 's', id: 's:K2', list, width: 900, height: 200, overlay: 'o1' }
  const root = pinsView(new Set(), {})
  assert.deepEqual(textOf(findId(root, 'pin-full')), ['K2 full text'])
  assert.deepEqual(textOf(findId(root, 'pin-context')), ['builder · 2m · PR'])
})

test('the popover draws with read and unread pins: only an unread one has a dot colour', () => {
  app.store['hrd.read'] = { 's:K1': true }
  app.props = { view: 'all', session: 's', list, width: 470, height: 300, overlay: 'o1' }
  const root = pinsView(new Set(), {})
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
  const root = pinsView(gone, {})
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

const pressKey = (root, key) => root.node.calls.on_key_down[0]({ keystroke: key }, cx)
const opened = extra => {
  app.props = { view: 'all', session: 's', list, width: 470, height: 300, overlay: 'o1', back: 't7', space: 'a', ...extra }
  app.store['hrd.pins'] = 'o1'
  app.focused = { space: 'a', terminal: 't7' }
}

test('the overlay tracks the handle it is given', () => {
  opened()
  const ctl = { h: {} }
  assert.equal(pinsView(new Set(), ctl).node.calls.track_focus[0], ctl.h)
})

for (const view of ['all', 'panel']) {
  test(`Esc closes the ${view} overlay and its close call gives the keyboard back`, () => {
    opened({ view, id: 's:K1' })
    const ctl = {}
    pressKey(pinsView(new Set(), ctl), 'escape')
    assert.deepEqual(app.closed, ['o1'])
    assert.equal(app.store['hrd.pins'], null)
    assert.deepEqual(app.ran, [], 'only the close call hands it back, so it runs once')
    releasePopup(ctl)
    assert.deepEqual(app.ran, [['pane.focus', { terminal: 't7' }]])
  })
}

test('another key and a held Esc do nothing', () => {
  opened()
  const root = pinsView(new Set(), {})
  pressKey(root, 'a')
  root.node.calls.on_key_down[0]({ keystroke: 'escape', is_held: true }, cx)
  assert.deepEqual(app.closed, [])
  assert.deepEqual(app.ran, [])
})

test('Esc survives the app having closed the overlay first', () => {
  opened()
  app.closeThrows = true
  pressKey(pinsView(new Set(), {}), 'escape')
  assert.equal(app.store['hrd.pins'], null)
})

test('closing leaves the keyboard alone when the owner has moved to another space', () => {
  opened()
  const ctl = {}
  app.focused = { space: 'b', terminal: 't9' }
  pressKey(pinsView(new Set(), ctl), 'escape')
  assert.deepEqual(app.closed, ['o1'])
  releasePopup(ctl)
  assert.deepEqual(app.ran, [])
})

test('a click on another terminal keeps the keyboard there', () => {
  opened()
  app.focused = { space: 'a', terminal: 't9' }
  releasePopup({})
  assert.deepEqual(app.ran, [])
})

test('Done in the panel also gives the keyboard back', () => {
  opened({ view: 'panel', id: 's:K1' })
  const ctl = {}
  down(pinsView(new Set(), ctl), 'pin-panel-done')
  assert.deepEqual(app.closed, ['o1'])
  releasePopup(ctl)
  assert.deepEqual(app.ran, [['pane.focus', { terminal: 't7' }]])
})

for (const [view, id, next] of [
  ['panel', 'pin-panel-all', 'all'],
  ['all', 'pin-open-K1', 'panel'],
]) {
  test(`${id} opens the next overlay, which keeps the terminal to hand back; closing this one does not take the keyboard`, () => {
    opened({ view, id: 's:K1' })
    app.focused = { space: 'a', terminal: null }
    const ctl = {}
    down(pinsView(new Set(), ctl), id)
    assert.equal(app.opened[0].props.view, next)
    assert.equal(app.opened[0].props.back, 't7')
    releasePopup(ctl)
    assert.deepEqual(app.ran, [])
  })
}

test('openPins remembers the terminal and space that have the keyboard', () => {
  app.focused = { space: 'a', terminal: 't7' }
  openPins('s', list, 'all')
  assert.equal(app.opened[0].props.back, 't7')
  assert.equal(app.opened[0].props.space, 'a')
})

const liveBoard = keys => ({ session: 's', needs: keys.map(key => ({ key, kind: 'know', isOpen: true, text: key })) })

test('a pin resolved while the popover is open leaves the list and the count, so it cannot be Done', () => {
  app.props = { view: 'all', session: 's', list, width: 470, height: 300, overlay: 'o1' }
  const root = pinsView(new Set(), {}, liveBoard(['K2']))
  assert.equal(findId(root, 'pin-done-K1'), null)
  assert.ok(findId(root, 'pin-done-K2'))
  assert.ok(textOf(root).includes('Pinned by your agents · 1'))
})

test('the drop panel with its pin resolved offers no Done action', () => {
  app.props = { view: 'panel', session: 's', id: 's:K1', list, width: 900, height: 200, overlay: 'o1' }
  const root = pinsView(new Set(), {}, liveBoard(['K2']))
  down(root, 'pin-panel-done')
  assert.equal(app.store['hrd.doneReq'], undefined)
})

test('all pins from a panel opens with only what is still open', () => {
  app.props = { view: 'panel', session: 's', id: 's:K2', list, width: 900, height: 200, overlay: 'o1' }
  down(pinsView(new Set(), {}, liveBoard(['K2'])), 'pin-panel-all')
  assert.deepEqual(
    app.opened[0].props.list.map(p => p.key),
    ['K2'],
  )
})

test('the popover shrinks to the pins left after a Done, and never grows past what fits the window', () => {
  const three = [pin('K1'), pin('K2'), pin('K3')]
  app.props = { view: 'all', session: 's', list: three, width: 470, height: allPinsHeight(3), overlay: 'o1' }
  const h = gone => pinsView(new Set(gone), {}).node.calls.h[0]
  assert.equal(h([]), allPinsHeight(3))
  assert.equal(h(['s:K1', 's:K2']), allPinsHeight(1))
  app.props = { ...app.props, height: 150 }
  assert.equal(h(['s:K1', 's:K2']), 150)
})

test('the drop panel keeps the height it opened with', () => {
  app.props = { view: 'panel', session: 's', id: 's:K1', list, width: 900, height: 444, overlay: 'o1' }
  assert.equal(pinsView(new Set(), {}).node.calls.h[0], 444)
})

test('a popover row holds whole lines: fixed line height, and a summary box of exactly three', () => {
  app.props = { view: 'all', session: 's', list, width: 470, height: 300, overlay: 'o1' }
  const root = pinsView(new Set(), {})
  assert.deepEqual(findId(root, 'pin-K1').node.calls.line_height, ['18px'])
  const summary = findId(root, 'pin-summary-K1').node.calls
  assert.deepEqual(summary.h, [54])
  assert.ok(summary.flex_none && !summary.flex_1)
})

test('openPins with no bar bounds places the panel from the layout', () => {
  globalThis.window = { viewport_size: () => ({ width: 1280, height: 800 }) }
  app.layout = {
    type: 'row',
    children: [
      { id: 'sidebar', type: 'column', size: { px: 269 }, children: [] },
      {
        type: 'column',
        children: [
          { type: 'block', size: { px: 42 } },
          { type: 'block', size: { px: 38 }, content: { props: { role: 'pinbar' } } },
          { type: 'block', size: { weight: 1 } },
        ],
      },
    ],
  }
  openPins('s', list, 'panel', { id: 's:K1' })
  app.layout = null
  assert.deepEqual(app.opened[0].at, { x: 269, y: 80 })
  assert.equal(app.opened[0].width, 1280 - 269)
})

for (const [view, x, width] of [
  ['panel', 538, (1280 - 538) / 2],
  ['all', 1280 - 470 * 2 - 8, 470],
]) {
  test(`openPins at zoom 2 with no bar bounds keeps the ${view} inside the window`, () => {
    globalThis.window = { viewport_size: () => ({ width: 1280, height: 800 }) }
    app.settings = { zoom: 2 }
    app.layout = {
      type: 'row',
      children: [
        { id: 'sidebar', type: 'column', size: { px: 269 }, children: [] },
        { type: 'column', children: [{ type: 'block', size: { px: 38 }, content: { props: { role: 'pinbar' } } }] },
      ],
    }
    openPins('s', list, view, { id: 's:K1' })
    app.layout = null
    app.settings = { zoom: 1 }
    const o = app.opened.at(-1)
    assert.deepEqual(o.at, { x, y: view === 'panel' ? 76 : 80 })
    assert.equal(o.width, width)
    assert.ok(o.at.x + o.width * 2 <= 1280)
  })
}

// ---- #194: a press can't land on a row that moved in the moment before it ----

const three = [pin('K1', { at: 3 }), pin('K2', { at: 2 }), pin('K3', { at: 1 })]
const boardOf = (...keys) => ({ session: 's', needs: keys.map(key => ({ key, kind: 'know', isOpen: true, text: `${key} text` })) })
const openAll = () => {
  app.props = { view: 'all', session: 's', list: three, width: 470, height: 500, overlay: 'o1' }
}

test('a Done pressed just after a resolved pin moved the rows up is ignored, and the same press works once they have settled', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 })
  openAll()
  const gone = new Set()
  const ctl = {}
  pinsView(gone, ctl, boardOf('K1', 'K2', 'K3'))
  const moved = pinsView(gone, ctl, boardOf('K2', 'K3'))
  down(moved, 'pin-done-K2')
  assert.deepEqual([...gone], [], 'the row moved a moment ago')
  assert.equal(app.store['hrd.doneReq'], undefined)

  t.mock.timers.tick(ROWS_SETTLE_MS - 1)
  down(moved, 'pin-done-K2')
  assert.deepEqual([...gone], [], 'still the moment after')

  t.mock.timers.tick(1)
  down(moved, 'pin-done-K2')
  assert.deepEqual([...gone], ['s:K2'])
})

test('mark read and opening a row are held back the same way', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 })
  openAll()
  const ctl = {}
  pinsView(new Set(), ctl, boardOf('K1', 'K2', 'K3'))
  const moved = pinsView(new Set(), ctl, boardOf('K2', 'K3'))
  down(moved, 'pin-read-K2')
  down(moved, 'pin-open-K2')
  assert.equal(app.store['hrd.read'], undefined)
  assert.deepEqual(app.opened, [])
})

test('a press on rows that have not moved works from the first draw, and redraws of the same rows do not hold it back', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 })
  openAll()
  const gone = new Set()
  const ctl = {}
  pinsView(gone, ctl, boardOf('K1', 'K2', 'K3'))
  down(pinsView(gone, ctl, boardOf('K1', 'K2', 'K3')), 'pin-done-K1')
  assert.deepEqual([...gone], ['s:K1'])
})

test('a second press of a double click on Done cannot hit the row that moved up after the first', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 })
  openAll()
  const gone = new Set()
  const ctl = {}
  down(pinsView(gone, ctl), 'pin-done-K1')
  down(pinsView(gone, ctl), 'pin-done-K2')
  assert.deepEqual([...gone], ['s:K1'])
})

test('rows reordering counts as moving: a pin marked read sinks below the unread ones', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 })
  openAll()
  const gone = new Set()
  const ctl = {}
  pinsView(gone, ctl)
  app.store['hrd.read'] = { 's:K1': true }
  down(pinsView(gone, ctl), 'pin-done-K2')
  assert.deepEqual([...gone], [])
})

test('the last pin resolving still closes the overlay and hands the keyboard back, even in the moment after rows moved', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 })
  openAll()
  app.store['hrd.pins'] = 'o1'
  app.props.back = 't1'
  app.props.space = 'sp'
  const gone = new Set()
  const ctl = { leaving: false }
  pinsView(gone, ctl, boardOf('K1', 'K2', 'K3'))
  pinsView(gone, ctl, boardOf('K1'))
  assert.equal(pinsOverlayEmpty(app.props, boardOf(), gone), true)
  closePinsOverlay()
  assert.deepEqual(app.closed, ['o1'])
  assert.equal(app.store['hrd.pins'], null)
  app.focused = { space: 'sp', terminal: null }
  releasePopup(ctl)
  assert.deepEqual(app.ran.at(-1), ['pane.focus', { terminal: 't1' }])
})

test('a resolved pin has no row to press while the others hold still', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 })
  openAll()
  const ctl = {}
  pinsView(new Set(), ctl, boardOf('K1', 'K2', 'K3'))
  const moved = pinsView(new Set(), ctl, boardOf('K2', 'K3'))
  assert.equal(findId(moved, 'pin-done-K1'), null)
})

const todoBoard = () => ({
  session: 's',
  needs: [
    { key: 'T1', kind: 'do', isOpen: true, text: 'Merge #7', at: 5 },
    { key: 'K1', kind: 'know', isOpen: true, text: 'Disk full', at: 4 },
  ],
})

test('Done on a to-do in the bar queues the very action the card sends for it', () => {
  const board = todoBoard()
  const ctl = new PinCtl()
  const ui = ctl.ui(board, cx)
  ui.onDone(ui.current, cx)
  const sheet = sheetView(board, 'T1').options.find(o => o.label === 'Done')
  assert.equal(ui.current.key, 'T1', 'the newest pin is the to-do')
  // The card's Done is doneAction(key) (card.js); the sheet's Done is the same file.
  assert.deepEqual(ctl.outbox.queue[0].action, sheet.action)
  assert.deepEqual(ctl.outbox.queue[0].action, doneAction('T1'))
  assert.deepEqual(ctl.outbox.queue[0].action, { action: 'done', key: 'T1' })
  // Undo brings it back like any pin.
  ctl.outbox.undo(ctl.outbox.queue[0].id)
  assert.equal(ctl.ui(board, cx).current.key, 'T1')
})

test('a to-do wears a to-do icon and tag in the bar and the all-pins list; a pin does not', () => {
  const ctl = new PinCtl()
  const ui = ctl.ui(todoBoard(), cx)
  const bar = pinbar(todoBoard(), ui)
  assert.ok(textOf(bar).includes('to-do'))
  const know = ctl.ui({ session: 's', needs: [todoBoard().needs[1]] }, cx)
  assert.ok(!textOf(pinbar({ session: 's' }, know)).includes('to-do'))
  app.props = {
    view: 'all',
    session: 's',
    list: [pin('T1', { kind: 'do' }), pin('K1', { kind: 'know' })],
    width: 470,
    height: 300,
    overlay: 'o1',
  }
  const rows = pinsView(new Set(), {})
  assert.ok(textOf(findId(rows, 'pin-open-T1')).includes('to-do'))
  assert.ok(!textOf(findId(rows, 'pin-open-K1')).includes('to-do'))
})

test('a to-do pin uses the do icon, a note the pin icon', () => {
  const ctl = new PinCtl()
  const icons = ui => {
    const seen = []
    const walk = el => {
      if (!el || typeof el !== 'object') return
      seen.push(...el.node.init)
      el.node.kids.forEach(walk)
    }
    walk(pinbar(todoBoard(), ui))
    return seen
  }
  assert.ok(icons(ctl.ui(todoBoard(), cx)).some(p => String(p).endsWith('do.svg')))
  const note = { session: 's', needs: [todoBoard().needs[1]] }
  assert.ok(!icons(ctl.ui(note, cx)).some(p => String(p).endsWith('do.svg')))
})
