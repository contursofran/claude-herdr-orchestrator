// Opens and closes the floating card. It is a block that draws nothing while "hrd.open" is empty, so neither call
// touches the layout or the terminal's size.
import { focused, run, setShared, shared } from 'herdr'
import { openState } from './model.js'

/** Open the card for `item` ({key}) of `board`; remembers the terminal to hand back. */
export function openCard(board, item) {
  const cur = shared('hrd.open')
  const seq = (shared('hrd.seq') ?? 0) + 1
  setShared('hrd.seq', seq)
  setShared('hrd.open', openState(cur, board.session, item.key, focused()?.terminal, seq))
  setShared('hrd.pick', { session: board.session, key: item.key })
}

/** Close the card and give the keyboard back to the terminal that had it (unless `refocus` is false). */
export function closeCard(refocus = true) {
  const cur = shared('hrd.open')
  setShared('hrd.open', null)
  setShared('hrd.pick', null)
  if (refocus && cur?.back) run('pane.focus', { terminal: cur.back })
}
