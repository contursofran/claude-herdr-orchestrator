// Plays a sound and posts a notification when a new pin or question arrives, for every board. The strip copy only, so it
// happens once per window. Keys stay in memory (a `shared` write would redraw every mod).
// No `herdr` import, so node can test it: strip.js hands in playSound and notify.
import { arrivalNotice, newArrivals } from './model.js'

export class Arrivals {
  constructor({ play, post }) {
    // board session -> keys last seen. Never dropped when a board's file goes away, so it comes back silent.
    this.keys = new Map()
    this.play = play
    this.post = post
  }

  /** Called with the boards after each change. The first sight of a board only records its keys. */
  observe(boards) {
    const arrivals = []
    for (const b of boards ?? []) {
      if (typeof b?.session !== 'string') continue
      const { keys, fresh } = newArrivals(this.keys.get(b.session) ?? null, b)
      this.keys.set(b.session, keys)
      arrivals.push({ terminal: b.coordinator?.terminal, fresh })
    }
    const n = arrivalNotice(arrivals)
    if (!n) return
    this.play('done')
    this.post({ title: n.title, body: n.body, ...(n.terminal ? { action: { name: 'pane.focus', args: { terminal: n.terminal } } } : {}) })
  }
}
