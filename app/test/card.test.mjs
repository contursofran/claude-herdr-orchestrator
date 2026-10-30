import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  UNDO_MS,
  answerAction,
  cardHeight,
  cardKeyAction,
  cardView,
  doneAction,
  nextItem,
  openState,
  readKey,
} from '../mods/herdr-agents/model.js'
import { Outbox } from '../mods/herdr-agents/outbox.js'

const board = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))

test('answerAction is the file the plugin takes', () => {
  assert.deepEqual(answerAction('D7', 'Cursor'), { action: 'answer', key: 'D7', answer: 'Cursor' })
})

test('cardHeight grows with the options of a decision, and each face has its own', () => {
  assert.equal(cardHeight('ask', 2), 50 + 12 + 40 + 12 + 2 * 28 + 6)
  assert.equal(cardHeight('ask', 3), cardHeight('ask', 2) + 34)
  assert.equal(cardHeight('ask', 0), cardHeight('ask', 1), 'at least one row')
  assert.equal(cardHeight('ask', 99), cardHeight('ask', 6), 'at most six rows')
  assert.equal(cardHeight('do'), 142)
  assert.equal(cardHeight('blocked'), 122)
  assert.equal(cardHeight('resolved'), 90)
})

test('cardView: a decision shows its options and the recommended one', () => {
  const v = cardView(board(), 'D7', { now: 1790000000000 })
  assert.equal(v.face, 'ask')
  assert.deepEqual(v.options, ['Cursor', 'Offset'])
  assert.equal(v.recommended, 0)
  assert.equal(v.title, 'Pagination style')
  assert.match(v.meta, /^w-api/)
})

test('cardView: a to-do has Done, and a link only with a url', () => {
  const b = board()
  assert.equal(cardView(b, 'T12').face, 'do')
  assert.equal(cardView(b, 'T12').url, null)
  b.needs.find(n => n.key === 'T12').url = 'https://example.com/x'
  assert.equal(cardView(b, 'T12').url, 'https://example.com/x')
})

test('cardView: a blocked worker shows its tab, an unknown or closed item is resolved', () => {
  const b = board()
  const v = cardView(b, 'w:w-stuck', { terminals: [{ name: 'w-stuck', address: 't9' }] })
  assert.equal(v.face, 'blocked')
  assert.equal(v.terminal, 't9')
  assert.equal(cardView(b, 'w:w-api').face, 'resolved', 'a worker that is no longer blocked')
  assert.equal(cardView(b, 'nope').face, 'resolved')
  assert.equal(cardView(null, 'D7'), null)
})

test('cardView: an action that waits shows undo; one that went out shows sent', () => {
  const b = board()
  const queue = [{ id: 'a1', session: b.session, key: 'D7', action: answerAction('D7', 'Cursor') }]
  const waiting = cardView(b, 'D7', { queue })
  assert.deepEqual(
    [waiting.face, waiting.verb, waiting.detail, waiting.sent, waiting.undoId],
    ['resolved', 'answer', 'Cursor', false, 'a1'],
  )
  const sent = cardView(b, 'D7', { sent: [{ id: 'a1', session: b.session, key: 'D7', action: answerAction('D7', 'Cursor') }] })
  assert.deepEqual([sent.face, sent.sent, sent.undoId], ['resolved', true, null])
  const other = cardView(b, 'D7', { queue: [{ id: 'a2', session: 'another', key: 'D7', action: doneAction('D7') }] })
  assert.equal(other.face, 'ask', 'an action of another board does not count')
})

test('nextItem: the next open item, wrapping, leaving out the answered ones', () => {
  const b = board()
  assert.equal(nextItem(b, 'D7').key, 'D8')
  assert.equal(nextItem(b, 'D7', new Set([readKey(b.session, 'D8')])).key, 'T12')
  const last = nextItem(b, 'T12')
  assert.ok(last, 'wraps to the first')
  const only = { ...b, workers: [], needs: b.needs.filter(n => n.key === 'D7') }
  assert.equal(nextItem(only, 'D7'), null)
  assert.equal(nextItem({ ...b, needs: [], workers: [] }, 'D7'), null)
})

