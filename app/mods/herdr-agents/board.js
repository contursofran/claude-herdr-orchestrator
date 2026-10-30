// Reads the boards the plugin writes (~/.herdr-agents/board/<session>.json) and keeps them current.
import { exec, hc, home, readTextFile, watchFolder, writeTextFile } from 'herdr'
import { actionFile, applyFile, boardIdIn, coreIdOf, heartbeat, touchesBoard } from './model.js'

export const boardDir = () => `${home()}/.herdr-agents/board`
export const outgoingDir = () => `${home()}/.herdr-agents/outgoing`

export class Boards {
  constructor() {
    this.files = {}
    this.texts = {}
  }

  list() {
    return Object.values(this.files)
  }

  /** One full read, then only the files the watcher reports. No timers: the plugin writes when something changes. */
  start(cx, onChange) {
    cx.spawn(async cx => {
      const dir = boardDir()
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
    cx.spawn(async cx => {
      const dir = boardDir()
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
      text = await readTextFile(`${dir}/${id}.json`)
    } catch {
      return false // unreadable right now: keep what we have
    }
    if (text === this.texts[id]) return false
    this.texts[id] = text
    this.files = applyFile(this.files, id, text)
    return true
  }
}

/**
 * Writes one action file for a board: into outgoing/ first, then `mv` into <session>.actions/ so the plugin never reads a
 * half-written file. Returns the file name, which is the id the board reports the outcome under (`board.actions`).
 */
export async function send(session, action, id = actionFile(Date.now(), Math.random().toString(36).slice(2, 8))) {
  const out = outgoingDir()
  const dest = `${boardDir()}/${session}.actions`
  await exec('mkdir', ['-p', out, dest])
  await writeTextFile(`${out}/${id}`, JSON.stringify(action), null)
  const moved = await exec('mv', [`${out}/${id}`, `${dest}/${id}`])
  if (moved.code !== 0) {
    await exec('rm', ['-f', `${out}/${id}`]) // nothing is left behind in outgoing/
    throw new Error(moved.stderr.trim() || 'mv failed')
  }
  return id
}

const heartbeatFile = () => `${home()}/.herdr-agents/app-mod.json`

/** Tells the plugin the app is drawing the boards (its band then steps aside). Written beside the file and moved over it,
 *  so a reader never sees half a file. */
export async function beat(boards, terminals) {
  const file = heartbeatFile()
  await exec('mkdir', ['-p', `${home()}/.herdr-agents`])
  // The app's own core, as the plugin sees its own; unknown (an old hc, a failed call) is left out of the file.
  const core = await hc(['server', 'status', '--json']).then(
    r => (r.code === 0 ? coreIdOf(r.stdout) : ''),
    () => '',
  )
  await writeTextFile(`${file}.tmp`, heartbeat(boards, terminals, Date.now(), core), null)
  const moved = await exec('mv', [`${file}.tmp`, file])
  if (moved.code !== 0) await exec('rm', ['-f', `${file}.tmp`])
}

/** Takes the heartbeat away, so the band is back at once instead of within 90 s. */
export async function clearBeat() {
  await exec('rm', ['-f', heartbeatFile(), `${heartbeatFile()}.tmp`])
}
