// The answer card lines up with the tab it opened from: the strip draws it in a Popup on that tab (#93). The place of the
// tab in the strip is kept in "hrd.open" (`at`). Where the Popup puts it on screen can't be tested here: see the PR.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { app, findId } from './fake-gpui.mjs'

const { stripItems } = await import('../mods/herdr-agents/model.js')
const { makeCardState } = await import('../mods/herdr-agents/card.js')
const { openCard } = await import('../mods/herdr-agents/cardctl.js')
const { strip, StripState } = await import('../mods/herdr-agents/strip.js')

const b = { ...JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url))), session: 's' }
const items = stripItems(b)
const cx = { notify() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {}, every() {} } }
const ctl = () => makeCardState(cx)
const draw = (card, board = b) => strip(board, { part: new StripState(), boards: [board], terminals: [], card, cx })
const open = (key, at) => {
  app.store['hrd.open'] = { session: 's', key, back: 't1', space: 'a', seq: 1, at }
  app.store['hrd.pick'] = { session: 's', key }
}
/** The tab (its id) the card floats over, or null. */
const anchoredTab = root => {
  const popup = findId(root, 'answer-card')
  return popup ? popup.node.kids[0].node.calls.id[0] : null
}

beforeEach(() => {
  globalThis.__hrdStarted = { 'hrd.cardStarted': true }
  globalThis.window = { viewport_size: () => ({ width: 1280, height: 821 }) }
  app.store = {}
  app.ran = []
  app.opened = []
  app.focused = { terminal: 't1', space: 'a' }
  app.settings = { zoom: 1 }
})

test('there are tabs enough to tell the places apart', () => {
  assert.ok(items.length >= 3)
})

test('closed: no popup, so nothing is drawn above the terminal', () => {
  assert.equal(anchoredTab(draw(ctl())), null)
})

test('open: the card is in a popup on the tab at its place, anchored bottom left, with its content', () => {
  for (const at of [0, 2]) {
    open(items[at].key, at)
    const popup = findId(draw(ctl()), 'answer-card')
    assert.equal(popup.node.kids[0].node.calls.id[0], `tab-${items[at].key}`)
    assert.deepEqual(popup.node.calls.anchor, ['bottom_left'])
    assert.equal(popup.node.popupContent.node.calls.id[0], 'card')
  }
})

test('the card stays on its tab as it moves on to another item, and the picked tab is the new item', () => {
  open(items[1].key, 2)
  assert.equal(anchoredTab(draw(ctl())), `tab-${items[2].key}`)
})

test('a place past the last tab (an item left the strip) lines up with the last one', () => {
  open(items[0].key, 99)
  assert.equal(anchoredTab(draw(ctl())), `tab-${items.at(-1).key}`)
})

test('with no tab at all the card floats over the tabs row instead', () => {
  open('D7', 0)
  const root = draw(ctl(), { session: 's', coordinator: b.coordinator, needs: [], tasks: [], workers: [] })
  assert.equal(anchoredTab(root), 'card-anchor')
})

test('a copy without card state (any other part) draws no popup even with a card open', () => {
  open(items[0].key, 0)
  assert.equal(anchoredTab(draw(null)), null)
})

test('after the last item closed, the keyboard holder is in the strip and no popup', () => {
  const card = ctl()
  card.hold = {}
  const root = draw(card)
  assert.ok(findId(root, 'card-hold'))
  assert.equal(anchoredTab(root), null)
  card.hold = null
  assert.equal(findId(draw(card), 'card-hold'), null)
})

test('a key or a click on a tab opens the card with the tab place; another tab realigns it; moving on keeps it', () => {
  const part = new StripState()
  part.pick(b, items[2], false)
  assert.equal(app.store['hrd.open'].at, 2)
  openCard(b, items[1]) // the card moves on (an answer, next ›): no place given
  assert.equal(app.store['hrd.open'].at, 2)
  part.pick(b, items[0], false)
  assert.equal(app.store['hrd.open'].at, 0, 'the first tab too')
})

test('opening again from a card the press just closed still takes the new tab place', () => {
  const part = new StripState()
  part.pick(b, items[1], false)
  app.store['hrd.open'] = null
  app.store['hrd.pick'] = null
  part.pick(b, items[2], false)
  assert.equal(app.store['hrd.open'].at, 2)
})
