import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PINS_ALL_W,
  allPinsHeight,
  barArea,
  drawnKey,
  doneRequests,
  fitHeight,
  markAllRead,
  markRead,
  orderPins,
  panelHeight,
  pinContext,
  pins,
  pinsOverlayEmpty,
  pinsSpot,
  readKey,
  stillOpen,
} from '../mods/herdr-agents/model.js'

const know = (key, extra = {}) => ({ key, kind: 'know', isOpen: true, text: `${key} text`, ...extra })
const board = needs => ({ session: 's', needs })

test('orderPins: unread first, newest first within each group, board order when equal', () => {
  const b = board([know('K1', { at: 10 }), know('K2', { at: 30 }), know('K3', { at: 20 }), know('K4', { at: 20 }), know('K5', { at: 40 })])
  const read = { [readKey('s', 'K5')]: true, [readKey('s', 'K1')]: true }
  const list = pins(b, read)
  assert.deepEqual(
    orderPins(list).map(p => p.key),
    ['K2', 'K3', 'K4', 'K5', 'K1'],
  )
  assert.deepEqual(
    list.map(p => p.key),
    ['K1', 'K2', 'K3', 'K4', 'K5'],
    'the input is left as it was',
  )
})

test('markAllRead marks every pin of the list; the same object when none was unread', () => {
  const list = pins(board([know('K1'), know('K2')]), {})
  const read = { other: true }
  assert.deepEqual(markAllRead(read, list), { other: true, [readKey('s', 'K1')]: true, [readKey('s', 'K2')]: true })
  const all = markAllRead(read, list)
  assert.equal(markAllRead(all, list), all)
  assert.equal(markAllRead(read, []), read)
})

test('opening a pin marks it read: markRead takes it out of the unread order and leaves the others', () => {
  const b = board([know('K1', { at: 1 }), know('K2', { at: 2 })])
  const read = markRead({}, readKey('s', 'K2'))
  assert.deepEqual(
    orderPins(pins(b, read)).map(p => [p.key, p.unread]),
    [
      ['K1', true],
      ['K2', false],
    ],
  )
})

test('pins carry the full text, for the drop panel', () => {
  const [p] = pins(board([know('K1', { text: '  First line\nsecond line  ' })]))
  assert.equal(p.text, 'First line\nsecond line')
})

test('doneRequests: every usable request of the list, in order; anything else is ignored', () => {
  const list = [{ session: 's', key: 'K1' }, { session: 's' }, null, { key: 'K3' }, { session: 's', key: 'K2' }]
  assert.deepEqual(doneRequests(list), [
    { session: 's', key: 'K1' },
    { session: 's', key: 'K2' },
  ])
  assert.deepEqual(doneRequests(null), [])
  assert.deepEqual(doneRequests({ session: 's', key: 'K1', n: 'left by an older build' }), [])
})

test('fitHeight limits an overlay to the window, keeps a minimum, and leaves it alone with no window size', () => {
  assert.equal(fitHeight(638, 84, { height: 900 }), 638)
  assert.equal(fitHeight(638, 84, { height: 500 }), 408)
  assert.equal(fitHeight(638, 84, { height: 150 }), 120)
  assert.equal(fitHeight(638, 84, null), 638)
  assert.equal(fitHeight(638, 84, { height: 420 }, 1.2), 328 / 1.2, 'at zoom 1.2 the overlay draws 1.2x as tall')
  assert.equal(fitHeight(638, 84, { height: 420 }, undefined), 328)
})

test('pinContext: who, age and tag, leaving out what the pin does not have', () => {
  const now = 3_600_000 * 2
  assert.equal(pinContext({ who: 'builder', at: now - 120_000, tag: 'PR' }, now), 'builder · 2m · PR')
  assert.equal(pinContext({ who: '', at: 0, tag: null }, now), '')
})

test('panelHeight grows with the lines of the text, up to a cap; allPinsHeight with the pins, up to four rows', () => {
  assert.ok(panelHeight('x'.repeat(2000), 900) > panelHeight('x', 900))
  assert.equal(panelHeight('a\nb\nc', 900) - panelHeight('a', 900), 40)
  assert.equal(panelHeight('a', 900), 1 + 14 + 20 + 12 + 18 + 12 + 28 + 14, 'room for the context line')
  assert.equal(panelHeight('x'.repeat(100000), 900), panelHeight('x'.repeat(200000), 900))
  assert.ok(panelHeight('x'.repeat(200), 400) > panelHeight('x'.repeat(200), 1200), 'narrower wraps more')
  assert.ok(allPinsHeight(2) > allPinsHeight(1))
  assert.equal(allPinsHeight(9), allPinsHeight(4))
  assert.equal(allPinsHeight(0), allPinsHeight(1))
})

