import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CardState } from '../mods/herdr-agents/cardstate.js'
import { CopyState } from '../mods/herdr-agents/copystate.js'
import { dropHeld, heldBy, heldKeys, noteHeld, surfaceFor } from '../mods/herdr-agents/heldmodel.js'
import {
  FAIL_LINE_MS,
  ROWS_SETTLE_MS,
  SENT_HIDE_MS,
  answerAction,
  cardKeyAction,
  holdRefocus,
  nextItem,
  quietLine,
  quietLines,
} from '../mods/herdr-agents/model.js'
import { sheetNext } from '../mods/herdr-agents/sheetmodel.js'

const board = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))
const state = () => new CardState({ send: async () => {}, notify() {}, handle: null })
const cxOf = () => ({ timer: { after() {} }, spawn() {}, notify() {} })
const sharedOf = surface => {
  const store = {}
  return { store, held: { get: () => store.held, set: v => (store.held = v), surface } }
}

test('an answer in the sheet is known to the card: its strip tab opens where the undo is, and it is not offered twice', () => {
  const b = board()
  const store = {}
  const sheet = state()
  const card = state()
  const held = surface => ({ get: () => store.held, set: v => (store.held = v), surface })
  sheet.step(cxOf(), b.session, answerAction('D7', 'Cursor'), {
    now: 1000,
    next: () => null,
    go() {},
    close() {},
    held: held('sheet'),
  })
  assert.equal(card.outbox.queue.length, 0, 'the card copy has no queue of its own for it')
  assert.equal(surfaceFor(store.held, 'card', b.session, 'D7', 1500), 'sheet', 'the card opens the sheet instead')
  assert.equal(surfaceFor(store.held, 'card', b.session, 'D8', 1500), 'card', 'other items open as asked')
  // The card moving on skips what the sheet holds.
  const hidden = card.hiddenAll(held('card'), 1500)
  assert.equal(nextItem(b, 'K3', hidden)?.key === 'D7', false)
  assert.equal(sheetNext(b, 'T12', hidden)?.key === 'D7', false)
  assert.ok(hidden.has(`${b.session}:D7`))
})

test('undo drops the record, and a record older than SENT_HIDE_MS no longer redirects or hides', () => {
  const b = board()
  let held = noteHeld({}, 'sheet', b.session, 'D7', 1000)
  assert.equal(heldBy(held, b.session, 'D7', 1000 + SENT_HIDE_MS - 1), 'sheet')
  assert.equal(heldBy(held, b.session, 'D7', 1000 + SENT_HIDE_MS), null)
  assert.equal(heldKeys(held, 1000 + SENT_HIDE_MS).size, 0)
  const s = state()
  const store = { held }
  const h = { get: () => store.held, set: v => (store.held = v), surface: 'sheet' }
  s.step(cxOf(), b.session, answerAction('D8', 'Dark'), { now: 2000, next: () => null, go() {}, close() {}, held: h })
  assert.equal(heldBy(store.held, b.session, 'D8', 2001), 'sheet')
  const line = quietLines(b, 'D7', { queue: s.outbox.queue, now: 2001 })[0]
  s.undoTo(line, () => {}, { held: h, session: b.session, now: 2100 })
  assert.equal(heldBy(store.held, b.session, 'D8', 2101), null, 'undone: the record is gone')
  assert.equal(dropHeld({}, 's', 'x') instanceof Object, true)
  // A new record prunes the old ones.
  assert.equal(Object.keys(noteHeld(held, 'card', b.session, 'D9', 1000 + SENT_HIDE_MS)).length, 1)
})

test('a failure and a waiting action are both on the quiet lines, undo first', () => {
  const b = board()
  const queue = [{ id: 'q8', session: b.session, key: 'D8', action: answerAction('D8', 'Dark') }]
  const failed = [{ session: b.session, key: 'D7', action: answerAction('D7', 'Cursor'), at: 1000 }]
  const lines = quietLines(b, 'T12', { queue, failed, now: 1000 + FAIL_LINE_MS - 1 })
  assert.deepEqual(
    lines.map(l => [l.kind, l.key]),
    [
      ['waiting', 'D8'],
      ['failed', 'D7'],
    ],
  )
  assert.equal(quietLine(b, 'T12', { queue, failed, now: 1001 }).kind, 'waiting', 'undo wins the single line')
  assert.deepEqual(
    quietLines(b, 'T12', { queue: [], failed, now: 1001 }).map(l => l.kind),
    ['failed'],
    'undo gone: the failure stays',
  )
})

test('a selection made on one item is forgotten when the sheet shows another', () => {
  const c = new CopyState()
  c.moveTo('s:D7')
  c.mouseDown({ position: { x: 1, y: 1 }, click_count: 2 })
  assert.equal(c.selected, true)
  c.moveTo('s:D7')
  assert.equal(c.selected, true, 'same item: kept')
  c.moveTo('s:D8')
  assert.equal(c.selected, false)
})

test('during the hold 1-3 do nothing at all, whatever the next item is; Esc and other keys still work', () => {
  const ask = { options: 2, url: false, settling: true }
  assert.equal(cardKeyAction('ask', '3', ask).type, 'ignore', 'no option 3 on the next item: no close')
  assert.equal(cardKeyAction('do', '2', { url: true, settling: true }).type, 'ignore', 'no link')
  assert.equal(cardKeyAction('blocked', '1', { settling: true }).type, 'ignore')
  assert.equal(cardKeyAction('ask', 'escape', ask).type, 'close')
  assert.equal(cardKeyAction('ask', 'x', ask).type, 'close')
  assert.equal(cardKeyAction('ask', '1', { ...ask, settling: false }).type, 'answer')
})

test('going back with undo holds off presses for a moment like any other move', () => {
  const b = board()
  const s = state()
  s.step(cxOf(), b.session, answerAction('D7', 'Cursor'), { now: 1000, next: () => ({ key: 'D8' }), go() {}, close() {} })
  s.movedAt = undefined
  const line = quietLines(b, 'D8', { queue: s.outbox.queue, now: 1000 })[0]
  s.undoTo(line, () => {}, { now: 5000 })
  assert.equal(s.movedAt, 5000)
  assert.equal(
    s.step(cxOf(), b.session, answerAction('D7', 'Offset'), { now: 5000 + ROWS_SETTLE_MS - 1, next: () => null, go() {}, close() {} }),
    'ignored',
  )
})

test('after the last item closes, the keyboard goes back only if the owner is still where the surface was', () => {
  const closed = { back: 't1', space: 's1' }
  const at = { focusedTerminal: 't1', space: 's1', open: false }
  assert.equal(holdRefocus(closed, at), true)
  assert.equal(holdRefocus(closed, { ...at, focusedTerminal: null }), true)
  assert.equal(holdRefocus(closed, { ...at, focusedTerminal: 't2' }), false, 'clicked another terminal: leave it there')
  assert.equal(holdRefocus(closed, { ...at, space: 's2' }), false, 'moved to another space')
  assert.equal(holdRefocus(closed, { ...at, open: true }), false, 'another surface opened meanwhile')
  assert.equal(holdRefocus({ space: 's1' }, at), false, 'nothing to give back')
})
