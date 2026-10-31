import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { app, findId, textOf } from './fake-gpui.mjs'

// After the fake is registered: these import `gpui-kit` and `herdr`.
const { card, makeCardState } = await import('../mods/herdr-agents/card.js')
const { closeCardHeld, openCard } = await import('../mods/herdr-agents/cardctl.js')
const { CardState } = await import('../mods/herdr-agents/cardstate.js')
const { CopyState } = await import('../mods/herdr-agents/copystate.js')
const { makePopupState, popupView } = await import('../mods/herdr-agents/popup.js')
const { Outbox, sharedOutbox } = await import('../mods/herdr-agents/outbox.js')
const { makeSheetState, sheetBlock } = await import('../mods/herdr-agents/sheet.js')
const { closeSheetHeld, openSheet } = await import('../mods/herdr-agents/sheetctl.js')
const { StripState, toggleSheet } = await import('../mods/herdr-agents/strip.js')
const { FAIL_LINE_MS, ROWS_SETTLE_MS, SENT_HIDE_MS, UNDO_MS, answerAction, cardFor, cardKeyAction, doneAction, holdRefocus } = await import(
  '../mods/herdr-agents/model.js'
)
const { nextItem, quietLine, quietLines, stripItems, surfaceOpen } = await import('../mods/herdr-agents/model.js')
const { sheetView } = await import('../mods/herdr-agents/sheetmodel.js')

const board = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))
/** A board with only these items open, and no worker stuck (those come first in "next item"). */
const only = (...keys) => {
  const b = board()
  for (const n of b.needs) n.isOpen = keys.includes(n.key)
  b.workers = b.workers.filter(w => w.state !== 'blocked')
  return b
}
const handle = () => {
  const h = { on: false, focus: () => (h.on = true), is_focused: () => h.on }
  return h
}

/** The card and sheet copies as main.js makes them: one store, shared("hrd.outbox"). A send goes to `sends`, or fails. */
function copies() {
  const t = { sends: [], notes: [], jobs: [], fail: false, now: Date.now() }
  const cx = {
    notify() {},
    spawn: fn => t.jobs.push(fn(cx)),
    sleep: async () => {},
    timer: { after() {} },
    focus_handle: handle,
  }
  const make = maker => {
    const ctl = maker(cx)
    ctl.outbox.now = () => t.now
    ctl.outbox.notify = n => t.notes.push(n)
    ctl.outbox.send = async (session, action, id) => {
      if (t.fail) throw new Error('mv failed')
      t.sends.push({ session, action, id })
    }
    return ctl
  }
  const c = make(makeCardState)
  const s = make(makeSheetState)
  const steady = () => {
    c.movedAt = undefined
    s.movedAt = undefined
  }
  /** Time passes until what waits goes out; this copy's timer fires. */
  const flush = async (ctl = c) => {
    t.now += UNDO_MS + 50
    ctl.outbox.flush(cx)
    await Promise.all(t.jobs)
  }
  return { t, cx, c, s, make, steady, flush }
}
const press = (el, id, cx) => findId(el, id).node.calls.on_mouse_down[1]({}, cx)
const key = (el, id, cx, k) => findId(el, id).node.calls.on_key_down[0]({ key: k }, cx)
/** What the open surface shows: its undo, whether its options are live, and its text. */
const shows = (el, prefix) => ({
  undo: Boolean(findId(el, `${prefix}-undo`)),
  live: Boolean(findId(el, `${prefix}-opt-0`)),
  text: textOf(el).join(' '),
})

beforeEach(() => {
  app.store = {}
  app.notes = []
  app.settings = { zoom: 1 }
  app.focused = { terminal: 't1', space: 's1' }
  app.ran = []
  app.props = null
  globalThis.window = { viewport_size: () => ({ width: 1280, height: 821 }) }
})

