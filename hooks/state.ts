import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Job } from '../types'
import { BLOCKED_COUNTS_MS, JOBS_DROP_MS, JOBS_KEEP_MS, JOBS_PREFIX } from './defaults'

// The workers this session started, kept in $.state so a reload keeps them. Each
// module keeps its own values the same way, as atoms only it reads and writes.

export const jobsAtom = atom({ plugin: 'herdr-agents', key: 'jobs' } as const, {} as Record<string, Job>)

// A worker that holds a slot: running, or still starting.
export const active = (j: Job) => j.status === 'running' || j.status === 'starting'

// A worker the limit counts as working: one in a slot, not parked on a WAIT.json, or one that went blocked with no
// report less than BLOCKED_COUNTS_MS ago. After a real report its slot is already given up.
export const working = (j: Job, now: number) =>
  !j.wait &&
  (active(j) ||
    (j.status === 'reported' && j.tail === 'blocked' && j.reportStatus === 'blocked' && now - (j.endedAt ?? 0) < BLOCKED_COUNTS_MS))

export async function jobs($: EngineInterface): Promise<Record<string, Job>> {
  return read($, jobsAtom)
}

// A job whose wait ends in this change has sat parked since the wait began: that time is kept apart from its
// working time (see timecomment.ts). A change that opens a new time window (timeFrom) starts from zero.
function parked(before: Job | undefined, after: Job, now: number): Job {
  // A wait that is replaced by another (a new `for`) ends too; one that only moves its check time does not.
  if (!before?.wait || (after.wait && after.wait.since === before.wait.since) || after.timeFrom !== before.timeFrom) return after
  return { ...after, parkedMs: (after.parkedMs ?? 0) + Math.max(0, now - before.wait.since) }
}

export async function saveJob($: EngineInterface, job: Job) {
  const now = await $.clock.now()
  await update($, jobsAtom, all => ({ ...all, [job.name]: parked(all[job.name], job, now) }))
  await keep($)
}

// Merges `patch` into a job as it is by now, so a status saved meanwhile stays.
export async function patchJob($: EngineInterface, name: string, patch: Partial<Job>) {
  const now = await $.clock.now()
  await update($, jobsAtom, all => (all[name] ? { ...all, [name]: parked(all[name], { ...all[name], ...patch }, now) } : all))
  await keep($)
}

// Applies `fn` to the job as it is at this moment, in one update, so a guard and its patch
// cannot be split by an await. `fn` returns the new job, or undefined for no change.
// `before` is the job the update saw; `after` is undefined when nothing changed.
export async function updateJob($: EngineInterface, name: string, fn: (j: Job) => Job | undefined): Promise<{ before?: Job; after?: Job }> {
  let before: Job | undefined
  let after: Job | undefined
  const now = await $.clock.now()
  await update($, jobsAtom, all => {
    before = all[name]
    after = undefined
    if (!before) return all
    after = fn(before)
    if (after) after = parked(before, after, now)
    return after ? { ...all, [name]: after } : all
  })
  if (after) await keep($)
  return { before, after }
}

// The job as it is at this moment. A plain read inside a long step can see the state as it
// was when the step began; an update's callback always sees the latest.
export async function latestJob($: EngineInterface, name: string): Promise<Job | undefined> {
  return (await updateJob($, name, () => undefined)).before
}

// $.state should outlive /reload-plugins, yet a reload has come back with no jobs
// while the workers ran on (#11), leaving stop, message and the watchers without
// them. So every change is also kept in $.store under the session's id, and
// session.start reads it back when $.state has none.
async function keep($: EngineInterface) {
  await $.store.set(`${JOBS_PREFIX}${await $.session.id()}`, { at: await $.clock.now(), jobs: await read($, jobsAtom) })
}

export async function restoreJobs($: EngineInterface): Promise<number> {
  const now = await $.clock.now()
  const mine = `${JOBS_PREFIX}${await $.session.id()}`
  // Other sessions' copies go once they are a few days old.
  for (const key of await $.store.keys()) {
    if (!key.startsWith(JOBS_PREFIX) || key === mine) continue
    const { at = 0 } = ((await $.store.get(key)) ?? {}) as { at?: number }
    if (now - at > JOBS_KEEP_MS) await $.store.delete(key)
  }
  if (Object.keys(await jobs($)).length > 0) return 0
  const kept = (await $.store.get(mine)) as { jobs?: Record<string, Job> } | undefined
  const back = kept?.jobs ?? {}
  if (Object.keys(back).length === 0) return 0
  await update($, jobsAtom, all => ({ ...back, ...all }))
  return Object.keys(back).length
}

// Reported jobs that ended more than JOBS_DROP_MS ago leave $.state and $.store, so the jobs
// map (and the prune scan over it) does not grow for good. Returns how many were dropped.
export async function dropOldJobs($: EngineInterface): Promise<number> {
  const now = await $.clock.now()
  let dropped = 0
  await update($, jobsAtom, all => {
    const next: Record<string, Job> = {}
    for (const [name, j] of Object.entries(all)) {
      if (j.status === 'reported' && !j.tail && j.endedAt !== undefined && now - j.endedAt > JOBS_DROP_MS) dropped++
      else next[name] = j
    }
    return dropped ? next : all
  })
  if (dropped) await keep($)
  return dropped
}
