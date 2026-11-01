import type { EngineInterface } from 'claude-code'
import type { Row } from '../types'
import { repoLinks } from './board'

// Which repo a #123 belongs to. owner/repo#1, repo#1 and
// `repo #1` (a repo's name or short name, acme-client or client) name the repo; a bare #1
// takes the last repo named before it in the text, else `fallback` (a worker's repo), else
// the only repo known.
const REF = /(?:([\w.-]+(?:\/[\w.-]+)?)(\s*))?#(\d{1,6})\b/g

export async function linker($: EngineInterface, rows: Row[]) {
  const { byCwd, extra } = await repoLinks($)
  const slugs = [...new Set(Object.values(byCwd))]
  const known: Record<string, string> = {}
  for (const slug of slugs) {
    const name = slug.split('/')[1]!.toLowerCase()
    for (const k of new Set([name, name.split('-').pop()!])) known[k] = k in known && known[k] !== slug ? '' : slug
  }
  for (const [k, slug] of Object.entries(extra)) known[k.toLowerCase()] = String(slug)
  const repoNamed = (name: string | undefined, gap: string) =>
    name ? (name.includes('/') && !gap ? name : known[name.toLowerCase()]) || undefined : undefined
  const only = slugs.length === 1 ? slugs[0] : undefined
  // The repo a to-do or decision is about: its worker's, or one its `from` names.
  const repoOfWorker = new Map(rows.map(r => [r.name, r.repo]))
  const repoOf = (from: string) => repoOfWorker.get(from) ?? [...from.matchAll(REF)].map(m => repoNamed(m[1], m[2] ?? '')).find(Boolean)
  // The repo a text names (a brief's first line), else its folder's, else the only one known.
  const repoIn = (text: string, cwd: string) =>
    [...text.matchAll(REF)].map(m => repoNamed(m[1], m[2] ?? '')).find(Boolean) ?? byCwd[cwd] ?? only
  // Each #123 in a text as owner/repo#123, or #123 when no repo is known. A bare #1 takes the last repo named before it.
  const refsIn = (text: string, fallback?: string) => {
    let last = fallback ?? only
    return [...text.matchAll(REF)].map(m => {
      last = repoNamed(m[1], m[2] ?? '') ?? last
      return `${last ?? ''}#${m[3]}`
    })
  }
  return { repoOf, repoIn, refsIn }
}