test('blocker: answer in the card, cmd-J onto another item, press the arrow: undo shows, not live options, and no second answer', () => {
  const b = board()
  const { cx, c, s, steady } = copies()
  openCard(b, { key: 'D7' })
  press(card([b], c, cx), 'card-opt-0', cx)
  assert.equal(app.store['hrd.open'].key, 'D8', 'the card moved on')
  toggleSheet(b)
  assert.equal(app.store['hrd.sheet'].key, 'D8')
  press(sheetBlock([b], s, cx), 'sheet-prev', cx)
  assert.equal(app.store['hrd.sheet'].key, 'D7')
  const el = sheetBlock([b], s, cx)
  const seen = shows(el, 'sheet')
  assert.equal(seen.undo, true, 'its undo is here')
  assert.equal(seen.live, false, 'no live options to press')
  steady()
  key(el, 'sheet-body', cx, '1')
  assert.equal(s.step(cx, b.session, answerAction('D7', 'Offset'), { now: 1, next: () => null, go() {}, close() {} }), 'ignored')
  assert.deepEqual(
    c.outbox.queue.map(q => q.key),
    ['D7'],
    'D7 is queued once, and both copies see the same queue',
  )
  assert.equal(s.outbox.queue, c.outbox.queue)
})

test('no item is answered twice, from any way of opening it, and each shows the undo', () => {
  const b = board()
  const entries = {
    'strip tab': () => new StripState().pick(b, { key: 'D7' }, true),
    pickN: cx => {
      const strip = Object.assign(new StripState(), { board: b })
      strip.command(`herdr-agents.pick${stripItems(b).findIndex(i => i.key === 'D7') + 1}`, cx)
    },
    'cmd-J': () => {
      app.store['hrd.open'] = { session: b.session, key: 'D7' }
      toggleSheet(b)
    },
    'board row': cx => {
      app.props = { role: 'board', session: b.session, height: 400, overlay: 'o1' }
      press(popupView(b, makePopupState(cx)), 'work-k1', cx)
    },
  }
  for (const [name, enter] of Object.entries(entries)) {
    app.store = {}
    const { cx, c, s, steady } = copies()
    assert.ok(c.schedule(cx, b.session, answerAction('D7', 'Cursor')), name)
    enter(cx)
    steady()
    const sheet = Boolean(app.store['hrd.sheet'])
    const el = sheet ? sheetBlock([b], s, cx) : card([b], c, cx)
    const seen = shows(el, sheet ? 'sheet' : 'card')
    assert.equal(seen.undo, true, `${name}: undo shows`)
    assert.equal(seen.live, false, `${name}: no live options`)
    key(el, sheet ? 'sheet-body' : 'card-body', cx, '1')
    assert.equal(c.outbox.queue.length, 1, `${name}: not answered again`)
    const ctl = sheet ? s : c
    assert.equal(ctl.schedule(cx, b.session, answerAction('D7', 'Offset')), null, `${name}: refused`)
  }
})

test('an item already sent is refused too, and card next skips what any copy holds', async () => {
  const b = only('D7', 'D8', 'T12')
  const { cx, c, s, steady, flush } = copies()
  s.schedule(cx, b.session, answerAction('D8', 'Dark'))
  await flush()
  assert.equal(c.outbox.sent.length, 1)
  assert.equal(c.schedule(cx, b.session, answerAction('D8', 'Light')), null, 'sent and not settled: one answer only')
  assert.equal(nextItem(b, 'D7', c.outbox.hidden())?.key, 'T12')
  // `next ›` on an item closed from elsewhere.
  const closed = only('D8', 'T12')
  openCard(closed, { key: 'D7' })
  steady()
  press(card([closed], c, cx), 'card-next', cx)
  assert.equal(app.store['hrd.open'].key, 'T12', 'not D8: it went out')
})

test('undo works from whichever surface opens the item, whichever queued it', () => {
  const b = board()
  for (const [queuer, other, draw, open, id] of [
    ['c', 's', sheetBlock, () => openSheet(b, 'D7'), 'sheet-undo'],
    ['s', 'c', card, () => openCard(b, { key: 'D7' }), 'card-undo'],
  ]) {
    app.store = {}
    const all = copies()
    assert.ok(all[queuer].schedule(all.cx, b.session, answerAction('D7', 'Cursor')))
    open()
    press(draw([b], all[other], all.cx), id, all.cx)
    assert.equal(all[queuer].outbox.queue.length, 0, 'gone from the one queue')
    assert.equal(shows(draw([b], all[other], all.cx), id.split('-')[0]).live, true, 'the options are back')
  }
})

test('the undo row on another item works from the other surface too', () => {
  const b = board()
  const { cx, c, s, steady } = copies()
  openCard(b, { key: 'D7' })
  press(card([b], c, cx), 'card-opt-0', cx)
  toggleSheet(b)
  steady()
  press(sheetBlock([b], s, cx), 'quiet-undo', cx)
  assert.equal(c.outbox.queue.length, 0)
  assert.equal(app.store['hrd.sheet'].key, 'D7', 'back on the undone item')
  assert.equal(shows(sheetBlock([b], s, cx), 'sheet').live, true)
})

