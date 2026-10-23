import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Job } from '../types'
import { JOBS_KEEP_MS, JOBS_PREFIX } from './defaults'

// The workers this session started, kept in $.state so a reload keeps them. Each
// module keeps its own values the same way, as atoms only it reads and writes.

export const jobsAtom = atom({ plugin: 'herdr-agents', key: 'jobs' } as const, {} as Record<string, Job>)

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
