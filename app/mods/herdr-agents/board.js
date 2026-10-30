// Reads the boards the plugin writes (~/.herdr-agents/board/<session>.json) and keeps them current.
import { exec, hc, home, readTextFile, watchFolder, writeTextFile } from 'herdr'
import { BoardReader } from './boardreader.js'
import { actionFile, coreIdOf, heartbeat } from './model.js'

export const boardDir = () => `${home()}/.herdr-agents/board`
export const outgoingDir = () => `${home()}/.herdr-agents/outgoing`

/** The boards, read through the app's own calls. */
export class Boards extends BoardReader {
  constructor() {
    super({ dir: boardDir, exec, readTextFile, watchFolder })
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