for (const [how, fail] of [
  ['a send that throws', async all => ((all.t.fail = true), await all.flush())],
  [
    'a board reporting ok:false',
    async (all, b) => {
      await all.flush()
      b.actions = [{ id: all.t.sends[0].id, ok: false, message: 'nope' }]
      assert.equal(all.s.onBoards([b]), true, 'the other copy can settle it')
      assert.equal(all.c.onBoards([b]), false, 'and it is settled once')
    },
  ],
]) {
  test(`${how}: pending clears at once, next no longer skips the item, and it shows as failed with retry`, async () => {
    const b = only('D7', 'D8')
    const all = copies()
    const { cx, c, s, t, steady } = all
    openCard(b, { key: 'D7' })
    press(card([b], c, cx), 'card-opt-0', cx)
    await fail(all, b)
    assert.equal(t.notes.length, 1, 'one notice')
    for (const ctl of [c, s]) {
      assert.equal(ctl.outbox.hidden().has(`${b.session}:D7`), false)
      assert.equal(ctl.outbox.sent.length, 0)
    }
    // Answering the only other item goes to D7; it does not close the surface.
    steady()
    press(card([b], c, cx), 'card-opt-0', cx)
    assert.equal(app.store['hrd.open'].key, 'D7', 'next went to the failed item')
    // On the item itself: the live options, the failure, and retry.
    steady()
    let seen = shows(card([b], c, cx), 'card')
    assert.equal(seen.live, true)
    assert.match(seen.text, /D7: not sent · answer · Cursor/)
    press(card([b], c, cx), 'quiet-retry', cx)
    assert.ok(
      c.outbox.queue.some(q => q.key === 'D7' && q.action.answer === 'Cursor'),
      'retry sends the same choice again',
    )
    assert.equal(c.outbox.failed.length, 0, 'the failure is gone')
    assert.equal(c.schedule(cx, b.session, answerAction('D7', 'Offset')), null, 'one answer only')
    // The sheet sees the same.
    openSheet(b, 'D7')
    seen = shows(sheetBlock([b], s, cx), 'sheet')
    assert.equal(seen.undo, true)
    assert.equal(seen.live, false)
  })
}

test('on the sheet too: a failed item shows retry, and another item goes back to it', async () => {
  const b = only('D7', 'D8')
  const { cx, c, s, t, steady, flush } = copies()
  s.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  t.fail = true
  await flush(s)
  openSheet(b, 'D8')
  steady()
  press(sheetBlock([b], s, cx), 'quiet-retry', cx)
  assert.equal(app.store['hrd.sheet'].key, 'D7', 'from another item retry goes to it')
  steady()
  press(sheetBlock([b], s, cx), 'quiet-retry', cx)
  assert.equal(s.outbox.queue.at(-1).action.answer, 'Cursor', 'on the item it sends it again')
  assert.equal(c.outbox.failed.length, 0)
})

test('a failure on an item closed since is not offered for retry', () => {
  const b = only('D8')
  const failed = [{ session: b.session, key: 'D7', action: answerAction('D7', 'Cursor'), at: 1000 }]
  assert.deepEqual(quietLines(b, 'D8', { failed, now: 1001 }), [])
})

test('a copy that starts again loses its unsent answer: the item is open, not skipped, and nothing stale is left', async () => {
  const b = only('D7', 'D8', 'T12')
  const { cx, c, s, t, make, flush } = copies()
  c.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  s.schedule(cx, b.session, answerAction('D8', 'Dark'))
  // A hot reload or layout switch: this card copy's timer is gone, a new copy starts.
  const fresh = make(makeCardState)
  assert.deepEqual(
    fresh.outbox.queue.map(q => q.key),
    ['D8'],
    "the card's unsent answer is lost; the sheet's stays, its timer is alive",
  )
  assert.equal(fresh.outbox.hidden().has(`${b.session}:D7`), false, 'not skipped')
  assert.equal(nextItem(b, 'T12', fresh.outbox.hidden())?.key, 'D7', 'next item finds it')
  openCard(b, { key: 'D7' })
  const seen = shows(card([b], fresh, cx), 'card')
  assert.equal(seen.live, true, 'its options are back')
  assert.equal(seen.undo, false)
  assert.ok(fresh.schedule(cx, b.session, answerAction('D7', 'Offset')), 'it can be answered')
  // The sheet starts again as well, once what the card queued has gone out: what was sent is still known.
  await flush(s)
  assert.deepEqual(t.sends.map(x => x.action.key).sort(), ['D7', 'D8'])
  const again = make(makeSheetState)
  assert.equal(again.outbox.sent.length, 2)
  assert.equal(again.schedule(cx, b.session, answerAction('D7', 'Cursor')), null, 'sent is still one answer after a reload')
  // Nothing is left that would hold the item once the board answers.
  assert.equal(again.onBoards([only('T12')]), true)
  assert.equal(again.outbox.sent.length, 0)
})

