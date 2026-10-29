import type { EngineInterface } from 'claude-code'
import type { Job, Pipe, PipeAction, PipeCi } from '../types'
import { pipelineSettings, smallTasks, target, wrappingUp } from './config'
import { PIPE_DIGEST_LINES } from './defaults'
import { post } from './outbox'
import { prState } from './ci'
import { step, type Enroll, type Fact } from './pipeline'
import { open, pipes, restorePipes, savePipe } from './pipestore'
import type { Header } from './report'
import { active, jobs } from './state'
import { serial, spawnWorker, stopJob } from './workers'

// The runner of the PR pipeline: it feeds facts to the pure reducer (pipeline.ts), keeps the
// pipes (pipestore.ts) and carries out the actions the reducer returns: it starts the review and
// fix workers when a slot is free, stops a writer, and posts the few prompts the coordinator gets.
//
// Everything that reads or changes a pipe runs in one serial step, `locked`, so a report, a tick and
// a tool call never act on the same pipe at once. A worker's own report is delivered in its own
// step (see deliver) and then waits its turn here; nothing here waits for a worker.

const locked = <T>(fn: () => Promise<T>): Promise<T | undefined> => {
  let out: T | undefined
  return serial('pipes', async () => {
    out = await fn()
  }).then(() => out)
}

const sha8 = (sha?: string) => (sha ?? '').slice(0, 8)

// The GitHub repo (owner/name) a folder belongs to, from its git remotes.
async function repoOf($: EngineInterface, cwd: string): Promise<string | undefined> {
  try {
    const ran = await $.process.run(['git', '-C', cwd, 'remote', '-v'])
    return ran.exitCode === 0 ? ran.stdout.match(/github\.com[:/]([^/\s]+\/[^\s]+?)(?:\.git)?\s/)?.[1] : undefined
  } catch {
    return undefined
  }
}

async function currentBranch($: EngineInterface, cwd: string) {
  try {
    const ran = await $.process.run(['git', '-C', cwd, 'branch', '--show-current'], { timeoutMs: 10_000 })
    return ran.exitCode === 0 ? ran.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

// The PR pipeline's settings with S4's one limit: the mod does not merge yet, so merge "auto" runs as "ready".
async function settings($: EngineInterface) {
  const cfg = await pipelineSettings($)
  return cfg && { ...cfg, merge: 'ready' as const }
}

// ---- what the coordinator gets ----

const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)

// The hops since each pipe's last prompt, oldest first, the latest PIPE_DIGEST_LINES of them.
function digest(all: Pipe[]) {
  const hops = all
    .flatMap(p => p.log.filter(l => l.at > (p.lastPostedAt ?? 0)).map(l => ({ at: l.at, line: `- ${hhmm(l.at)} #${p.pr} ${l.text}` })))
    .sort((a, b) => a.at - b.at)
  return hops.slice(-PIPE_DIGEST_LINES).map(h => h.line)
}

// One <herdr-pipeline> prompt for `p`, with the digest. `ci` replaces the CI word when CI is not what the pipe holds.
async function postPipe($: EngineInterface, p: Pipe, event: 'ready' | 'handed', ci?: string) {
  const now = await $.clock.now()
  const all = Object.values(await pipes($))
  const head = p.head ?? ''
  // the review report, the CI log and the last pipeline worker's report (or its screen)
  const last = Object.values(await jobs($))
    .filter(j => j.pipe?.key === p.key && j.reportFile)
    .sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))[0]
  const files = [...new Set([p.blockers, p.ciLog, last?.reportFile].filter(Boolean))].join(', ')
  const what =
    event === 'ready'
      ? `Approved at ${sha8(head)}; CI ${ci ?? p.ci}. Merge it: gh pr merge ${p.pr} -R ${p.repo} --squash --delete-branch --match-head-commit ${head}`
      : `Handed back to you: ${p.reason ?? 'the pipeline stopped'}.${files ? ` Files: ${files}.` : ''} \`pipeline resume\` puts it back in the pipeline.`
  const hops = digest(all)
  const text = [
    `<herdr-pipeline event="${event}" pr="${p.pr}" repo="${p.repo}" head="${sha8(head)}">`,
    what,
    ...(hops.length ? ['Pipeline since your last prompt:', ...hops] : []),
    '</herdr-pipeline>',
  ].join('\n')
  for (const q of all) await savePipe($, q.key, { ...(q.key === p.key ? p : q), lastPostedAt: now })
  await post($, text, true)
}

// ---- starting the waiting steps ----

