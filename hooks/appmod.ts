import type { EngineInterface } from 'claude-code'
import { APP_MOD_FILE, APP_MOD_FRESH_MS } from './defaults'

// The Herdr app mod's pin bar copy writes ~/.herdr-agents/app-mod.json = {at, terminals} every 30 s while it draws the
// boards. The band steps aside when that is fresh and lists this session's terminal; anything else (no file, an old one,
// one that does not parse, another machine's session, a plain hc terminal) leaves the band as it is.

// Whether the app mod's text says it draws this terminal's board now.
export function appModDraws(text: string, terminal: string, now: number): boolean {
  if (!terminal) return false
  try {
    const file = JSON.parse(text) as { at?: unknown; terminals?: unknown }
    if (typeof file.at !== 'number' || !Array.isArray(file.terminals)) return false
    return now - file.at < APP_MOD_FRESH_MS && now - file.at > -APP_MOD_FRESH_MS && file.terminals.includes(terminal)
  } catch {
    return false
  }
}

export async function appModShown($: EngineInterface): Promise<boolean> {
  const terminal = (await $.env.get('HC_TERMINAL_ID')) ?? ''
  const file = `${(await $.env.get('HOME')) ?? ''}/${APP_MOD_FILE}`
  try {
    if (!terminal || !(await $.fs.exists(file))) return false
    return appModDraws(await $.fs.read(file), terminal, await $.clock.now())
  } catch {
    return false
  }
}
