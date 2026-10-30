// Opens and closes the pin drop panel and the all-pins popover (role `pins`). One overlay at a time, with the board
// pop-up and the card: overlayPlan() says what to close. Ids are kept in shared so any copy of the mod can close them.
import { closeOverlay, openOverlay, setShared, shared } from 'herdr'
import { closeCard } from './cardctl.js'
import { PINS_ALL_W, allPinsHeight, overlayPlan, panelHeight, pins, pinsSpot } from './model.js'

function closeById(key) {
  const id = shared(key)
  if (!id) return
  setShared(key, null)
  try {
    closeOverlay(id) // it may have closed itself (Esc, a click outside): then the id is stale
  } catch {}
}

export const closePins = () => closeById('hrd.pins')
export const closePopupOverlay = () => closeById('hrd.popup')

/**
 * Open the drop panel (`view` 'panel', for pin `id`) or the all-pins popover ('all') under the pin bar. `bar` is the
 * bar's bounds when a click reported them. `read` is shared("hrd.read"). Only the owner's click calls this.
 */
export function openPins(board, view, { id = null, bar = null, read = {} } = {}) {
  if (!board) return
  const plan = overlayPlan('pins', {
    popup: Boolean(shared('hrd.popup')),
    card: Boolean(shared('hrd.open')),
    pins: Boolean(shared('hrd.pins')),
  })
  // The card took the keyboard: closing it gives it back to the terminal that had it.
  if (plan.closeCard) closeCard(plan.refocus)
  if (plan.closePopup) closePopupOverlay()
  if (plan.closePins) closePins()
  const list = pins(board, read)
  const viewport = typeof window !== 'undefined' ? window.viewport_size?.() : null
  const spot = pinsSpot(view, bar, viewport)
  const pin = list.find(p => p.id === id)
  if (view === 'panel' && !pin) return
  const height = view === 'panel' ? panelHeight(pin.text, spot.width) : allPinsHeight(list.length)
  const overlay = openOverlay({
    mod: 'herdr-agents',
    kind: 'popup',
    frame: 'none',
    width: view === 'panel' ? spot.width : PINS_ALL_W,
    height,
    at: { x: spot.x, y: spot.y },
    props: { role: 'pins', view, session: board.session, id, height, width: view === 'panel' ? spot.width : PINS_ALL_W, bar },
  })
  setShared('hrd.pins', overlay)
}
