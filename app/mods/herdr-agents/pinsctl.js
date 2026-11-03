// Closes the overlays that are kept by id in shared, so any copy of the mod can close them. Nothing opens a pins overlay now
// (the pin bar is gone), but one left open by an older run is still closed when the card or sheet opens.
import { closeOverlay, setShared, shared } from 'herdr'

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
