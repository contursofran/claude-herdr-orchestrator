import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PINS_ALL_W,
  allPinsHeight,
  markAllRead,
  markRead,
  orderPins,
  panelHeight,
  pins,
  pinsSpot,
  readKey,
  takeDoneRequest,
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

test('takeDoneRequest: each request is taken once, by its n; none or an empty one is ignored', () => {
  const req = { session: 's', key: 'K1', n: 'a' }
  assert.deepEqual(takeDoneRequest(req, null), { request: { session: 's', key: 'K1' }, seen: 'a' })
  assert.deepEqual(takeDoneRequest(req, 'a'), { request: null, seen: 'a' })
  assert.deepEqual(takeDoneRequest({ ...req, n: 'b' }, 'a'), { request: { session: 's', key: 'K1' }, seen: 'b' })
  assert.deepEqual(takeDoneRequest(null, 'a'), { request: null, seen: 'a' })
  assert.deepEqual(takeDoneRequest({ session: 's', n: 'c' }, null), { request: null, seen: null })
})

test('panelHeight grows with the lines of the text, up to a cap; allPinsHeight with the pins, up to four rows', () => {
  assert.ok(panelHeight('x'.repeat(2000), 900) > panelHeight('x', 900))
  assert.equal(panelHeight('a\nb\nc', 900) - panelHeight('a', 900), 40)
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
