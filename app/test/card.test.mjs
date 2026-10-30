import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  SENT_HIDE_MS,
  UNDO_MS,
  answerAction,
  cardFor,
  cardHeight,
  cardHint,
  cardKeyAction,
  cardView,
  doneAction,
  nextItem,
  hiddenKeys,
  openHeight,
  openState,
  readKey,
} from '../mods/herdr-agents/model.js'
import { CardState, onBoardsChanged } from '../mods/herdr-agents/cardstate.js'
import { Outbox } from '../mods/herdr-agents/outbox.js'

const board = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))

test('answerAction is the file the plugin takes', () => {
  assert.deepEqual(answerAction('D7', 'Cursor'), { action: 'answer', key: 'D7', answer: 'Cursor' })
})

test('cardHeight grows with the options of a decision, and each face has its own', () => {
  assert.equal(cardHeight('ask', 2), 78 + 12 + 40 + 12 + 2 * 28 + 6)
  assert.equal(cardHeight('ask', 3), cardHeight('ask', 2) + 34)
  assert.equal(cardHeight('ask', 0), cardHeight('ask', 1), 'at least one row')
  assert.equal(cardHeight('ask', 99), cardHeight('ask', 6), 'at most six rows')
  assert.equal(cardHeight('do'), 170)
  assert.equal(cardHeight('blocked'), 150)
  assert.equal(cardHeight('resolved'), 118)
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

test('cardKeyAction: a chord on 1 is not 1 (ctrl-1, alt-1, cmd-1 close; they never answer or press Done)', () => {
  for (const chord of ['ctrl-1', 'alt-1', 'cmd-1', 'shift-1', 'ctrl-alt-1']) {
    assert.deepEqual(cardKeyAction('ask', chord, { options: 3 }), { type: 'close' }, chord)
    assert.deepEqual(cardKeyAction('do', chord, { url: true }), { type: 'close' }, chord)
  }
  assert.deepEqual(cardKeyAction('ask', 'ctrl', { options: 3 }), { type: 'ignore' }, 'a modifier alone')
})

test('cardHint says which keys answer and that any other key closes and is lost', () => {
  assert.match(cardHint('ask', { options: 2 }), /^1-2 answers .*any other key closes, and that key is lost$/)
  assert.match(cardHint('ask', { options: 5 }), /^1-3 answers /, 'keys stop at 3')
  assert.match(cardHint('ask', { options: 1 }), /^1 answers /)
  assert.match(cardHint('do', { url: true }), /^1 done · 2 opens the link .*is lost$/)
  assert.match(cardHint('do'), /^1 done · esc/)
  assert.match(cardHint('resolved'), /esc/)
})

test('cardFor: nothing open draws nothing; an open item whose board is gone is `gone`, which can be closed', () => {
  const b = board()
  assert.equal(cardFor([b], null), null)
  assert.equal(cardFor([b], { session: b.session, key: 'D7' }).face, 'ask')
  const gone = cardFor([], { session: b.session, key: 'D7' })
  assert.deepEqual([gone.face, gone.key], ['gone', 'D7'])
  assert.equal(cardFor([{ ...b, session: 'other' }], { session: b.session, key: 'D7' }).face, 'gone', 'another board does not stand in')
  assert.deepEqual(cardKeyAction(gone.face, 'x'), { type: 'close' })
  assert.deepEqual(cardKeyAction(gone.face, 'escape'), { type: 'close' })
})

test('cardView: a sent answer with no outcome stops counting after SENT_HIDE_MS, like hiddenKeys', () => {
  const b = board()
  const entry = { id: 'a1', session: b.session, key: 'D7', action: answerAction('D7', 'Cursor'), at: 1000 }
  assert.equal(cardView(b, 'D7', { sent: [entry], now: 1000 + SENT_HIDE_MS - 1 }).face, 'resolved')
  assert.equal(cardView(b, 'D7', { sent: [entry], now: 1000 + SENT_HIDE_MS }).face, 'ask', 'the item can be answered again')
  assert.equal(hiddenKeys([], [entry], 1000 + SENT_HIDE_MS).size, 0, 'the same limit as the lists')
})

test('openState keeps the terminal to give back while a card is already open', () => {
  assert.deepEqual(openState(null, 's', 'D7', 't1'), { session: 's', key: 'D7', back: 't1', seq: 0 })
  assert.deepEqual(openState({ session: 's', key: 'D7', back: 't1' }, 's', 'D8', 't9'), { session: 's', key: 'D8', back: 't1', seq: 0 })
  assert.deepEqual(openState(null, 's', 'D7', undefined), { session: 's', key: 'D7', back: null, seq: 0 })
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

test('a second action for the same item is refused while the first waits', () => {
  const { t, box, cx } = outbox()
  const first = box.schedule(cx, 's', answerAction('D7', 'Cursor'))
  assert.equal(box.schedule(cx, 's', answerAction('D7', 'Offset')), null)
  assert.equal(box.schedule(cx, 'other', answerAction('D7', 'Offset')) !== null, true, 'another board is another item')
  assert.deepEqual(
    box.queue.filter(q => q.session === 's').map(q => q.id),
    [first],
  )
  box.undo(first)
  assert.notEqual(box.schedule(cx, 's', answerAction('D7', 'Offset')), null, 'after undo it can be answered again')
  assert.equal(t.timers.length, 3)
})

function state({ open = { session: 's', key: 'D7' } } = {}) {
  const t = { runs: [], notes: [], sends: [], notified: 0, now: 1000 }
  const ctl = new CardState({
    send: async (session, action, id) => t.sends.push({ session, action, id }),
    notify: n => t.notes.push(n),
    handle: {},
    run: (name, args) => t.runs.push([name, args]),
    open,
  })
  ctl.outbox.now = () => t.now
  const jobs = []
  const cx = {
    timer: { after: () => {} },
    notify: () => t.notified++,
    spawn: fn => jobs.push(fn({ notify: () => t.notified++ })),
    jobs,
  }
  return { t, ctl, cx }
}

test('a failed answer returns to the options and the card never resizes the terminal on the way', async () => {
  const b = board()
  const { t, ctl, cx } = state({ open: { session: b.session, key: 'D7' } })
  const id = ctl.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  assert.equal(cardFor([b], { session: b.session, key: 'D7' }, { queue: ctl.outbox.queue }).face, 'resolved')
  t.now += UNDO_MS + 50
  ctl.outbox.flush(cx)
  await Promise.all(cx.jobs)
  assert.equal(t.sends.length, 1)
  const failed = { ...b, actions: [{ id, ok: false, message: 'D7 is not an open decision' }] }
  assert.equal(ctl.onBoards([failed]), true)
  const view = cardFor([failed], { session: b.session, key: 'D7' }, { queue: ctl.outbox.queue, sent: ctl.outbox.sent })
  assert.equal(view.face, 'ask', 'the options are back')
  assert.deepEqual(view.options, ['Cursor', 'Offset'])
  assert.deepEqual(
    t.notes.map(n => [n.title, n.level]),
    [['Action failed', 'error']],
  )
  assert.deepEqual(t.runs, [], 'no layout.resize, show or hide: only the owner changes the panel')
  ctl.undo(ctl.schedule(cx, b.session, answerAction('D8', 'Light')))
  assert.deepEqual(t.runs, [], 'nor does undo')
})

test('a card copy that starts with nothing open hides a panel left shown; with an item open it leaves the panel alone', () => {
  assert.deepEqual(state({ open: null }).t.runs, [['layout.hide', { id: 'hrd-card' }]])
  assert.deepEqual(state().t.runs, [])
})

test('every board change settles the card outbox, so a failed send shows (the parts main.js hands the boards to)', async () => {
  const b = board()
  const { t, ctl, cx } = state({ open: { session: b.session, key: 'D7' } })
  const id = ctl.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  t.now += UNDO_MS + 50
  ctl.outbox.flush(cx)
  await Promise.all(cx.jobs)
  const calls = []
  const pin = { onBoards: bs => calls.push(['pin', bs.length]) }
  const strip = { observe: (_cx, bs) => calls.push(['strip', bs.length]) }
  const failed = { ...b, actions: [{ id, ok: false, message: 'no such item' }] }
  onBoardsChanged({ pinbar: false, pin, card: ctl, strip }, [failed], cx)
  assert.deepEqual(calls, [['strip', 1]], 'the pin bar copy only for the pin bar role')
  assert.deepEqual(
    t.notes.map(n => n.body),
    ['no such item'],
  )
  onBoardsChanged({ pinbar: true, pin, card: null, strip: null }, [failed], cx)
  assert.deepEqual(calls.at(-1), ['pin', 1])
})

test('openHeight does not count an old sent answer, so `next` sizes the panel for the options it draws', () => {
  const b = board()
  const entry = { id: 'a1', session: b.session, key: 'D7', action: answerAction('D7', 'Cursor'), at: 1000 }
  const ask = cardHeight('ask', 2)
  assert.equal(openHeight(b, 'D7', { sent: [entry], now: 1000 }), cardHeight('resolved'))
  assert.equal(openHeight(b, 'D7', { sent: [entry], now: 1000 + SENT_HIDE_MS }), ask)
})

test('every open bumps the counter in the state, so reopening the same item is a new open', () => {
  const first = openState(null, 's', 'D7', 't1', 1)
  const again = openState(null, 's', 'D7', 't1', 2)
  assert.notEqual(first.seq, again.seq)
  assert.equal(openState(first, 's', 'D8', 't2', 2).back, 't1', 'the terminal to give back is kept')
  const src = readFileSync(new URL('../mods/herdr-agents/card.js', import.meta.url), 'utf8')
  assert.match(src, /open\.seq/, 'the keyboard token follows the counter, not a hidden copy drawing')
})

test('a key held down is ignored, so an answer is not followed by a close', () => {
  assert.equal(cardKeyAction('ask', '1', { options: 2, held: true }).type, 'ignore')
  assert.equal(cardKeyAction('ask', 'escape', { options: 2, held: true }).type, 'ignore')
  assert.equal(cardKeyAction('ask', '1', { options: 2 }).type, 'answer')
})
