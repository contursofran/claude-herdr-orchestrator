// What the card keeps between draws. No `herdr` import: everything outside comes in as an argument, so it can be tested.
import { Outbox } from './outbox.js'

/**
 * The actions waiting out their undo time (the card's own Outbox, so the boards must settle it on every change, or an
 * `ok:false` would never show) and the handle that takes the keyboard when the owner opens it.
 *   send, notify  as for Outbox
 *   handle        the focus handle
 * The card floats over the terminal, so nothing here touches the layout. Only the owner's click or key (cardctl.js)
 * opens or closes it. "hrd.open" is saved in shared.json like any shared value, so after a restart a card that was
 * open is still open; Esc or the esc button closes it.
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
 * What the boards' change callback does for the parts that care. `parts` = {pinbar: bool, pin, card, strip}; each of
 * the last three may be null. Redraws last.
 */
export function onBoardsChanged(parts, boards, cx) {
  if (parts.pinbar) parts.pin.onBoards(boards)
  parts.card?.onBoards(boards)
  parts.strip?.observe(cx, boards)
  cx.notify()
}
