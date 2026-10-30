// Opens and closes the floating card. It is a block that draws nothing while "hrd.open" is empty, so neither call
// touches the layout or the terminal's size.
import { focused, run, setShared, shared } from 'herdr'
import { surfaceFor } from './heldmodel.js'
import { ROWS_SETTLE_MS, canRefocus, holdRefocus, openState } from './model.js'

/** Open the card for `item` ({key}) of `board`; remembers the terminal to hand back, or the one `from` (a surface this press
 *  just closed) would have. */
export function openCard(board, item, from = null) {
  // An answer for it waits in the sheet's Outbox: open the sheet, where undo is.
  if (surfaceFor(shared('hrd.held'), 'card', board.session, item.key, Date.now()) === 'sheet') {
    const was = shared('hrd.sheet') ?? from
    return setShared('hrd.sheet', openState(was, board.session, item.key, focused()?.terminal, Date.now(), focused()?.space))
  }
  const cur = shared('hrd.open') ?? from
  const seq = (shared('hrd.seq') ?? 0) + 1
  setShared('hrd.seq', seq)
  setShared('hrd.open', openState(cur, board.session, item.key, focused()?.terminal, seq, focused()?.space))
  setShared('hrd.pick', { session: board.session, key: item.key })
}

/** Close the card and give the keyboard back to the terminal that had it (unless `refocus` is false, or the owner has
 *  moved to another space since: focusing it would jump back). */
export function closeCard(refocus = true) {
  const cur = shared('hrd.open')
  setShared('hrd.open', null)
  setShared('hrd.pick', null)
  if (refocus && canRefocus(cur, focused()?.space)) run('pane.focus', { terminal: cur.back })
}

/** Close the card for good (the last item was answered) and give the keyboard back only after ROWS_SETTLE_MS, so a repeated
 *  key cannot reach the terminal. `cx` is the caller's own. */
export function closeCardHeld(cx) {
  const cur = shared('hrd.open')
  closeCard(false)
  holdKeyboard(cx, cur)
}

/** After the hold, focus `closed.back` if holdRefocus says the owner is still there. Shared by the card and the sheet. */
export function holdKeyboard(cx, closed) {
  if (!closed?.back) return
  cx.spawn(async cx => {
    await cx.sleep(ROWS_SETTLE_MS)
    const at = focused()
    if (
      holdRefocus(closed, {
        focusedTerminal: at?.terminal ?? null,
        space: at?.space ?? null,
        open: Boolean(shared('hrd.open') || shared('hrd.sheet')),
      })
    )
      run('pane.focus', { terminal: closed.back })
  })
}
