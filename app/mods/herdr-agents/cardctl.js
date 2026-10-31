// Opens and closes the answer card. It is a popup of the strip's copy that draws only while "hrd.open" is set, so neither call
// touches the layout or the terminal's size.
import { focused, run, setShared, shared } from 'herdr'
import { ROWS_SETTLE_MS, canRefocus, holdRefocus, openState, surfaceOpen } from './model.js'

/** Open the card for `item` ({key}) of `board`; `at` is the place in the strip of the tab it lines up with (kept while the
 *  card moves to another item, so it stays where it opened); remembers the terminal to hand back, or the one `from` (a surface this press
 *  just closed) would have. */
export function openCard(board, item, from = null, at = null) {
  const cur = shared('hrd.open') ?? from
  const seq = (shared('hrd.seq') ?? 0) + 1
  setShared('hrd.seq', seq)
  setShared('hrd.open', openState(cur, board.session, item.key, focused()?.terminal, seq, focused()?.space, at))
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
 *  key cannot reach the terminal. `cx` is the caller's own, `ctl` the CardState. */
export function closeCardHeld(cx, ctl) {
  const cur = shared('hrd.open')
  closeCard(false)
  holdKeyboard(cx, cur, ctl)
}

/** Hold the keyboard on `ctl.h` (with `ctl.hold` set the block keeps it on an empty element, drawn as nothing), then focus
 *  `closed.back` if holdRefocus says nothing took it meanwhile. Shared by the card and the sheet. */
export function holdKeyboard(cx, closed, ctl) {
  if (!closed?.back) return
  const hold = (ctl.hold = {})
  cx.spawn(async cx => {
    await cx.sleep(ROWS_SETTLE_MS)
    if (ctl.hold !== hold) return // a later close holds it now
    ctl.hold = null
    const at = focused()
    const now = { holding: ctl.h.is_focused(), focusedTerminal: at?.terminal ?? null, space: at?.space ?? null, open: surfaceOpen(shared) }
    if (holdRefocus(closed, now)) run('pane.focus', { terminal: closed.back })
    cx.notify()
  })
}
