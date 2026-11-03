import type { EngineInterface } from 'claude-code'
import type { BranchDiff } from '../types'

// What a worker's branch changes against the repo's default branch (#283), for the worker panel: the total and a row per file.
// Read from the committed branch at the PR poll's pace; the app mod only reads the board.

export const DIFF_FILES_MAX = 30

// `numstat` is `git diff --numstat` and `status` is `git diff --name-status`, both without renames, so a file is one row in each.
// A binary file counts no lines.
export function parseDiff(base: string, numstat: string, status: string): BranchDiff | null {
  const lines = new Map<string, { add: number; del: number }>()
  for (const l of numstat.split('\n')) {
    const [a = '', d = '', ...path] = l.split('\t')
    if (path.length) lines.set(path.join('\t'), { add: Number(a) || 0, del: Number(d) || 0 })
  }
  const files = status
    .split('\n')
    .flatMap(l => {
      const [s = '', ...path] = l.split('\t')
      const p = path.join('\t')
      return s && p ? [{ path: p, status: s.slice(0, 1), add: lines.get(p)?.add ?? 0, del: lines.get(p)?.del ?? 0 }] : []
    })
    .sort((x, y) => x.path.localeCompare(y.path))
  if (files.length === 0) return null
  return {
    base,
    add: files.reduce((n, f) => n + f.add, 0),
    del: files.reduce((n, f) => n + f.del, 0),
    files: files.slice(0, DIFF_FILES_MAX),
    more: Math.max(0, files.length - DIFF_FILES_MAX),
  }
}

// The branch in `cwd` against its default branch, or null when it changes nothing or git can't say (not a repo, no remote).
export async function readDiff($: EngineInterface, cwd: string): Promise<BranchDiff | null> {
  const run = async (args: string[]) => {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 20_000 })
    return r.exitCode === 0 ? r.stdout : undefined
  }
  const ref = (await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim() || 'origin/main'
  const range = `${ref}...HEAD`
  const numstat = await run(['diff', '--no-renames', '--numstat', range])
  const status = numstat === undefined ? undefined : await run(['diff', '--no-renames', '--name-status', range])
  if (numstat === undefined || status === undefined) return null
  return parseDiff(ref.replace(/^origin\//, ''), numstat, status)
}
