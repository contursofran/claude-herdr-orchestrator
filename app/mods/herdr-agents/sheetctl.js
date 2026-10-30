// Opens, pages and closes the floating sheet. Like the card it is a block that draws nothing while "hrd.sheet" is
// empty, so none of this touches the layout or the terminal's size.
import { focused, run, setShared, shared } from 'herdr'
import { canRefocus, openState } from './model.js'

/** Open the sheet on `key` of `board`; remembers the terminal to hand back, or the one `from` (a surface this press just
 *  closed) would have. */
export function openSheet(board, key, from = null) {
  const cur = shared('hrd.sheet') ?? from
  // One write, so every mod redraws once: the time tells this open from the last one, without the shared counter.
  setShared('hrd.sheet', openState(cur, board.session, key, focused()?.terminal, Date.now(), focused()?.space))
}

/** Move the open sheet to another item of the same board. The seq stays, so it does not take the keyboard again. */
export function pageSheet(key) {
  const cur = shared('hrd.sheet')
  if (cur) setShared('hrd.sheet', { ...cur, key })
}

/** Close the sheet and give the keyboard back to the terminal that had it (unless `refocus` is false, or the owner has
 *  moved to another space since: focusing it would jump back). */
export function closeSheet(refocus = true) {
  const cur = shared('hrd.sheet')
  setShared('hrd.sheet', null)
  if (refocus && canRefocus(cur, focused()?.space)) run('pane.focus', { terminal: cur.back })
}