test('the sheet the same: its start drops only what it queued, and its item is open again', () => {
  const b = only('D7', 'D8')
  const { cx, c, s, make } = copies()
  c.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  s.schedule(cx, b.session, answerAction('D8', 'Dark'))
  const fresh = make(makeSheetState)
  assert.deepEqual(
    fresh.outbox.queue.map(q => q.key),
    ['D7'],
  )
  openSheet(b, 'D8')
  assert.equal(shows(sheetBlock([b], fresh, cx), 'sheet').live, true)
})

test('the old copy of a reload cannot send what the new one dropped', async () => {
  const b = board()
  const { cx, c, t, make, flush } = copies()
  c.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  make(makeCardState)
  await flush(c)
  assert.equal(t.sends.length, 0)
})

test('sends are claimed in one write: two copies flushing send once', async () => {
  const b = board()
  const { cx, c, s, t, flush } = copies()
  c.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  await flush(c)
  s.outbox.flush(cx)
  await Promise.all(t.jobs)
  assert.equal(t.sends.length, 1)
})

test('without a store an Outbox keeps its lists to itself, as the pin bar does today', () => {
  const b = board()
  const { cx, c } = copies()
  const bar = new Outbox({ send: async () => {}, notify() {} })
  bar.schedule(cx, b.session, doneAction('T12'))
  assert.equal(c.outbox.queue.length, 0)
  assert.equal(bar.queue.length, 1)
})

test('for the pin bar (#217): Done in the bar plus Done in the card is one action, and Undo from either clears it', () => {
  const b = board()
  const { cx, c, make } = copies()
  const bar = new Outbox({
    send: async () => {},
    notify() {},
    store: sharedOutbox(
      k => app.store[k],
      (k, v) => (app.store[k] = v),
    ),
    surface: 'bar',
  })
  const id = bar.schedule(cx, b.session, doneAction('T12'))
  assert.equal(c.schedule(cx, b.session, doneAction('T12')), null, 'the card cannot Done it again')
  assert.equal(cardFor([b], { session: b.session, key: 'T12' }, { queue: c.outbox.queue }).undoId, id, 'and shows the undo')
  c.undo(id)
  assert.equal(bar.waiting(b.session).length, 0)
  // A card that starts again leaves the bar's alone, and the bar's own start drops it.
  bar.schedule(cx, b.session, doneAction('T13'))
  make(makeCardState)
  assert.equal(bar.queue.length, 1)
  bar.release()
  assert.equal(bar.queue.length, 0)
})

test('an action sent longer ago than SENT_HIDE_MS no longer hides its item, so nothing is stuck', async () => {
  const b = board()
  const { cx, c, t, flush } = copies()
  c.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  await flush()
  t.now += SENT_HIDE_MS
  assert.equal(c.outbox.hidden().size, 0)
  assert.ok(c.schedule(cx, b.session, answerAction('D7', 'Cursor')))
})

test('failures past FAIL_LINE_MS leave shared with the next write', async () => {
  const b = board()
  const { cx, c, t, flush } = copies()
  c.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  t.fail = true
  await flush()
  assert.equal(c.outbox.failed.length, 1)
  t.now += FAIL_LINE_MS
  c.schedule(cx, b.session, answerAction('D8', 'Dark'))
  assert.equal(c.outbox.failed.length, 0)
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
  const s = new CardState({ send: async () => {}, notify() {}, handle: null })
  const cx = { timer: { after() {} }, spawn() {}, notify() {} }
  s.step(cx, b.session, answerAction('D7', 'Cursor'), { now: 1000, next: () => ({ key: 'D8' }), go() {}, close() {} })
  s.movedAt = undefined
  const line = quietLines(b, 'D8', { queue: s.outbox.queue, now: 1000 })[0]
  s.undoTo(line, () => {}, 5000)
  assert.equal(s.movedAt, 5000)
  assert.equal(
    s.step(cx, b.session, answerAction('D7', 'Offset'), { now: 5000 + ROWS_SETTLE_MS - 1, next: () => null, go() {}, close() {} }),
    'ignored',
  )
})

