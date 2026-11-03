// The `arrivals` role: an invisible floating block every layout holds once. It reads the boards and rings for each new
// question or to-do (sound and toast), so every layout chimes, not only the coordinator's. It draws nothing.
import { home, notify, playSound, readTextFile, settings, writeTextFile } from 'herdr'
import { Boards } from './board.js'
import { Arrivals } from './arrivals.js'

const markFile = () => `${home()}/.herdr-agents/arrivals-mark.json`

/** Herdr's own sound switch (settings.json `sounds.enabled`); the toast posts either way. */
const soundOff = () => settings()?.sounds?.enabled === false

export class ArrivalsRole {
  init(cx) {
    this.arrivals = new Arrivals({
      play: playSound,
      post: notify,
      muted: soundOff,
      loadMark: async () => JSON.parse(await readTextFile(markFile())).at,
      saveMark: at => writeTextFile(markFile(), JSON.stringify({ at }), null),
    })
    this.boards = new Boards()
    // Boards that come before the mark is read wait for it (observe keeps the latest).
    this.boards.start(cx, () => this.arrivals.observe(this.boards.list()))
    cx.spawn(async () => this.arrivals.start())
  }
}
