// A press outside closes the board pop-up, the card and the sheet (#207, #145). The app runs on_mouse_down_out first, then the
// press reaches what is underneath, so each test plays both, in that order. Real clicks can't be sent from here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { app, findId } from './fake-gpui.mjs'

const { DISMISS_MS, pastFrame, samePress, stripItems } = await import('../mods/herdr-agents/model.js')
const { card, makeCardState } = await import('../mods/herdr-agents/card.js')
const { makeSheetState, sheetBlock } = await import('../mods/herdr-agents/sheet.js')
const { popupView } = await import('../mods/herdr-agents/popup.js')
const { strip, StripState } = await import('../mods/herdr-agents/strip.js')
const { PinCtl } = await import('../mods/herdr-agents/pinctl.js')
const { pinbar } = await import('../mods/herdr-agents/pinbar.js')
const { clearStaleOverlays } = await import('../mods/herdr-agents/cardstate.js')

const board = () => ({ ...JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url))), session: 's' })
const cx = { notify() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {}, every() {} } }
const press = (extra = {}) => ({ button: 'left', click_count: 1, position: { x: 700, y: 900 }, ...extra })
const pressOn = (root, id, e) => findId(root, id).node.calls.on_mouse_down[1](e, cx)
const out = (root, e) => root.node.calls.on_mouse_down_out[0](e, cx)
const focusRuns = () => app.ran.filter(([name]) => name === 'pane.focus').map(([, args]) => args.terminal)

const b = board()
const items = stripItems(b)
const first = items.find(i => i.kind === 'ask')
const second = items.find(i => i !== first)
const openState = (key = first.key) => ({ session: 's', key, back: 't1', space: 'a', seq: 1 })

const cardRoot = (key = first.key) => {
  app.store['hrd.open'] = openState(key)
  app.store['hrd.pick'] = { session: 's', key }
  return card([b], makeCardState(cx), cx)
}
const sheetRoot = () => {
  app.store['hrd.sheet'] = openState()
  return sheetBlock([b], makeSheetState(cx), cx)
}
const popupRoot = (ctl = { h: {}, leaving: false }) => {
  app.props = { role: 'board', session: 's', overlay: 'o9', height: 300, back: 't1', space: 'a' }
  app.store['hrd.popup'] = 'o9'
  return popupView(b, ctl)
}
const bar = () => strip(b, { part: new StripState(), boards: [b], terminals: [] })

beforeEach(() => {
  // Not the app's first start: that forgets an open card or sheet.
  globalThis.__hrdStarted = { 'hrd.cardStarted': true, 'hrd.sheetStarted': true }
  globalThis.window = { viewport_size: () => ({ width: 1280, height: 821 }) }
  app.store = {}
  app.opened = []
  app.closed = []
  app.ran = []
  app.props = null
  app.focused = { terminal: 't1', space: 'a' }
  app.closeThrows = false
})

test('a press on a terminal closes the card and leaves the keyboard there', () => {
  out(cardRoot(), press())
  assert.equal(app.store['hrd.open'], null)
  assert.equal(app.store['hrd.pick'], null)
  assert.deepEqual(focusRuns(), [])
})

test('a press on a terminal closes the sheet and leaves the keyboard there', () => {
  out(sheetRoot(), press())
  assert.equal(app.store['hrd.sheet'], null)
  assert.deepEqual(focusRuns(), [])
})

test('a press outside closes the pop-up itself, and closing does not take the keyboard', () => {
  const ctl = { h: {}, leaving: false }
  out(popupRoot(ctl), press())
  assert.deepEqual(app.closed, ['o9'])
  assert.equal(app.store['hrd.popup'], null)
  assert.equal(ctl.leaving, true)
})

test('the pop-up survives the app having closed it on the same press', () => {
  const root = popupRoot()
  app.closeThrows = true
  out(root, press())
  assert.equal(app.store['hrd.popup'], null)
})

