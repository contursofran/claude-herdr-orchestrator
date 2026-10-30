// Keeps the boards current. No `herdr` import: everything outside comes in as an argument, so it can be tested.
import { applyFile, boardIdIn, touchesBoard } from './model.js'

export class BoardReader {
  /** `io`: {dir, exec, readTextFile, watchFolder}, the outside world. */
  constructor(io) {
    this.io = io
    this.files = {}
    this.texts = {}
  }

  list() {
    return Object.values(this.files)
  }

  /** One full read, then only the files the watcher reports. No timers: the plugin writes when something changes. */
  start(cx, onChange) {
    const { exec, watchFolder } = this.io
    cx.spawn(async cx => {
      const dir = this.io.dir()
      await exec('mkdir', ['-p', dir])
      // The watcher may report the resolved path (/tmp is /private/tmp on macOS): accept both.
      const real = (await exec('realpath', [dir]).catch(() => null))?.stdout.trim()
      const dirs = real && real !== dir ? [dir, real] : [dir]
      // Ask to be told before the first read, so a write between the two is not missed.
      let changed = watchFolder(dir)
      const listed = await exec('ls', ['-1', dir])
      for (const name of listed.stdout.split('\n')) {
        const id = boardIdIn(dirs, `${dir}/${name}`)
        if (id) await this.load(dir, id)
      }
      onChange(cx)
      for (;;) {
        const paths = await changed
        changed = watchFolder(dir)
        const ids = new Set(paths.map(p => boardIdIn(dirs, p)).filter(Boolean))
        let moved = false
        for (const id of ids) if (await this.load(dir, id)) moved = true
        if (moved) onChange(cx)
      }
    })
  }

  /** The pop-up's reader: it starts from the board the strip passed (`first`, already parsed) and keeps only that one file
   *  current. No mkdir, realpath or ls and no other board is read: the strip made the folder and chose the board. */
  startOne(cx, session, first, onChange) {
    if (first && typeof first === 'object') this.files = { [session]: first }
    const { watchFolder } = this.io
    cx.spawn(async cx => {
      const dir = this.io.dir()
      // Watch before the re-read, so a write between the two is not missed; the copy the strip passed may be seconds old.
      let changed = watchFolder(dir)
      await this.load(dir, session)
      onChange(cx)
      for (;;) {
        const paths = await changed
        changed = watchFolder(dir)
        if (!touchesBoard(session, paths)) continue
        if (await this.load(dir, session)) onChange(cx)
      }
    })
  }

  /** True when the file's text differs from the last read: the watcher also reports writes that change nothing. */
  async load(dir, id) {
    let text = null
    try {
      text = await this.io.readTextFile(`${dir}/${id}.json`)
    } catch {
      return false // unreadable right now: keep what we have
    }
    if (text === this.texts[id]) return false
    this.texts[id] = text
    this.files = applyFile(this.files, id, text)
    return true
  }
}
