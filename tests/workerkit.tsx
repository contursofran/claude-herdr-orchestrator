import { expect } from 'claude-code/testing'
import { BATCH_MS } from '../hooks/defaults'
import { settled, start } from './harness'

// What the worker test files share: a worker in /repo/wt, how to read its job back, and its report.

// The argv of a worker's watch: one `hc events` child, for its turn's end or its next turn's start.
export const EVENTS = (name: string) => ['hc', 'events', '--terminal', name, '--json']

export const watches = (calls: string[][], name: string) => calls.filter(c => c.join(' ') === EVENTS(name).join(' ')).length

export const reportedJob = {
  name: 'w-done',
  profile: 'builder',
  cwd: '/repo/wt',
  dir: '/repo/wt/.herdr-agents/w-done',
  startedAt: 900_000,
  endedAt: 950_000,
  status: 'reported',
  token: 'tok-done',
}

export const W = '/repo/wt/.herdr-agents/w-busy'

export const turnEnd = (turnId: string) => ({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' as const })

export const check = (argv: string[]) => argv[0] === '/bin/bash' && argv[2] === 'ci'

export const codex = { profiles: { x: { kind: 'codex', args: [] } } }

export const spawnBusy = async ($: Parameters<typeof start>[0], profile: string) => {
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile, cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
}

export const jobOf = (store: Map<string, unknown>, name: string) =>
  (store.get('jobs:session-1234') as { jobs: Record<string, Record<string, unknown>> }).jobs[name]!

export const spawnArgs = {
  tool: 'mcp__herdr-agents__spawn',
  worker: 'w-busy',
  profile: 'builder',
  cwd: '/repo/wt',
  task: 'Fix it.',
} as const

export const reportW = async ($: Parameters<typeof start>[0], s: Awaited<ReturnType<typeof start>>, text = 'Done.') => {
  await spawnBusy($, 'builder')
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\n${text}`
  await s.finish('w-busy')
  await s.clock.advance(BATCH_MS)
  expect(jobOf(s.store, 'w-busy')).toMatchObject({ status: 'reported' })
  return token
}
