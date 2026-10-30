// Opens and closes the pin drop panel and the all-pins popover (role `pins`). One overlay at a time, with the board
// pop-up, the card and the sheet: overlayPlan() says what to close. Ids are kept in shared so any copy of the mod can close them.
import { closeOverlay, focused, openOverlay, setShared, settings, shared } from 'herdr'
import { closeCard } from './cardctl.js'
import { closeSheet } from './sheetctl.js'
import { PINS_ALL_W, allPinsHeight, fitHeight, overlayPlan, panelHeight, pinsSpot } from './model.js'

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
 * Open the drop panel (`view` 'panel', for pin `id`) or the all-pins popover ('all') under the pin bar. `list` is what it
 * shows (pins() of the board of `session`); `bar` is the bar's bounds when a click reported them; `back` is
 * the terminal to hand the keyboard to, when the overlay being replaced holds it. Only the owner's click calls this.
 */
export function openPins(session, list, view, { id = null, bar = null, back = null } = {}) {
  if (!session) return
  const plan = overlayPlan('pins', {
    popup: Boolean(shared('hrd.popup')),
    card: Boolean(shared('hrd.open')),
    pins: Boolean(shared('hrd.pins')),
    sheet: Boolean(shared('hrd.sheet')),
  })
  // The card or sheet took the keyboard: closing it gives it back to the terminal that had it.
  if (plan.closeCard) closeCard(plan.refocus)
  if (plan.closePopup) closePopupOverlay()
  if (plan.closePins) closePins()
  if (plan.closeSheet) closeSheet(plan.refocus)
  const viewport = typeof window !== 'undefined' ? window.viewport_size?.() : null
  const spot = pinsSpot(view, bar, viewport)
  const pin = list.find(p => p.id === id)
  if (view === 'panel' && !pin) return
  const height = fitHeight(
    view === 'panel' ? panelHeight(pin.text, spot.width) : allPinsHeight(list.length),
    spot.y,
    viewport,
    settings()?.zoom,
  )
  const overlay = openOverlay({
    mod: 'herdr-agents',
    kind: 'popup',
    frame: 'none',
    width: view === 'panel' ? spot.width : PINS_ALL_W,
    height,
    at: { x: spot.x, y: spot.y },
    // The pins go in the props: the overlay is a new copy of the mod and reads no board of its own (it would start late).
    props: {
      role: 'pins',
      view,
      session,
      id,
      list,
      height,
      width: view === 'panel' ? spot.width : PINS_ALL_W,
      bar,
      back: back ?? focused()?.terminal,
      space: focused()?.space,
    },
  })
  setShared('hrd.pins', overlay)
}
