// Whether the parts that stand in for the plugin's band really draw. The heartbeat timer only says the mod is loaded, so a
// draw that throws is recorded here, one shared key per part (copies share no memory and two may fail at once). Only changes
// are written: setShared redraws every mod, and a part that keeps failing or keeps drawing must stay quiet.

const PARTS = ['pinbar', 'strip', 'card']
const keyOf = part => `hrd.drawFailed.${part}`

export const guardsDraw = part => PARTS.includes(part)

/** Whether any part's last draw threw (`get` is shared). */
export const anyDrawFailed = get => PARTS.some(part => Boolean(get(keyOf(part))))

/** Records a part's last draw: `error` when it threw, null when it drew. true if that changed anything. */
export function noteDraw(part, error, get, set) {
  const failed = error ? String(error?.message ?? error) || 'draw failed' : null
  if (Boolean(get(keyOf(part))) === Boolean(failed)) return false
  set(keyOf(part), failed)
  return true
}

/** Forgets every part's failure (`shared` outlives the run; a part that fails again says so at its next draw). */
export function clearDrawFailed(get, set) {
  for (const part of PARTS) noteDraw(part, null, get, set)
}
