import type { EngineInterface } from 'claude-code'
import type { Pr } from '../types'

// GitHub's view of a PR: its checks rolled up to one word, and one `gh pr view` call for the rest.

export type Check = { __typename?: string; status?: string; conclusion?: string; state?: string }
const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

export function ciOf(checks: Check[]): Pr['ci'] {
  if (checks.length === 0) return 'none'
  if (checks.some(c => FAILED.includes(c.conclusion ?? c.state ?? ''))) return 'fail'
  const pending = (c: Check) =>
    c.__typename === 'StatusContext' ? c.state === 'PENDING' || c.state === 'EXPECTED' : c.status !== 'COMPLETED'
  return checks.some(pending) ? 'pending' : 'pass'
}

export type PrState = {
  state: Pr['state']
  head: string
  title: string
  ci: Pr['ci']
  checks: Check[]
  mergeState: string
  files: string[]
}

// The state of PR `n` in `repo`. Throws when gh fails.
export async function prState($: EngineInterface, repo: string, n: number | string): Promise<PrState> {
  const fields = 'state,headRefOid,title,statusCheckRollup,mergeStateStatus,files'
  const ran = await $.process.run(['gh', 'pr', 'view', String(n), '-R', repo, '--json', fields], { timeoutMs: 20_000 })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`)
  const pr = JSON.parse(ran.stdout) as {
    state: Pr['state']
    headRefOid?: string
    title?: string
    statusCheckRollup?: Check[]
    mergeStateStatus?: string
    files?: { path: string }[]
  }
  const checks = pr.statusCheckRollup ?? []
  return {
    state: pr.state,
    head: pr.headRefOid ?? '',
    title: pr.title ?? '',
    ci: ciOf(checks),
    checks,
    mergeState: pr.mergeStateStatus ?? '',
    files: (pr.files ?? []).map(f => f.path),
  }
}
