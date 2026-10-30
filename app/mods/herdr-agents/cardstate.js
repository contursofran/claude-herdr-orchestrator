// What the card keeps between draws. No `herdr` import: everything outside comes in as an argument, so it can be tested.
import { CopyState } from './copystate.js'
import { dropHeld, heldKeys, noteHeld } from './heldmodel.js'
import { rowsSteady } from './model.js'
import { Outbox } from './outbox.js'

/**
 * The actions waiting out their undo time (the card's own Outbox, so the boards must settle it on every change, or an
 * `ok:false` would never show) and the handle that takes the keyboard when the owner opens it.
 *   send, notify  as for Outbox
 *   handle        the focus handle
 * The card floats over the terminal, so nothing here touches the layout. Only the owner's click or key (cardctl.js)
 * opens or closes it. "hrd.open" is saved in shared.json like any shared value, so clearStaleOpen forgets it at app start.
 */
export class CardState {
  constructor({ send, notify, handle }) {
    this.outbox = new Outbox({ send, notify })
    this.h = handle
    this.token = null
    this.copy = new CopyState()
    this.movedAt = undefined // when the card or sheet last moved to another item: presses aimed at the old one are ignored for ROWS_SETTLE_MS
  }

  /**
   * An answer or Done from the card or sheet: queue it, then move to the item `next(hidden)` finds ({key}, or null) with
   * go(item), or with none close with close(). A press right after a move is ignored, silently (it was aimed at the old
   * item). `held` = {get, set, surface} is the shared record of waiting actions (heldmodel.js): the action goes in, and items
   * waiting in any copy are skipped. Returns 'ignored', 'moved' or 'closed'.
   */
  step(cx, session, action, { now, next, go, close, held }) {
    if (!rowsSteady(this, now)) return 'ignored'
    if (!this.schedule(cx, session, action)) return 'ignored'
    if (held && action.key) held.set(noteHeld(held.get(), held.surface, session, action.key, now))
    const item = next(this.hiddenAll(held, now))
    if (!item) {
      close()
      return 'closed'
    }
    this.movedAt = now
    go(item)
    return 'moved'
  }

  /** Read keys to skip: waiting or sent here, or held by any copy (`held` as for step). */
  hiddenAll(held, now) {
    return new Set([...this.outbox.hidden(), ...(held ? heldKeys(held.get(), now) : [])])
  }

  /** Undo the action of the quiet line (`line` from quietLine) and go back to its item. `held` as for step. */
  undoTo(line, go, { held = null, session = null, now = Date.now() } = {}) {
    if (line.undoId) this.undo(line.undoId, held, session, line.key)
    this.movedAt = now // a move like any other: presses aimed at the old item are held off
    go({ key: line.key })
  }

  /** Called with the boards after each change; true when something was settled (redraw). */
  onBoards(boards) {
    return this.outbox.settle(boards)
  }

  /** Queue an action for `session`; null when one for the same item already waits. */
  schedule(cx, session, action) {
    const id = this.outbox.schedule(cx, session, action)
    if (id) cx.notify()
    return id
  }

  undo(id, held = null, session = null, key = null) {
    this.outbox.undo(id)
    if (held && session && key) held.set(dropHeld(held.get(), session, key))
  }
}

/**
 * True the first time `key` is asked about in this run of the app. A copy of the mod starts again on a layout switch and on
 * a hot reload, and shared.json outlives the run, so neither tells an app start from a copy start. globalThis does: seen
 * live, it survives both and is empty after a restart (window.sessionStorage is lost on a layout switch).
 */
export function firstThisRun(key) {
  const seen = (globalThis.__hrdStarted ??= {})
  if (seen[key]) return false
  seen[key] = true
  return true
}

/** At app start: forget a card left open by the last run (`get`/`set` are shared/setShared). Its board is likely gone and
 *  it would draw over the prompt and take the first key. true if there was one. */
export function clearStaleOpen(get, set) {
  if (!get('hrd.open')) return false
  set('hrd.open', null)
  set('hrd.pick', null)
  return true
}

/** The same for a sheet left open by the last run ("hrd.sheet"). true if there was one. */
export function clearStaleSheet(get, set) {
  if (!get('hrd.sheet')) return false
  set('hrd.sheet', null)
  return true
}

/** At app start: forget what the last run left in shared. Overlay ids restart with each run, so an old one could name another
 *  overlay; a Done request left behind was never undoable and is not sent now. */
export function clearStaleOverlays(get, set) {
  for (const key of ['hrd.pins', 'hrd.popup', 'hrd.doneReq', 'hrd.dismissed', 'hrd.held']) if (get(key)) set(key, null)
}

/**
 * What the boards' change callback does for the parts that care. `parts` = {pinbar: bool, pin, card, strip}; each of
 * the last three may be null. Redraws last, and only when a sent action settled or `drawn()` says the copy's picture changed.
 */
export function onBoardsChanged(parts, boards, cx, drawn = () => true) {
  const pinSettled = parts.pinbar ? parts.pin.onBoards(boards) : false
  const cardSettled = parts.card?.onBoards(boards)
  parts.strip?.observe(cx, boards)
  // `drawn` runs first: it remembers what was drawn, whatever else asks for the redraw.
  if (drawn() || pinSettled || cardSettled) cx.notify()
}