test('after the last item closes, the keyboard goes back only if nothing took it and the owner is still there', () => {
  const closed = { back: 't1', space: 's1' }
  const at = { holding: true, focusedTerminal: 't1', space: 's1', open: false }
  assert.equal(holdRefocus(closed, at), true)
  assert.equal(holdRefocus(closed, { ...at, holding: false }), false, 'a dialog, an overlay or a block took the keyboard')
  assert.equal(holdRefocus(closed, { ...at, focusedTerminal: null }), false, 'a mod pane: not the state after a close')
  assert.equal(holdRefocus(closed, { ...at, focusedTerminal: 't2' }), false, 'clicked another terminal: leave it there')
  assert.equal(holdRefocus(closed, { ...at, space: 's2' }), false, 'moved to another space')
  assert.equal(holdRefocus(closed, { ...at, open: true }), false, 'another surface opened meanwhile')
  assert.equal(holdRefocus({ space: 's1' }, at), false, 'nothing to give back')
})

test('surfaceOpen knows every surface that wants the keyboard', () => {
  for (const key of ['hrd.open', 'hrd.sheet', 'hrd.popup', 'hrd.pins'])
    assert.equal(
      surfaceOpen(k => (k === key ? 'x' : null)),
      true,
      key,
    )
  assert.equal(
    surfaceOpen(() => null),
    false,
  )
})

/** One hold from start to end: `during` runs while it waits. Returns where the keyboard was sent. */
async function hold(surface, during = () => {}) {
  const b = board()
  const { cx, c, s, t } = copies()
  const ctl = surface === 'card' ? c : s
  ctl.h.focus()
  if (surface === 'card') app.store['hrd.open'] = { session: b.session, key: 'D7', back: 't1', space: 's1' }
  else app.store['hrd.sheet'] = { session: b.session, key: 'D7', back: 't1', space: 's1' }
  cx.sleep = async ms => {
    assert.equal(ms, ROWS_SETTLE_MS)
    during({ ctl, cx, b })
  }
  ;(surface === 'card' ? closeCardHeld : closeSheetHeld)(cx, ctl)
  await Promise.all(t.jobs)
  return { sent: app.ran.filter(([name]) => name === 'pane.focus').map(([, args]) => args.terminal), ctl, cx, b }
}

for (const surface of ['card', 'sheet']) {
  const draw = (ctl, cx, b) => (surface === 'card' ? card([b], ctl, cx) : sheetBlock([b], ctl, cx))

  test(`${surface}: the keyboard goes back after the hold when nothing took it, and the handle stays on an empty element until then`, async () => {
    let during
    const { sent, ctl, cx, b } = await hold(surface, ({ ctl, cx, b }) => {
      assert.deepEqual(app.ran, [], 'not before the hold ends')
      during = draw(ctl, cx, b)
    })
    assert.deepEqual(sent, ['t1'])
    assert.equal(during.node.calls.track_focus[0], ctl.h, 'the handle has an element while it waits')
    assert.equal(during.node.kids.length, 0, 'which draws nothing')
    assert.equal(draw(ctl, cx, b).node.calls.track_focus, undefined, 'and after the hold the block has no element for it')
  })

  for (const [what, take] of [
    ['a board pop-up', () => (app.store['hrd.popup'] = 'o1')],
    ['a pins overlay', () => (app.store['hrd.pins'] = 'o1')],
    ['the card', () => (app.store['hrd.open'] = { session: 's', key: 'D8' })],
    ['the sheet', () => (app.store['hrd.sheet'] = { session: 's', key: 'D8' })],
    ['another space', () => (app.focused = { terminal: 't9', space: 's2' })],
    ['another terminal', () => (app.focused = { terminal: 't2', space: 's1' })],
    ['a mod pane', () => (app.focused = { terminal: null, space: 's1' })],
    ['a click on anything with a focus handle', ({ ctl }) => (ctl.h.on = false)],
  ]) {
    test(`${surface}: the hold leaves the keyboard on ${what}`, async () => {
      assert.deepEqual((await hold(surface, take)).sent, [])
    })
  }

  test(`${surface}: no terminal to give back, no hold`, () => {
    const { cx, c, s } = copies()
    const ctl = surface === 'card' ? c : s
    app.store[surface === 'card' ? 'hrd.open' : 'hrd.sheet'] = { session: 's', key: 'D7', back: null }
    ;(surface === 'card' ? closeCardHeld : closeSheetHeld)(cx, ctl)
    assert.equal(ctl.hold, null)
  })
}

