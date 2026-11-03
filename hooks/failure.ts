import type { CiFailure } from '../types'
import type { Check } from './ci'

// What failed in a PR's CI, for the board's `CI failed · 2 tests ↗`. The job, its run time and the run's address come with the
// PR's checks; the test names and counts come from the failed job's log, read once per failing head (pollPrs).

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
export const MAX_TESTS = 3

/** The first failed check as a failure: its job, how long it ran, where its run opens. No test data yet. */
export function failedJob(checks: Check[], head: string): CiFailure | null {
  const c = checks.find(x => FAILED.includes(x.conclusion ?? x.state ?? ''))
  if (!c) return null
  const start = Date.parse(c.startedAt ?? '')
  const end = Date.parse(c.completedAt ?? '')
  return {
    head,
    job: c.name ?? c.context ?? 'CI',
    url: c.detailsUrl ?? c.targetUrl ?? null,
    seconds: Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null,
    failed: null,
    passed: null,
    tests: [],
    more: 0,
  }
}

/** The run id in a check's address (`…/actions/runs/123/job/456`), or null for a check that is not an Actions run. */
export const runIdOf = (url: string | null) => url?.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null

/** Test names and counts from a failed job's log. Reads what bun and vitest print: `(fail) name` or `FAIL file > name` lines, and
 *  `2 fail` / `46 pass` or `Tests  2 failed | 46 passed` totals. Anything else gives no names and no counts. */
export function parseLog(log: string): Pick<CiFailure, 'failed' | 'passed' | 'tests' | 'more'> {
  // Each line of `gh run view --log` starts with `job<TAB>step<TAB>timestamp `; colour codes are noise.
  const lines = log.split('\n').map(l =>
    l
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/^[^\t]*\t[^\t]*\t\S+Z\s/, '')
      .trim(),
  )
  const names: string[] = []
  let failed: number | null = null
  let passed: number | null = null
  for (const l of lines) {
    const name = l.match(/^\(fail\)\s+(.+?)(\s+\[[\d.]+m?s\])?$/)?.[1] ?? l.match(/^(?:FAIL|×|✗)\s+(.+)$/)?.[1]
    if (name && !names.includes(name)) names.push(name)
    const bun = l.match(/^(\d+) (pass|fail)$/)
    if (bun) bun[2] === 'fail' ? (failed = Number(bun[1])) : (passed = Number(bun[1]))
    const vitest = l.match(/^Tests\s+(?:(\d+) failed)?[\s|]*(?:(\d+) passed)?/)
    if (vitest && (vitest[1] || vitest[2])) {
      failed = vitest[1] ? Number(vitest[1]) : failed
      passed = vitest[2] ? Number(vitest[2]) : passed
    }
  }
  const total = Math.max(failed ?? 0, names.length)
  return {
    failed: failed ?? (names.length || null),
    passed,
    tests: names.slice(0, MAX_TESTS).map(n => n.slice(0, 200)),
    more: names.length ? Math.max(0, total - MAX_TESTS) : 0,
  }
}