test('the closed card and sheet listen for nothing', () => {
  assert.equal(card([b], makeCardState(cx), cx).node.calls.on_mouse_down_out, undefined)
  assert.equal(sheetBlock([b], makeSheetState(cx), cx).node.calls.on_mouse_down_out, undefined)
})

test('any button dismisses: a right-click closes the card and leaves no toggle for a left click', () => {
  out(cardRoot(), press({ button: 'right' }))
  assert.equal(app.store['hrd.open'], null)
  pressOn(bar(), `tab-${first.key}`, press())
  assert.equal(app.store['hrd.open'].key, first.key, 'the left click is a press of its own: it opens')
})

test("a press on Herdr's frame round the card or sheet is a press on the surface", () => {
  const onFrame = press({ local_position: { x: 10, y: -5 }, bounds: { width: 560, height: 200 } })
  out(cardRoot(), onFrame)
  assert.ok(app.store['hrd.open'])
  out(sheetRoot(), onFrame)
  assert.ok(app.store['hrd.sheet'])
})

test('pastFrame: past the frame above and below only, on it, scaled by zoom, and with no place given', () => {
  const at = (x, y, zoom) => pastFrame({ local_position: { x, y }, bounds: { width: 100, height: 50 } }, zoom)
  assert.equal(at(0, -6), false)
  assert.equal(at(0, -7), true)
  assert.equal(at(50, 56), false)
  assert.equal(at(0, 57), true)
  assert.equal(at(-1, 0), true)
  assert.equal(at(101, 0), true)
  assert.equal(at(0, -3, 2), false)
  assert.equal(at(0, -4, 2), true)
  assert.equal(pastFrame({}), true)
})

test('toggle, strip segment: a press on the open item closes its card and does not reopen it; the keyboard goes back', () => {
  const root = cardRoot()
  const e = press()
  out(root, e)
  pressOn(bar(), `tab-${first.key}`, e)
  assert.equal(app.store['hrd.open'], null)
  assert.equal(app.store['hrd.pick'], null)
  assert.deepEqual(focusRuns(), ['t1'])
})

test('strip segment: a press on another item moves the card there, keeping the terminal to hand back', () => {
  const root = cardRoot()
  const e = press()
  out(root, e)
  app.focused = { terminal: null, space: 'b' }
  pressOn(bar(), `tab-${second.key}`, e)
  assert.equal(app.store['hrd.open'].key, second.key)
  assert.equal(app.store['hrd.open'].back, 't1')
  assert.equal(app.store['hrd.open'].space, 'a')
  assert.deepEqual(focusRuns(), [])
})

test('toggle, strip segment: from another space the keyboard stays where it is', () => {
  const root = cardRoot()
  const e = press()
  out(root, e)
  app.focused = { terminal: 't9', space: 'b' }
  pressOn(bar(), `tab-${first.key}`, e)
  assert.equal(app.store['hrd.open'], null)
  assert.deepEqual(focusRuns(), [])
})

test('toggle, board button: a press on it closes the pop-up and does not reopen it', () => {
  const e = press()
  out(popupRoot(), e)
  pressOn(bar(), 'strip-board', e)
  assert.deepEqual(app.opened, [])
  assert.deepEqual(focusRuns(), ['t1'])
})

test('board button: a press that closed the card opens the pop-up, which keeps the terminal to hand back', () => {
  const e = press()
  out(cardRoot(), e)
  app.focused = { terminal: null, space: 'b' }
  pressOn(bar(), 'strip-board', e)
  assert.equal(app.opened.length, 1)
  assert.equal(app.opened[0].props.back, 't1')
  assert.equal(app.opened[0].props.space, 'a')
})

test('toggle, sheet button: a press on ⌘J closes the sheet and does not reopen it', () => {
  const e = press()
  out(sheetRoot(), e)
  pressOn(bar(), 'strip-sheet', e)
  assert.equal(app.store['hrd.sheet'], null)
  assert.deepEqual(focusRuns(), ['t1'])
})

