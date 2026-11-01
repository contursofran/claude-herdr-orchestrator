import type { Pr } from '../types'

// GitHub's view of a PR: its checks rolled up to one word.

export type Check = { __typename?: string; status?: string; conclusion?: string; state?: string }
const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

export function ciOf(checks: Check[]): Pr['ci'] {
  if (checks.length === 0) return 'none'
  if (checks.some(c => FAILED.includes(c.conclusion ?? c.state ?? ''))) return 'fail'
  const pending = (c: Check) =>
    c.__typename === 'StatusContext' ? c.state === 'PENDING' || c.state === 'EXPECTED' : c.status !== 'COMPLETED'
  return checks.some(pending) ? 'pending' : 'pass'
}
