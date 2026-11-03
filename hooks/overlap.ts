import type { Pr } from '../types'

// Which open PRs on the board change the same files, for `touches pin-panel.ts like #215` on their rows. Only the PRs the board
// lists: pollPrs reads no others. A lockfile changes with any dependency and merges by regenerating it, so it says nothing.

const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock)$/

// `file` is the first path they share, `count` how many they share.
export type Share = { pr: number; file: string; count: number }

export function sharedFiles(tasks: { key: string; repo?: string; pr?: number }[], prs: Record<string, Pr>) {
  const open = tasks.flatMap(t => {
    const held = t.repo && t.pr ? prs[`${t.repo}#${t.pr}`] : undefined
    if (held?.state !== 'OPEN' || !t.pr) return []
    return [{ key: t.key, repo: t.repo, pr: t.pr, files: new Set((held.files ?? []).filter(f => !LOCKFILE.test(f))) }]
  })
  const shares = new Map<string, Share[]>()
  for (const a of open) {
    const mine: Share[] = []
    for (const b of open) {
      if (a.pr === b.pr || a.repo !== b.repo) continue
      const both = [...a.files].filter(f => b.files.has(f)).sort()
      if (both[0]) mine.push({ pr: b.pr, file: both[0], count: both.length })
    }
    if (mine.length)
      shares.set(
        a.key,
        mine.sort((x, y) => x.pr - y.pr),
      )
  }
  return shares
}
