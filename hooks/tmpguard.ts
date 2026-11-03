import type { EngineInterface } from 'claude-code'

// The sandbox resets TMPDIR to /tmp/claude-<uid>, which every sandboxed Claude session of that user shares, so two
// workers can overwrite each other's temp files (#161, #157). A worker's Write and Edit therefore can't target it.

// The job folder's temp dir: set only in a worker whose spawn named its LIVE.json (<job>/LIVE.json); null anywhere else.
export async function jobTmp($: EngineInterface): Promise<string | null> {
  if ((await $.env.get('HERDR_AGENTS_ROLE')) !== 'worker') return null
  const live = await $.env.get('HERDR_AGENTS_LIVE')
  if (!live) return null
  const slash = live.lastIndexOf('/')
  return slash < 0 ? null : `${live.slice(0, slash)}/tmp`
}

// Resolves `.`, `..` and repeated slashes of an absolute path (hooks may not import node:path).
function normalize(file: string): string {
  const out: string[] = []
  for (const part of file.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return `/${out.join('/')}${file.endsWith('/') && out.length ? '/' : ''}`
}

const SHARED = ['/tmp/', '/private/tmp/', '/var/tmp/', '/private/var/tmp/']

// True for a path in a temp folder every session shares (after resolving `..`); false for the job tmp or anywhere else.
export function sharedTmp(file: string): boolean {
  if (!file.startsWith('/')) return false
  const norm = normalize(file)
  return SHARED.some(p => norm.startsWith(p))
}

// The refusal for a worker's Write/Edit into shared temp, or null when the path is fine or this is not a worker.
export async function tmpDenied($: EngineInterface, file: string | undefined): Promise<{ deny: string } | null> {
  if (!file || !sharedTmp(file)) return null
  const tmp = await jobTmp($)
  if (!tmp) return null
  return { deny: `${file} is in a shared temp folder another worker can overwrite (#157). Write it in ${tmp} instead.` }
}
