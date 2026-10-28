import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Job } from '../types'
import { JOBS_DROP_MS, JOBS_KEEP_MS, JOBS_PREFIX } from './defaults'

// The workers this session started, kept in $.state so a reload keeps them. Each
// module keeps its own values the same way, as atoms only it reads and writes.

export const jobsAtom = atom({ plugin: 'herdr-agents', key: 'jobs' } as const, {} as Record<string, Job>)

// A worker that holds a slot: running, or still starting.
export const active = (j: Job) => j.status === 'running' || j.status === 'starting'

export async function jobs($: EngineInterface): Promise<Record<string, Job>> {
  return read($, jobsAtom)
}

export async function saveJob($: EngineInterface, job: Job) {
  await update($, jobsAtom, all => ({ ...all, [job.name]: job }))
  await keep($)
}

// Merges `patch` into a job as it is by now, so a status saved meanwhile stays.
export async function patchJob($: EngineInterface, name: string, patch: Partial<Job>) {
  await update($, jobsAtom, all => (all[name] ? { ...all, [name]: { ...all[name], ...patch } } : all))
  await keep($)
}

// Applies `fn` to the job as it is at this moment, in one update, so a guard and its patch
// cannot be split by an await. `fn` returns the new job, or undefined for no change.
// `before` is the job the update saw; `after` is undefined when nothing changed.
export async function updateJob($: EngineInterface, name: string, fn: (j: Job) => Job | undefined): Promise<{ before?: Job; after?: Job }> {
  let before: Job | undefined
  let after: Job | undefined
  await update($, jobsAtom, all => {
    before = all[name]
    after = undefined
    if (!before) return all
    after = fn(before)
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