test('cardKeyAction: 1-3 answer, Esc and any other key close, a lone modifier does nothing', () => {
  assert.deepEqual(cardKeyAction('ask', '2', { options: 3 }), { type: 'answer', index: 1 })
  assert.deepEqual(cardKeyAction('ask', '3', { options: 2 }), { type: 'close' }, 'no third option')
  assert.deepEqual(cardKeyAction('ask', '4', { options: 5 }), { type: 'close' }, 'keys stop at 3')
  assert.deepEqual(cardKeyAction('ask', 'escape'), { type: 'close' })
  assert.deepEqual(cardKeyAction('ask', 'x', { options: 2 }), { type: 'close' })
  assert.deepEqual(cardKeyAction('ask', 'Shift', { options: 2 }), { type: 'ignore' })
  assert.deepEqual(cardKeyAction('do', '1'), { type: 'done' })
  assert.deepEqual(cardKeyAction('do', '2', { url: true }), { type: 'link' })
  assert.deepEqual(cardKeyAction('do', '2'), { type: 'close' })
  assert.deepEqual(cardKeyAction('resolved', '1'), { type: 'close' })
})

test('openState keeps the terminal to give back while a card is already open', () => {
  assert.deepEqual(openState(null, 's', 'D7', 't1'), { session: 's', key: 'D7', back: 't1' })
  assert.deepEqual(openState({ session: 's', key: 'D7', back: 't1' }, 's', 'D8', 't9'), { session: 's', key: 'D8', back: 't1' })
  assert.deepEqual(openState(null, 's', 'D7', undefined), { session: 's', key: 'D7', back: null })
})

function outbox() {
  const t = { now: 1000, sends: [], notes: [], timers: [] }
  const box = new Outbox({
    send: async (session, action, id) => t.sends.push({ session, action, id }),
    notify: n => t.notes.push(n),
    now: () => t.now,
  })
  const jobs = []
  const cx = { timer: { after: (ms, fn) => t.timers.push({ ms, fn }) }, spawn: fn => jobs.push(fn({ notify() {} })), jobs }
  return { t, box, cx }
}

test('an answer goes out only after the undo window, and undo cancels it', async () => {
  const { t, box, cx } = outbox()
  const a = box.schedule(cx, 's', answerAction('D7', 'Cursor'))
  box.flush(cx)
  assert.equal(t.sends.length, 0, 'not before the window')
  t.now += UNDO_MS + 50
  box.flush(cx)
  await Promise.all(cx.jobs)
  assert.deepEqual(
    t.sends.map(s => [s.session, s.action, s.id]),
    [['s', answerAction('D7', 'Cursor'), a]],
  )
  assert.deepEqual(box.sent[0].action, answerAction('D7', 'Cursor'), 'the card shows what was sent')

  const b = box.schedule(cx, 's', answerAction('D8', 'Light'))
  box.undo(b)
  t.now += UNDO_MS + 50
  box.flush(cx)
  await Promise.all(cx.jobs)
  assert.equal(t.sends.length, 1, 'an undone answer is never sent')
})

test("the card's own outbox reports a failed send (ok:false) when it settles the boards", async () => {
  const { t, box, cx } = outbox()
  const id = box.schedule(cx, 's', answerAction('D7', 'Cursor'))
  t.now += UNDO_MS + 50
  box.flush(cx)
  await Promise.all(cx.jobs)
  const failed = { session: 's', needs: [{ key: 'D7', kind: 'ask', isOpen: true }], actions: [{ id, ok: false, message: 'no such item' }] }
  assert.equal(box.settle([failed]), true)
  assert.deepEqual(
    t.notes.map(n => [n.title, n.body, n.level]),
    [['Action failed', 'no such item', 'error']],
  )
})

test('card.js settles its own outbox on every board change (main.js hands it the boards)', () => {
  const main = readFileSync(new URL('../mods/herdr-agents/main.js', import.meta.url), 'utf8')
  assert.match(main, /this\.card\?\.onBoards\(this\.boards\.list\(\)\)/)
  const card = readFileSync(new URL('../mods/herdr-agents/card.js', import.meta.url), 'utf8')
  assert.match(card, /onBoards\(boards\)\s*{\s*return this\.outbox\.settle\(boards\)/)
})
