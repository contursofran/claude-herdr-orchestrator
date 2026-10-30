// What the card keeps between draws. No `herdr` import: everything outside comes in as an argument, so it can be tested.
import { CARD_ID } from './model.js'
import { Outbox } from './outbox.js'

/**
 * The actions waiting out their undo time (the card's own Outbox, so the boards must settle it on every change, or an
 * `ok:false` would never show) and the handle that takes the keyboard when the owner opens it.
 *   send, notify  as for Outbox
 *   handle        the focus handle
 *   run           herdr's run()
 *   open          shared("hrd.open") as it was when this copy started
 * The card never resizes by itself: a failed answer comes back to the options in the panel it already has. Only the
 * owner's click or key (cardctl.js) opens, closes or resizes it. The one exception is the start of this copy: a panel
 * left shown with nothing open is hidden. "hrd.open" is saved in shared.json like any shared value, so after a restart
 * a card that was open is still open. Whether its panel is still shown is Herdr's to keep; either way the owner's next
 * click on an item shows it, and Esc or the esc button closes it.
 */
export class CardState {
  constructor({ send, notify, handle, run, open }) {
    this.outbox = new Outbox({ send, notify })
    this.h = handle
    this.token = null
    if (!open) run('layout.hide', { id: CARD_ID })
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