test('a second close during a hold takes over: only its hold gives the keyboard back', async () => {
  const { cx, c, t } = copies()
  c.h.focus()
  const wake = []
  cx.sleep = () => new Promise(r => wake.push(r))
  app.store['hrd.open'] = { session: 's', key: 'D7', back: 't1', space: 's1' }
  closeCardHeld(cx, c)
  const first = c.hold
  app.store['hrd.open'] = { session: 's', key: 'D8', back: 't1', space: 's1' }
  closeCardHeld(cx, c)
  assert.notEqual(c.hold, first)
  wake[0]()
  await t.jobs[t.jobs.length - 2]
  assert.deepEqual(app.ran, [], 'the first hold has no say')
  assert.ok(c.hold, 'and still holds')
  wake[1]()
  await Promise.all(t.jobs)
  assert.deepEqual(
    app.ran.map(([, a]) => a.terminal),
    ['t1'],
  )
  assert.equal(c.hold, null)
})

test('both views read the same lists: a sent answer is the resolved face on either', async () => {
  const b = board()
  const { cx, c, s, flush } = copies()
  c.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  await flush()
  const now = c.outbox.now()
  assert.equal(cardFor([b], { session: b.session, key: 'D7' }, { sent: s.outbox.sent, now }).face, 'resolved')
  assert.equal(sheetView(b, 'D7', { sent: c.outbox.sent, now }).face, 'resolved')
})

test('a reload moves the copy\'s waiting answer to "not sent" with retry and a notice; it is never sent by itself', async () => {
  const b = only('D7', 'D8')
  const { cx, c, t, make, flush } = copies()
  c.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  const fresh = make(makeCardState)
  assert.equal(fresh.outbox.queue.length, 0)
  assert.deepEqual(
    fresh.outbox.failed.map(f => f.key),
    ['D7'],
  )
  assert.equal(app.notes.length, 1)
  assert.equal(fresh.outbox.hidden().has(`${b.session}:D7`), false)
  const line = quietLines(b, 'D8', { failed: fresh.outbox.failed, now: t.now })[0]
  assert.equal(line.kind, 'failed')
  assert.equal(line.action.key, 'D7')
  await flush(c)
  assert.equal(t.sends.length, 0)
})

test('an overdue answer (its timer died) is moved to "not sent", not left hiding its item', () => {
  const b = only('D7', 'D8')
  const { cx, c, t } = copies()
  c.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  t.now += UNDO_MS + 60 * 60 * 1000
  assert.equal(c.outbox.hidden().size, 1, 'until something looks at it')
  c.onBoards([b])
  assert.equal(c.outbox.queue.length, 0)
  assert.deepEqual(
    c.outbox.failed.map(f => f.key),
    ['D7'],
  )
  assert.equal(c.outbox.hidden().size, 0)
  assert.equal(t.notes.length, 1)
})

test('entries a reload left unsent in the middle of a flush are "not sent"; one that started sending stays', () => {
  const b = only('D7', 'D8')
  const { cx, c, t, make } = copies()
  c.schedule(cx, b.session, answerAction('D7', 'Cursor'))
  c.schedule(cx, b.session, answerAction('D8', 'Dark'))
  t.now += UNDO_MS + 50
  cx.spawn = () => {} // the flush task dies with the reload before it starts sending
  c.outbox.flush(cx)
  assert.equal(c.outbox.sent.length, 2)
  c.outbox.update({ sent: c.outbox.sent.map((s, i) => (i === 0 ? { ...s, waiting: false } : s)) })
  const fresh = make(makeCardState)
  assert.deepEqual(
    fresh.outbox.sent.map(s => s.key),
    ['D7'],
  )
  assert.deepEqual(
    fresh.outbox.failed.map(f => f.key),
    ['D8'],
  )
})
