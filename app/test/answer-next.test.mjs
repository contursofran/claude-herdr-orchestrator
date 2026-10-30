import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  FAIL_LINE_MS,
  ROWS_SETTLE_MS,
  UNDO_MS,
  answerAction,
  cardView,
  doneAction,
  nextItem,
  quietLine,
  showNext,
} from '../mods/herdr-agents/model.js'
import { sheetNext, sheetView } from '../mods/herdr-agents/sheetmodel.js'
import { CardState } from '../mods/herdr-agents/cardstate.js'

const board = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))

function setup({ fail = false } = {}) {
  const t = { now: 1000, calls: [], notes: [], timers: [] }
  const ctl = new CardState({
    send: async () => {
      if (fail) throw new Error('mv failed')
    },
    notify: n => t.notes.push(n),
    handle: null,
  })
  ctl.outbox.now = () => t.now
  const jobs = []
  const cx = {
    timer: { after: (ms, fn) => t.timers.push({ ms, fn }) },
    spawn: fn => jobs.push(fn({ notify() {} })),
    notify() {},
    jobs,
  }
  const b = board()
  const hooks = (next = hidden => nextItem(b, t.key, hidden)) => ({
    now: t.now,
    next,
    go: item => t.calls.push(['go', item.key]),
    close: () => t.calls.push(['close']),
  })
  return { t, ctl, cx, b, hooks }
}

test('an answer with another open item moves to it at once, and with none left closes', () => {
  const { t, ctl, cx, b, hooks } = setup()
  t.key = 'D7'
  assert.equal(ctl.step(cx, b.session, answerAction('D7', 'Cursor'), hooks()), 'moved')
  assert.deepEqual(t.calls, [['go', 'D8']])
  // Only one open item on the board: nothing to move to.
  const one = setup()
  one.b.needs = one.b.needs.filter(n => n.key === 'D7')
  one.b.workers = []
  one.t.key = 'D7'
  assert.equal(one.ctl.step(one.cx, one.b.session, answerAction('D7', 'Cursor'), one.hooks()), 'closed')
  assert.deepEqual(one.t.calls, [['close']])
})

test('Done moves on or closes the same way, and the item just done is never the one moved to', () => {
  const { t, ctl, cx, b, hooks } = setup()
  t.key = 'T13'
  b.needs = b.needs.filter(n => n.kind === 'do')
  b.workers = []
  ctl.step(cx, b.session, doneAction('T13'), hooks())
  assert.deepEqual(t.calls, [['go', 'T12']], 'wraps to the other to-do, not back to T13')
})

test('a press right after a move is ignored, silently; after ROWS_SETTLE_MS it counts', () => {
  const { t, ctl, cx, b, hooks } = setup()
  t.key = 'D7'
  ctl.step(cx, b.session, answerAction('D7', 'Cursor'), hooks())
  t.key = 'D8'
  const quick = { ...hooks(), now: t.now + ROWS_SETTLE_MS - 1 }
  assert.equal(ctl.step(cx, b.session, answerAction('D8', 'Dark'), quick), 'ignored')
  assert.equal(ctl.outbox.queue.length, 1, 'nothing was queued for D8')
  assert.deepEqual(t.calls, [['go', 'D8']], 'and nothing moved or closed')
  const later = { ...hooks(), now: t.now + ROWS_SETTLE_MS }
  assert.equal(ctl.step(cx, b.session, answerAction('D8', 'Dark'), later), 'moved')
})

test('a second press for the item already queued does nothing', () => {
  const { t, ctl, cx, b, hooks } = setup()
  t.key = 'D7'
  ctl.step(cx, b.session, answerAction('D7', 'Cursor'), hooks())
  const again = { ...hooks(), now: t.now + 2000 }
  assert.equal(ctl.step(cx, b.session, answerAction('D7', 'Offset'), again), 'ignored')
  assert.equal(ctl.outbox.queue.length, 1)
})

test('the sheet pages to the next open item that is not answered, wrapping, and has none when alone', () => {
  const b = board()
  const hidden = new Set([`${b.session}:D8`])
  assert.deepEqual(sheetNext(b, 'D7', hidden), { key: 'T12' }, 'D8 is answered: skipped')
  assert.deepEqual(sheetNext(b, 'K5', new Set()), { key: 'D7' }, 'wraps')
  b.needs = b.needs.filter(n => n.key === 'K3')
  assert.equal(sheetNext(b, 'K3', new Set()), null)
  assert.equal(sheetNext(b, 'zz', new Set())?.key, 'K3', 'an item no longer open: the first one')
})

