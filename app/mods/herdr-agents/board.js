// Reads the boards the plugin writes (~/.herdr-agents/board/<session>.json) and keeps them current.
import { exec, home, readTextFile, watchFolder } from 'herdr'
import { applyFile, boardId } from './model.js'

export const boardDir = () => `${home()}/.herdr-agents/board`

export class Boards {
  constructor() {
    this.files = {}
  }

  list() {
    return Object.values(this.files)
  }

  /** One full read, then only the files the watcher reports. No timers: the plugin writes on its own 3 s tick. */
  start(cx, onChange) {
    cx.spawn(async cx => {
      const dir = boardDir()
      await exec('mkdir', ['-p', dir])
      // Ask to be told before the first read, so a write between the two is not missed.
      let changed = watchFolder(dir)
      const listed = await exec('ls', ['-1', dir])
      for (const name of listed.stdout.split('\n')) {
        const id = boardId(dir, `${dir}/${name}`)
        if (id) await this.load(dir, id)
      }
      onChange(cx)
      for (;;) {
        const paths = await changed
        changed = watchFolder(dir)
        const ids = new Set(paths.map(p => boardId(dir, p)).filter(Boolean))
        for (const id of ids) await this.load(dir, id)
        if (ids.size) onChange(cx)
      }
    })
  }

  async load(dir, id) {
    let text = null
    try {
      text = await readTextFile(`${dir}/${id}.json`)
    } catch {
      return // unreadable right now: keep what we have
    }
    this.files = applyFile(this.files, id, text)
  }
}
