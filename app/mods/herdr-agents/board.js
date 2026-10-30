// Reads the boards the plugin writes (~/.herdr-agents/board/<session>.json) and keeps them current.
import { exec, home, readTextFile, watchFolder, writeTextFile } from 'herdr'
import { actionFile, applyFile, boardIdIn, heartbeat } from './model.js'

export const boardDir = () => `${home()}/.herdr-agents/board`
export const outgoingDir = () => `${home()}/.herdr-agents/outgoing`

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
  await writeTextFile(`${file}.tmp`, heartbeat(boards, terminals, Date.now()), null)
  const moved = await exec('mv', [`${file}.tmp`, file])
  if (moved.code !== 0) await exec('rm', ['-f', `${file}.tmp`])
}

/** Takes the heartbeat away, so the band is back at once instead of within 90 s. */
export async function clearBeat() {
  await exec('rm', ['-f', heartbeatFile(), `${heartbeatFile()}.tmp`])
}