test('the next item shows one quiet line with the choice and an undo while the send waits', () => {
  const { t, ctl, cx, b, hooks } = setup()
  t.key = 'D7'
  ctl.step(cx, b.session, answerAction('D7', 'Cursor'), hooks())
  const line = quietLine(b, 'D8', { queue: ctl.outbox.queue, failed: ctl.outbox.failed, now: t.now })
  assert.deepEqual(
    { ...line, undoId: Boolean(line.undoId) },
    { kind: 'waiting', key: 'D7', verb: 'answer', detail: 'Cursor', undoId: true },
  )
  assert.equal(quietLine(b, 'D7', { queue: ctl.outbox.queue, now: t.now }), null, 'not on the item it is about')
  assert.equal(quietLine(b, 'D8', { queue: ctl.outbox.queue, sent: [], now: t.now }).kind, 'waiting')
  ctl.outbox.queue = []
  assert.equal(quietLine(b, 'D8', { queue: ctl.outbox.queue, now: t.now }), null, 'gone once the send went out')
  assert.equal(quietLine(null, 'D8', { queue: [{ session: 's', key: 'D7', action: doneAction('D7') }] }), null)
})

test('undo on the quiet line cancels the action and goes back to its item', () => {
  const { t, ctl, cx, b, hooks } = setup()
  t.key = 'D7'
  ctl.step(cx, b.session, answerAction('D7', 'Cursor'), hooks())
  const line = quietLine(b, 'D8', { queue: ctl.outbox.queue, now: t.now })
  ctl.undoTo(line, item => t.calls.push(['back', item.key]))
  assert.equal(ctl.outbox.queue.length, 0)
  assert.deepEqual(t.calls.at(-1), ['back', 'D7'])
  assert.equal(ctl.outbox.hidden().size, 0, 'the item shows again')
})

test('a send that fails after moving on shows on the quiet line with retry, and a new try clears it', async () => {
  const { t, ctl, cx, b, hooks } = setup({ fail: true })
  t.key = 'D7'
  ctl.step(cx, b.session, answerAction('D7', 'Cursor'), hooks())
  t.now += UNDO_MS + 50
  ctl.outbox.flush(cx)
  await Promise.all(cx.jobs)
  assert.equal(t.notes[0].title, 'Could not send', 'the notice still shows')
  const line = quietLine(b, 'D8', { queue: ctl.outbox.queue, failed: ctl.outbox.failed, now: t.now })
  assert.deepEqual(
    { kind: line.kind, key: line.key, detail: line.detail, undoId: line.undoId },
    { kind: 'failed', key: 'D7', detail: 'Cursor', undoId: null },
  )
  assert.equal(quietLine(b, 'D8', { failed: ctl.outbox.failed, now: t.now + FAIL_LINE_MS }), null, 'it expires')
  ctl.undoTo(line, item => t.calls.push(['back', item.key]))
  assert.deepEqual(t.calls.at(-1), ['back', 'D7'], 'retry goes to the item')
  ctl.schedule(cx, b.session, answerAction('D7', 'Offset'))
  assert.equal(ctl.outbox.failed.length, 0, 'a new try on the item replaces the failure')
})

test('a failure the board reports (ok:false) reaches the quiet line too', () => {
  const { t, ctl, b } = setup()
  ctl.outbox.sent = [{ id: 'a1', session: b.session, key: 'D7', action: answerAction('D7', 'Cursor'), at: t.now }]
  b.actions = [{ id: 'a1', ok: false, message: 'nope' }]
  ctl.onBoards([b])
  assert.equal(quietLine(b, 'D8', { failed: ctl.outbox.failed, now: t.now }).kind, 'failed')
})

test('a status face with a choice made here has no next; only a closed item keeps it', () => {
  const b = board()
  const out = { queue: [{ id: 'x', session: b.session, key: 'D7', action: answerAction('D7', 'Cursor') }], now: 0 }
  assert.equal(cardView(b, 'D7', out).verb, 'answer')
  b.needs.find(n => n.key === 'D7').isOpen = false
  assert.equal(cardView(b, 'D7').verb, 'closed')
  assert.equal(sheetView(b, 'D7').verb, 'closed')
  assert.equal(showNext(cardView(b, 'D7'), { key: 'D8' }), true, 'closed from elsewhere: next stays')
  assert.equal(showNext(cardView(b, 'D7'), null), false)
  b.needs.find(n => n.key === 'D7').isOpen = true
  assert.equal(showNext(cardView(b, 'D7', out), { key: 'D8' }), false, 'a choice made here: no next')
})