test('pinsSpot: the panel under the bar at its width, the popover right aligned under it; fallback without bounds', () => {
  const bar = { x: 200, y: 42, width: 900, height: 38 }
  assert.deepEqual(pinsSpot('panel', bar, { width: 1400, height: 900 }), { x: 200, y: 80, width: 900 })
  assert.deepEqual(pinsSpot('all', bar, { width: 1400, height: 900 }), { x: 200 + 900 - PINS_ALL_W - 8, y: 84, width: PINS_ALL_W })
  const fb = pinsSpot('panel', null, { width: 1400, height: 900 })
  assert.equal(fb.x, 170)
  assert.equal(fb.width, 1400 - 340)
})

const barTree = (left, right = []) => ({
  type: 'row',
  children: [
    ...left,
    {
      type: 'column',
      children: [
        { type: 'block', size: { px: 42 } },
        { type: 'block', size: { px: 38 }, content: { props: { role: 'pinbar' } } },
        { type: 'block', size: { weight: 1 } },
      ],
    },
    ...right,
  ],
})

test('barArea: fixed blocks on each side and above the bar; hidden ones count for nothing; the zoom scales them', () => {
  const side = { size: { px: 269 } }
  assert.deepEqual(barArea(barTree([side], [{ size: { px: 300 } }])), { x: 269, y: 80, right: 300 })
  assert.deepEqual(barArea(barTree([{ ...side, hidden: true }])), { x: 0, y: 80, right: 0 })
  assert.deepEqual(barArea(barTree([side]), 2), { x: 538, y: 160, right: 0 })
})

test('barArea: null with no pin bar, or a hidden one, or a block sized by weight beside it', () => {
  assert.equal(barArea(null), null)
  assert.equal(barArea({ type: 'row', children: [{ type: 'block', size: { px: 10 } }] }), null)
  assert.equal(barArea(barTree([{ size: { weight: 1 } }])), null)
  const hiddenBar = barTree([])
  hiddenBar.children[0].children[1].hidden = true
  assert.equal(barArea(hiddenBar), null)
})

test('pinsSpot: with no bar the layout area places both views; the bar still wins over it', () => {
  const area = { x: 269, y: 80, right: 0 }
  const viewport = { width: 1280, height: 800 }
  assert.deepEqual(pinsSpot('panel', null, viewport, area), { x: 269, y: 80, width: 1011 })
  assert.deepEqual(pinsSpot('all', null, viewport, area), { x: 1280 - PINS_ALL_W - 8, y: 84, width: PINS_ALL_W })
  const bar = { x: 200, y: 42, width: 900, height: 38 }
  assert.deepEqual(pinsSpot('panel', bar, viewport, area), { x: 200, y: 80, width: 900 })
})

const listed = [{ id: 's:K1' }, { id: 's:K2' }]

test('stillOpen: only pins open on the board; all of them before it is read; a closed or answered item goes', () => {
  assert.equal(stillOpen(listed, undefined), listed)
  assert.deepEqual(stillOpen(listed, board([know('K2'), know('K3')])), [{ id: 's:K2' }])
  assert.deepEqual(stillOpen(listed, board([know('K1', { isOpen: false })])), [])
})

test('pinsOverlayEmpty: the panel goes with its pin, the popover with its last, counting Dones', () => {
  const b = board([know('K2')])
  assert.equal(pinsOverlayEmpty({ view: 'panel', id: 's:K1', list: listed }, b), true)
  assert.equal(pinsOverlayEmpty({ view: 'panel', id: 's:K2', list: listed }, b), false)
  assert.equal(pinsOverlayEmpty({ view: 'all', list: listed }, b), false)
  assert.equal(pinsOverlayEmpty({ view: 'all', list: listed }, b, new Set(['s:K2'])), true)
  assert.equal(pinsOverlayEmpty({ view: 'all', list: listed }, undefined), false)
})

test('drawnKey for a pins overlay changes only with which of its pins are open', () => {
  const key = needs => drawnKey('pins', [{ ...board(needs), at: Math.random() }], 's', listed)
  assert.equal(key([know('K1'), know('K2')]), key([know('K1'), know('K2'), know('K3')]))
  assert.notEqual(key([know('K1'), know('K2')]), key([know('K1')]))
})
