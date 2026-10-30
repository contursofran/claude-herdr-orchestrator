// What the card keeps between draws. No `herdr` import: everything outside comes in as an argument, so it can be tested.
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

  undo(id) {
    this.outbox.undo(id)
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

/** At app start: forget what the last run left in shared. Overlay ids restart with each run, so an old one could name another
 *  overlay; a Done request left behind was never undoable and is not sent now. */
export function clearStaleOverlays(get, set) {
  for (const key of ['hrd.pins', 'hrd.popup', 'hrd.doneReq']) if (get(key)) set(key, null)
}

/**
 * What the boards' change callback does for the parts that care. `parts` = {pinbar: bool, pin, card, strip}; each of
 * the last three may be null. Redraws last.
 */
export function onBoardsChanged(parts, boards, cx) {
  if (parts.pinbar) parts.pin.onBoards(boards)
  parts.card?.onBoards(boards)
  parts.strip?.observe(cx, boards)
  cx.notify()
}
