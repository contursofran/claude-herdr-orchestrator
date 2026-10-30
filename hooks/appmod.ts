import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { APP_MOD_FILE, APP_MOD_FRESH_MS } from './defaults'
import { hc } from './hc'
import { session } from './session'

// The Herdr app mod's pin bar copy writes ~/.herdr-agents/app-mod.json = {at, terminals, core} every 30 s while it draws the
// boards. The band steps aside when that is fresh and lists this session's terminal; anything else (no file, an old one,
// one that does not parse, another machine's session, a plain hc terminal, another hc core) leaves the band as it is.
// `core` is the hc core's id (`hc server status`); a file or a session without one is matched on the terminal alone.
// While a part of the mod fails to draw, the file lists no terminals, so the band comes back.

// Whether the app mod's text says it draws this terminal's board now.
export function appModDraws(text: string, terminal: string, now: number, core = ''): boolean {
  if (!terminal) return false
  try {
    const file = JSON.parse(text) as { at?: unknown; terminals?: unknown; core?: unknown }
    if (typeof file.at !== 'number' || !Array.isArray(file.terminals)) return false
    if (core && typeof file.core === 'string' && file.core && file.core !== core) return false
    return now - file.at < APP_MOD_FRESH_MS && now - file.at > -APP_MOD_FRESH_MS && file.terminals.includes(terminal)
  } catch {
    return false
  }
}

// Whether the file says the app mod draws this terminal's board now (no atom).
async function fileShows($: EngineInterface): Promise<boolean> {
  const terminal = (await $.env.get('HC_TERMINAL_ID')) ?? ''
  const file = `${(await $.env.get('HOME')) ?? ''}/${APP_MOD_FILE}`
  try {
    if (!terminal || !(await $.fs.exists(file))) return false
    return appModDraws(await $.fs.read(file), terminal, await $.clock.now(), session.core)
  } catch {
    return false
  }
}

// What the last check saw. The band's render reads it, so changing it redraws the band.
const seen = atom({ plugin: 'herdr-agents', key: 'appmod' } as const, { shown: false })

export async function appModShown($: EngineInterface): Promise<boolean> {
  await read($, seen)
  return fileShows($)
}

// On the coordinator's timer: redraws the band when the answer changed (the file went stale, was deleted or came back),
// since a render is the only other time the file is read. Reads one file, makes no hc call.
export async function watchAppMod($: EngineInterface) {
  const shown = await fileShows($)
  if ((await read($, seen)).shown !== shown) await update($, seen, () => ({ shown }))
}

// The hc core this session talks to, once; left empty when hc cannot say (the file is then matched on the terminal).
export async function learnCore($: EngineInterface) {
  try {
    const status = await hc<{ core?: { id?: unknown } }>($, ['server', 'status'], 10_000)
    if (typeof status.core?.id === 'string') session.core = status.core.id
  } catch {}
}