// The plan path in the brief of the builder that opened the PR (the first brief of the worktree), if any.
async function planOf($: EngineInterface, p: Pipe) {
  for (const j of Object.values(await jobs($))) {
    if (j.cwd !== p.cwd || j.pipe) continue
    const file = `${j.dir}/TASK.md`
    if (!(await $.fs.exists(file))) continue
    const plan = (await $.fs.read(file)).match(/(\/[^\s`'"()<>]*PLAN\.md)/)?.[1]
    if (plan) return plan
  }
  return undefined
}

// The TASK.md the mod writes for a pipeline worker.
async function brief($: EngineInterface, p: Pipe, a: PipeAction & { kind: 'spawn' }) {
  const where = `PR #${p.pr} (${p.repo})${p.branch ? `, branch ${p.branch}` : ''}`
  if (a.role === 'review') {
    const again = p.reviewed && p.head && p.reviewed !== p.head
    return [
      `Review ${where}${p.head ? `, head ${p.head}` : ''}.${p.issue ? ` Part of #${p.issue}.` : ''}`,
      again
        ? ` Re-review: read only git diff ${p.reviewed}..HEAD${p.blockers ? ` and whether each blocker in ${p.blockers} is fixed` : ''}.`
        : '',
      ' Report header: add verdict: approve or verdict: changes (changes only for Blockers) and head: <the commit you reviewed>.',
    ].join('')
  }
  if (a.role === 'update')
    return `${where} conflicts with origin/${p.base ?? 'main'}. Merge origin/${p.base ?? 'main'} into ${p.branch ?? 'its branch'}, resolve, run the checks, push, and report.`
  const round = a.worker.match(/^f\d+-(\d+)$/)?.[1] ?? String(p.round)
  const plan = await planOf($, p)
  return [
    `Fix round ${round} for ${where}, in this worktree. First git pull --ff-only.`,
    p.blockers ? ` Review blockers: ${p.blockers} (fix the Blockers; Nits only if trivial).` : '',
    p.ciLog ? ` CI failed at ${sha8(p.head)}; the failing log is in ${p.ciLog}.` : '',
    plan ? ` The plan: ${plan}.` : '',
    ' Re-run the pre-check, push, and report.',
  ].join('')
}

// Starts each waiting step while workers are below the cap, oldest pipe first. A step whose worker
// already exists (a reload cut the step off after the spawn) is dropped, so it never starts twice.
async function drain($: EngineInterface, cfg: NonNullable<Awaited<ReturnType<typeof settings>>>) {
  const want = cfg.cap ?? (await target($))
  for (const p0 of Object.values(await pipes($))
    .filter(open)
    .sort((a, b) => a.since - b.since)) {
    for (const a of p0.waiting) {
      const p = (await pipes($))[p0.key]
      if (!p || !open(p) || !p.waiting.some(w => w.kind === 'spawn' && a.kind === 'spawn' && w.worker === a.worker)) break
      if (a.kind !== 'spawn') continue
      const running = Object.values(await jobs($)).filter(active).length
      if (running >= want) return
      const known = (await jobs($))[a.worker]
      if (!(known && known.pipe?.key === p.key)) {
        // The owner's wrap-up lets only a reviewer start; the step waits for it to end.
        if (a.role !== 'review' && (await wrappingUp($))) continue
        const out = await spawnWorker($, {
          worker: a.worker,
          profile: a.profile,
          task: await brief($, p, a),
          cwd: p.cwd,
          pipe: { key: p.key, role: a.role },
        })
        if ('deny' in out) {
          await applyNow($, cfg, p.key, { kind: 'failed', reason: `could not start ${a.worker}: ${out.deny}` })
          return
        }
      }
      const now = (await pipes($))[p.key]
      if (now) await savePipe($, p.key, { ...now, waiting: now.waiting.filter(w => !(w.kind === 'spawn' && w.worker === a.worker)) })
    }
  }
}

// ---- facts in, actions out ----

type Cfg = NonNullable<Awaited<ReturnType<typeof settings>>>

// One fact for one pipe, inside `locked`: the reducer, the store, then the actions and the waiting steps.
async function applyNow($: EngineInterface, cfg: Cfg, key: string, fact: Fact): Promise<{ before?: Pipe; after?: Pipe }> {
  const now = await $.clock.now()
  const before = (await pipes($))[key]
  if (fact.kind === 'release') {
    if (before) await savePipe($, key, undefined)
    return { before }
  }
  const { pipe, actions } = step(before, fact, cfg, now)
  if (pipe && pipe !== before) await savePipe($, key, pipe)
  const after = pipe ?? before
  if (after) {
    for (const a of actions) {
      if (a.kind === 'stop') {
        // the writer of the worktree: its tab must be gone before the next writer starts
        const j = (await jobs($))[a.worker]
        if (j && !j.closed) await stopJob($, { worker: a.worker }).catch(() => {})
      } else if (a.kind === 'post' && (a.event === 'ready' || a.event === 'handed'))
        await postPipe($, (await pipes($))[key] ?? after, a.event)
      // `merge` and the other events belong to later slices; merge mode is forced to "ready" (see settings)
    }
    await drain($, cfg)
  }
  return { before, after: (await pipes($))[key] ?? after }
}

// Approved and idle: read CI once. Green is a fact for the reducer (which makes it ready); anything
// else is told to the coordinator in the ready prompt, as the CI watch is a later slice.
async function checkCi($: EngineInterface, cfg: Cfg, key: string) {
  const p = (await pipes($))[key]
  if (!p || p.stage !== 'review' || !p.approved || p.worker || !p.head || p.reviewed !== p.head) return
  let ci: PipeCi
  let head = p.head
  let why = ''
  try {
    const s = await prState($, p.repo, p.pr)
    ci = s.ci
    head = s.head || p.head
  } catch (err) {
    ci = 'unknown'
    why = ` (gh failed: ${err instanceof Error ? err.message : String(err)})`
  }
  if (ci === 'pass' || head !== p.head) {
    await applyNow($, cfg, key, { kind: 'ci', head, ci: head !== p.head ? 'unknown' : ci })
    return
  }
  await postPipe($, p, 'ready', `${ci}${why}`)
}

// A worker's report (deliver). True when the pipeline took it, so deliver posts nothing; false leaves
// it to the coordinator as usual: the pipeline is off, the job is not the pipeline's, or the report
// asks something of the coordinator.
export async function takeReport(
  $: EngineInterface,
  job: Job,
  r: { status: string; header?: Header; asks: number; file?: string },
): Promise<boolean> {
  try {
    const cfg = await settings($)
    if (!cfg) return false
    const header = r.header
    if (job.pipe) {
      const key = job.pipe.key
      const p = (await pipes($))[key]
      if (!p || p.worker !== job.name || r.asks > 0) return false
      const role = job.pipe.role
      // A fix builder is not asked for the head it pushed: GitHub knows it.
      let head = header?.head
      if (!head && role !== 'review' && r.status === 'done')
        head = await prState($, p.repo, p.pr).then(
          s => s.head || undefined,
          () => undefined,
        )
      const fact: Fact = {
        kind: 'report',
        job: job.name,
        profile: job.profile,
        status: r.status,
        prs: header?.prs ?? [],
        verdict: header?.verdict,
        head,
        asks: r.asks,
        file: r.file,
      }
      await locked(async () => {
        await applyNow($, cfg, key, fact)
        if (role === 'review') await checkCi($, cfg, key)
      })
      return true
    }

    // A builder-type job's report with one PR enrolls it.
    const builders = new Set([cfg.profiles.build, cfg.profiles.rescue, await smallTasks($)])
    const prs = header?.prs ?? []
    const [pr] = prs
    if (!builders.has(job.profile) || r.status !== 'done' || prs.length !== 1 || pr === undefined || r.asks > 0) return false
    const repo = await repoOf($, job.cwd)
    if (!repo || (await pipes($))[`${repo}#${pr}`]) return false
    let head: string | undefined
    try {
      const s = await prState($, repo, pr)
      if (s.state !== 'OPEN') return false
      head = s.head || undefined
    } catch {
      // gh is down: the reviewer's report names the head
    }
    const enroll: Enroll = {
      repo,
      cwd: job.cwd,
      branch: job.branch,
      issue: job.refs?.find(n => n !== pr),
      head,
    }
    const fact: Fact = { kind: 'report', job: job.name, profile: job.profile, status: 'done', prs, asks: 0, file: r.file, enroll }
    const out = await locked(() => applyNow($, cfg, `${repo}#${pr}`, fact))
    return !!out?.after && !out.before
  } catch {
    return false
  }
}

// A pipeline worker the coordinator stopped by hand: the PR goes back to the coordinator.
export async function pipeStopped($: EngineInterface, worker: string) {
  try {
    const cfg = await settings($)
    const j = (await jobs($))[worker]
    if (!cfg || !j?.pipe) return
    const key = j.pipe.key
    await locked(async () => {
      if ((await pipes($))[key]?.worker === worker) await applyNow($, cfg, key, { kind: 'stopped' })
    })
  } catch {}
}

// The pipe that owns a worktree, while the pipeline is on and the pipe still moves.
export async function ownerOf($: EngineInterface, cwd: string): Promise<Pipe | undefined> {
  try {
    if (!(await pipelineSettings($))) return undefined
    return Object.values(await pipes($)).find(p => p.cwd === cwd && open(p))
  } catch {
    return undefined
  }
}

// Every sweep, and once at session.start: timeouts, and the steps a reload cut off or a full cap held back.
export async function tickPipes($: EngineInterface) {
  const cfg = await settings($)
  if (!cfg) return
  await locked(async () => {
    for (const p of Object.values(await pipes($)).filter(open)) await applyNow($, cfg, p.key, { kind: 'tick' })
    await drain($, cfg)
  })
}

// A worker's report freed a slot: start the steps that waited for one.
export async function drainPipes($: EngineInterface) {
  const cfg = await settings($)
  if (cfg) await locked(() => drain($, cfg))
}

export async function startPipes($: EngineInterface) {
  await restorePipes($)
  await tickPipes($)
}

// ---- the pipeline tool ----

export type PipelineArgs = { action?: string; pr?: number; repo?: string; cwd?: string }

// One line for a pipe, as the Workers block will list it.
export function pipeLine(p: Pipe) {
  if (p.stage === 'handed') return `- #${p.pr} · handed ${hhmm(p.log.at(-1)?.at ?? p.since)}: ${p.reason ?? ''}`
  if (p.stage === 'merged' || p.stage === 'closed') return `- #${p.pr} · ${p.stage}`
  const review = p.approved ? `approved @${p.reviewed?.slice(0, 7)}` : p.blockers ? `changes @${p.reviewed?.slice(0, 7)}` : 'pending'
  const step =
    p.stage === 'ready'
      ? 'ready'
      : p.stage === 'fix'
        ? `fix round ${p.round} (${p.worker ?? 'waiting'})`
        : p.worker
          ? `review by ${p.worker}`
          : 'waiting for CI'
  return `- #${p.pr}${p.branch ? ` on ${p.branch}` : ''} · head ${(p.head ?? '?').slice(0, 7)} · review ${review} · CI ${p.ci} · ${step}`
}

export async function pipelineTool($: EngineInterface, a: PipelineArgs): Promise<{ result: string } | { deny: string }> {
  const cfg = await settings($)
  if (!cfg) return { deny: 'the pipeline is off; set "pipeline": { "enabled": true } in herdr-agents.json' }
  const all = Object.values(await pipes($))
  if (a.action === 'status' || a.action === undefined) {
    const lines = all.map(pipeLine)
    return {
      result: [...(lines.length ? lines : ['No PR is in the pipeline.']), ...(cfg.warning ? [`Warning: ${cfg.warning}`] : [])].join('\n'),
    }
  }
  if (!['release', 'resume', 'add'].includes(a.action)) return { deny: `unknown action ${a.action}; use status, release, resume or add` }
  const n = Number(a.pr)
  if (!Number.isInteger(n) || n <= 0) return { deny: 'pr is required (a PR number)' }
  if (a.action === 'add') {
    if (!a.cwd) return { deny: "cwd is required for add: the PR's worktree" }
    const cwd = a.cwd
    const repo = a.repo ?? (await repoOf($, cwd))
    if (!repo) return { deny: `could not tell the GitHub repo of ${cwd}; pass repo (owner/name)` }
    if (all.some(p => p.key === `${repo}#${n}`)) return { deny: `PR #${n} is in the pipeline already; see status` }
    let head: string
    try {
      const s = await prState($, repo, n)
      if (s.state !== 'OPEN') return { deny: `PR #${n} is ${s.state}, not open` }
      head = s.head
    } catch (err) {
      return { deny: `gh could not read PR #${n}: ${err instanceof Error ? err.message : String(err)}` }
    }
    const enroll: Enroll = { repo, cwd, branch: await currentBranch($, cwd), head: head || undefined }
    const fact: Fact = { kind: 'report', job: 'coordinator', profile: cfg.profiles.build, status: 'done', prs: [n], asks: 0, enroll }
    const out = await locked(() => applyNow($, cfg, `${repo}#${n}`, fact))
    return out?.after ? { result: `PR #${n} is in the pipeline: ${pipeLine(out.after)}` } : { deny: `could not add PR #${n}` }
  }
  const found = all.filter(p => p.pr === n && (!a.repo || p.repo === a.repo))
  if (found.length === 0) return { deny: `PR #${n} is not in the pipeline` }
  if (found.length > 1) return { deny: `PR #${n} is in several repos (${found.map(p => p.repo).join(', ')}); pass repo` }
  const p = found[0]!
  if (a.action === 'release') {
    await locked(() => applyNow($, cfg, p.key, { kind: 'release' }))
    return { result: `Released PR #${n}: the pipeline no longer runs it, and its workers report to you as usual.` }
  }
  if (p.stage !== 'handed') return { deny: `PR #${n} is not handed back (${p.stage}); nothing to resume` }
  const out = await locked(() => applyNow($, cfg, p.key, { kind: 'resume' }))
  return { result: `Resumed PR #${n}: ${out?.after ? pipeLine(out.after) : 'the pipeline runs it again'}` }
}
