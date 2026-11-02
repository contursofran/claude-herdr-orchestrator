// Whether the owner closed the right panel. Live in `shared`, kept across restarts in localStorage.
import { setShared, shared } from 'herdr'

export const HELD_KEY = 'hrd.panelHidden'
let heldAtStart // what the last run left, read once per copy

/** Whether the owner closed the board, across restarts. */
export function panelHeld() {
  const now = shared(HELD_KEY)
  if (now !== undefined && now !== null) return now === true
  heldAtStart ??= globalThis.localStorage?.getItem(HELD_KEY) === '1'
  return heldAtStart
}

/** Remembers it: closing holds until `panel ▴` opens it again. */
export function holdPanel(held) {
  globalThis.localStorage?.setItem(HELD_KEY, held ? '1' : '0')
  setShared(HELD_KEY, held)
}
