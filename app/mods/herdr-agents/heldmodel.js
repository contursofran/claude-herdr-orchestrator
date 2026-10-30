// Which surface holds an answer that waits or went out. The bar, card and sheet each keep an Outbox of their own, so this
// shared record ("hrd.held") tells the other copies. No `herdr` import: `get` and `set` come from outside, so it can be tested.
import { SENT_HIDE_MS, readKey } from './model.js'

export const HELD_KEY = 'hrd.held'

/** `held` ({[readKey]: {surface, at}}) with the item `key` of `session` held by `surface`; entries older than SENT_HIDE_MS go. */
export function noteHeld(held, surface, session, key, now) {
  const live = Object.fromEntries(Object.entries(held ?? {}).filter(([, h]) => now - h.at < SENT_HIDE_MS))
  return { ...live, [readKey(session, key)]: { surface, at: now } }
}

/** `held` without the item (undone). The same object when it was not there. */
export function dropHeld(held, session, key) {
  const id = readKey(session, key)
  if (!held?.[id]) return held ?? {}
  const { [id]: _gone, ...rest } = held
  return rest
}

/** The surface holding the item, or null (none, or older than SENT_HIDE_MS). */
export function heldBy(held, session, key, now) {
  const h = held?.[readKey(session, key)]
  return h && now - h.at < SENT_HIDE_MS ? h.surface : null
}

/** Read keys of every item held by any copy: to leave out of "next item", like Outbox.hidden(). */
export function heldKeys(held, now) {
  return new Set(
    Object.entries(held ?? {})
      .filter(([, h]) => now - h.at < SENT_HIDE_MS)
      .map(([id]) => id),
  )
}

/** The surface to open the item on: the one that holds its answer (it can undo it), else `want`. */
export const surfaceFor = (held, want, session, key, now) => heldBy(held, session, key, now) ?? want
