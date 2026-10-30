// Opens and closes the card panel. Only the owner's click or key may call these: they resize the terminal.
import { focused, run, setShared, shared } from 'herdr'
import { CARD_ID, openHeight, openState } from './model.js'

/** Show the card for `item` ({key}) of `board`. Resizes first, then shows; remembers the terminal to hand back. */
export function openCard(board, item, outbox, terminals) {
  const ctx = { queue: outbox?.queue, sent: outbox?.sent, terminals, now: Date.now() }
  run('layout.resize', { id: CARD_ID, px: openHeight(board, item.key, ctx) })
  // Remember it is open before showing it: a card copy that starts on the show must not take the panel for a stale one.
  const cur = shared('hrd.open')
  const seq = (shared('hrd.seq') ?? 0) + 1
  setShared('hrd.seq', seq)
  setShared('hrd.open', openState(cur, board.session, item.key, focused()?.terminal, seq))
  setShared('hrd.pick', { session: board.session, key: item.key })
  run('layout.show', { id: CARD_ID })
}

/** Hide the card and give the keyboard back to the terminal that had it (unless `refocus` is false). */
export function closeCard(refocus = true) {
  const cur = shared('hrd.open')
  run('layout.hide', { id: CARD_ID })
  setShared('hrd.open', null)
  setShared('hrd.pick', null)
  if (refocus && cur?.back) run('pane.focus', { terminal: cur.back })
}
