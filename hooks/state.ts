import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Job } from '../types'

// The workers this session started, kept in $.state so a reload keeps them. Each
// module keeps its own values the same way, as atoms only it reads and writes.

export const jobsAtom = atom({ plugin: 'herdr-agents', key: 'jobs' } as const, {} as Record<string, Job>)

export async function jobs($: EngineInterface): Promise<Record<string, Job>> {
  return read($, jobsAtom)
}

export async function saveJob($: EngineInterface, job: Job) {
  await update($, jobsAtom, all => ({ ...all, [job.name]: job }))
}
