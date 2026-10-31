import type { EngineInterface } from 'claude-code'
import type { Job, Profile } from '../types'
import { config } from './config'

// When a worker reports done, the mod posts how long it took on the worker's PR (or its issue): the mod
// knows when the job started and how long it sat parked on a WAIT.json, which a model's own sense of
// elapsed time does not. Off by default: `timeComments.repos` in herdr-agents.json names the repos.

// Where the clock ran, in whole minutes: working time and parked time apart, so a long CI wait is not work.
export function minutes(job: Job): { working: number; parked: number } {
  const from = job.timeFrom ?? job.startedAt
  const total = Math.max(0, (job.endedAt ?? from) - from)
  const parked = Math.min(total, job.parkedMs ?? 0)
  return { working: Math.round((total - parked) / 60_000), parked: Math.round(parked / 60_000) }
}

// What the work was: the profile says it, except a builder, which builds a feature in a worktree of its
// own (spawned with `branch`) or fixes in an existing one (spawned with `cwd`).
export function kindOf(job: Job): string | undefined {
  if (job.profile === 'reviewer') return 'review'
  if (job.profile === 'planner') return 'plan'
  if (job.profile === 'debugger') return 'debug'
  return job.kind
}

// The models of the subagents in agents/, for a profile that names one with --agent.
const AGENT_MODELS: Record<string, string> = { builder: 'Sonnet', planner: 'Opus', reviewer: 'Opus' }

// "Sonnet medium": the profile's own `label`, else its --model (or its agent's model) and --effort.
export function labelOf(name: string, p: Profile | undefined): string {
  if (p?.label) return p.label
  const arg = (flag: string) => (p && p.args.includes(flag) ? p.args[p.args.indexOf(flag) + 1] : undefined)
  const agent = arg('--agent')?.split(':').pop() ?? ''
  const model = arg('--model') ?? AGENT_MODELS[agent]
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  return [model ? cap(model) : name, arg('--effort')].filter(Boolean).join(' ')
}

const MACHINES: Record<string, string> = { Darwin: 'mac', Linux: 'linux' }

// The comment's text, one line.
export function commentText(job: Job, label: string, machine: string, owner?: string): string {
  const { working, parked } = minutes(job)
  const time = `${working} min working${parked > 0 ? `, ${parked} min parked` : ''}`
  return `[agent${owner ? ` for @${owner}` : ''} · ${label} · ${machine}] ${kindOf(job) ?? 'work'}: ${time} (${job.name}).`
}

// The owner/name of a folder's GitHub remote.
async function slugOf($: EngineInterface, cwd: string): Promise<string | undefined> {
  const ran = await $.process.run(['git', '-C', cwd, 'remote', '-v'], { timeoutMs: 10_000 })
  return ran.exitCode === 0 ? ran.stdout.match(/github\.com[:/]([^/\s]+\/[^\s]+?)(?:\.git)?\s/)?.[1] : undefined
}

// Posts the comment for a job that reported done, on `prs`' last or else the job's first issue. Returns what
// went wrong, or undefined (posted, or the repo has not opted in). Never throws: a failure is the caller's to log.
export async function postTime($: EngineInterface, job: Job, prs: number[], profile: Profile | undefined): Promise<string | undefined> {
  try {
    const setting = (await config($)).timeComments
    const repos = (Array.isArray(setting?.repos) ? setting.repos : []).filter((r): r is string => typeof r === 'string')
    if (repos.length === 0) return undefined
    const slug = await slugOf($, job.cwd)
    if (!slug || !repos.some(r => r.toLowerCase() === slug.toLowerCase())) return undefined
    const n = prs.at(-1) ?? job.prs?.at(-1) ?? job.refs?.[0]
    if (!n) return `no PR or issue to comment on for ${job.name}`
    const machine = MACHINES[(await $.process.run(['uname', '-s'], { timeoutMs: 5_000 })).stdout.trim()] ?? 'unknown'
    const owner = typeof setting?.for === 'string' ? setting.for.replace(/^@/, '') : undefined
    const body = commentText(job, labelOf(job.profile, profile), machine, owner)
    // `gh issue comment` also takes a PR's number.
    const ran = await $.process.run(['gh', 'issue', 'comment', String(n), '-R', slug, '--body', body], { timeoutMs: 30_000 })
    return ran.exitCode === 0 ? undefined : `gh issue comment ${n} failed: ${ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`}`
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
