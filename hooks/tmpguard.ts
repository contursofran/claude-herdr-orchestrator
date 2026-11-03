import type { EngineInterface } from 'claude-code'

// The sandbox resets TMPDIR to /tmp/claude-<uid>, which every sandboxed Claude session of that user shares, so two
// workers can overwrite each other's temp files (#161, #157). A worker's Bash runs with TMPDIR in its job folder instead.

// The job folder's temp dir: set only in a worker whose spawn named its LIVE.json (<job>/LIVE.json); null anywhere else.
export async function jobTmp($: EngineInterface): Promise<string | null> {
  if ((await $.env.get('HERDR_AGENTS_ROLE')) !== 'worker') return null
  const live = await $.env.get('HERDR_AGENTS_LIVE')
  if (!live) return null
  const slash = live.lastIndexOf('/')
  return slash < 0 ? null : `${live.slice(0, slash)}/tmp`
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function pinTmp(command: string, tmp: string): string {
  const prefix = `export TMPDIR=${quote(tmp)}; `
  return command.startsWith(prefix) ? command : prefix + command
}