test("sheet button: a press that closed the card opens the sheet on the card's item", () => {
  const e = press()
  const later = items.filter(i => i.kind === 'ask')[1]
  out(cardRoot(later.key), e)
  app.focused = { terminal: null, space: 'b' }
  pressOn(bar(), 'strip-sheet', e)
  assert.equal(app.store['hrd.sheet'].key, later.key)
  assert.equal(app.store['hrd.sheet'].back, 't1')
})

test('pin bar: a press that closed the card opens the pin, which keeps the terminal to hand back', () => {
  const needs = [{ key: 'K1', kind: 'know', isOpen: true, text: 'K1 text' }]
  const pinBoard = { session: 's', needs }
  const ctl = new PinCtl()
  const e = press({ bounds: { x: 0, y: 0, width: 800, height: 30 } })
  out(cardRoot(), e)
  app.focused = { terminal: null, space: 'a' }
  const ui = ctl.ui(pinBoard, cx)
  const root = pinbar(pinBoard, ui)
  root.node.calls.on_mouse_down[1](e, cx)
  findId(root, 'pin-all').node.calls.on_click[0](null, cx)
  assert.equal(app.opened[0].props.back, 't1')
  assert.equal(app.store['hrd.open'], null)
})

test('pin bar: a press that closed the card, then the caret, hands the keyboard back for the pin', () => {
  const needs = [{ key: 'K1', kind: 'know', isOpen: true, text: 'K1 text' }]
  const pinBoard = { session: 's', needs }
  const ctl = new PinCtl()
  const e = press({ bounds: { x: 0, y: 0, width: 800, height: 30 } })
  out(cardRoot(), e)
  app.focused = { terminal: null, space: 'a' }
  const root = pinbar(pinBoard, ctl.ui(pinBoard, cx))
  root.node.calls.on_mouse_down[1](e, cx)
  findId(root, 'pin-caret').node.calls.on_click[0](null, cx)
  assert.equal(app.opened[0].props.back, 't1')
})

test('a later press on the button is its own press: it opens again', () => {
  out(cardRoot(), press())
  pressOn(bar(), `tab-${first.key}`, press({ position: { x: 20, y: 900 } }))
  assert.equal(app.store['hrd.open'].key, first.key)
})

test('samePress: same place, button and count within the window; anything else is another press', () => {
  const note = { x: 10, y: 20, button: 'left', clicks: 1, at: 1000 }
  const p = press({ position: { x: 10.5, y: 20 } })
  assert.equal(samePress(note, p, 1000), true)
  assert.equal(samePress(note, p, 1000 + DISMISS_MS - 1), true)
  assert.equal(samePress(note, p, 1000 + DISMISS_MS), false, 'too late')
  assert.equal(samePress(note, p, 999), false, 'a clock that went back')
  assert.equal(samePress(note, { ...p, click_count: 2 }, 1000), false, 'a quick second click')
  assert.equal(samePress(note, { ...p, button: 'right' }, 1000), false)
  assert.equal(samePress(note, press({ position: { x: 12, y: 20 } }), 1000), false)
  assert.equal(samePress(note, press({ position: { x: 10, y: 22 } }), 1000), false)
  assert.equal(samePress(note, null, 1000), false, 'a key has no press')
  assert.equal(samePress(null, p, 1000), false)
})

test('a note is read once, and a key on the strip ignores and clears it', () => {
  const e = press()
  out(cardRoot(), e)
  const part = new StripState()
  part.pick(b, first, false)
  assert.equal(app.store['hrd.dismissed'], null)
  assert.equal(app.store['hrd.open'].key, first.key, 'a key opens: only a click toggles')
})

test('a note left by the last run is forgotten at start', () => {
  app.store['hrd.dismissed'] = { surface: 'card' }
  clearStaleOverlays(
    k => app.store[k],
    (k, v) => (app.store[k] = v),
  )
  assert.equal(app.store['hrd.dismissed'], null)
})
