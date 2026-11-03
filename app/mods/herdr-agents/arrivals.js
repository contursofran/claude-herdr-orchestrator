// Plays a sound and posts a notification when a new question or to-do arrives, for every board. The `arrivals` role's copy
// only (an invisible block every layout holds once), so it happens once per window. Keys stay in memory (a `shared` write
// would redraw every mod); the mark of the last announcement is saved in a file, so what arrived while the owner was in
// another layout (a layout switch restarts the mods) is announced when the next layout starts.
// No `herdr` import, so node can test it: arrivalsrole.js hands in playSound, notify and the mark's file.
import { arrivalNotice, newArrivals } from './model.js'

export class Arrivals {
  /** `play(name)`, `post(notice)`; `loadMark()` resolves the saved ms mark (rejects or gives a non-number when there is none)
   *  and `saveMark(ms)` writes it; `muted()` says the sound is off (the notice still posts). Without a mark file, boards are silent at first sight. */
  constructor({ play, post, loadMark, saveMark, muted }) {
    // board session -> keys last seen. Never dropped when a board's file goes away, so it comes back silent.
    this.keys = new Map()
    this.play = play
    this.post = post
    this.loadMark = loadMark
    this.saveMark = saveMark
    this.muted = muted
    this.since = null // the mark: first sight of a board announces its items newer than this
    this.ready = !loadMark // false until the mark is read; boards that come before it wait
    this.pending = null
  }

  /** Reads the mark. With none, first sights stay silent and the mark starts now. */
  async start() {
    if (this.ready) return
    let at = null
    try {
      at = await this.loadMark()
    } catch {}
    if (typeof at === 'number') this.since = at
    else this.mark(Date.now())
    this.ready = true
    const boards = this.pending
    this.pending = null
    if (boards) this.observe(boards)
  }

  mark(at) {
    this.since = at
    try {
      Promise.resolve(this.saveMark?.(at)).catch(() => {})
    } catch {}
  }

  /** Called with the boards after each change. The first sight of a board only records its keys, and announces what is newer than the mark. */
  observe(boards) {
    if (!this.ready) {
      this.pending = boards
      return
    }
    const arrivals = []
    for (const b of boards ?? []) {
      if (typeof b?.session !== 'string') continue
      const { keys, fresh } = newArrivals(this.keys.get(b.session) ?? null, b, this.since)
      this.keys.set(b.session, keys)
      arrivals.push({ terminal: b.coordinator?.terminal, fresh })
    }
    const n = arrivalNotice(arrivals)
    if (!n) return
    const newest = Math.max(...arrivals.flatMap(a => a.fresh.map(f => f.at)).filter(at => typeof at === 'number'), -Infinity)
    if (newest > (this.since ?? -Infinity)) this.mark(newest)
    if (!this.muted?.()) this.play('done')
    this.post({ title: n.title, body: n.body, ...(n.terminal ? { action: { name: 'pane.focus', args: { terminal: n.terminal } } } : {}) })
  }
}
