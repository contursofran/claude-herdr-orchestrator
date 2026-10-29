import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Pipe } from '../types'
import { JOBS_KEEP_MS, PIPES_PREFIX } from './defaults'

// The PRs the pipeline owns, kept like the jobs (state.ts): in $.state, and in $.store under the
// session's id so a reload finds them. Its own file, so target.ts can count the waiting steps.

const pipesAtom = atom({ plugin: 'herdr-agents', key: 'pipes' } as const, {} as Record<string, Pipe>)

export async function pipes($: EngineInterface): Promise<Record<string, Pipe>> {
  return read($, pipesAtom)
}

// A pipe in a stage that still moves.
export const open = (p: Pipe) => !['handed', 'merged', 'closed'].includes(p.stage)

// Replaces (or, with undefined, removes) one pipe.
export async function savePipe($: EngineInterface, key: string, pipe: Pipe | undefined) {
  await update($, pipesAtom, all => {
    const { [key]: _, ...rest } = all
    return pipe ? { ...rest, [key]: pipe } : rest
  })
  await $.store.set(`${PIPES_PREFIX}${await $.session.id()}`, { at: await $.clock.now(), pipes: await read($, pipesAtom) })
}

// How many steps wait for a free worker slot, for belowTarget.
export async function waitingSteps($: EngineInterface) {
  return Object.values(await pipes($)).reduce((n, p) => n + (open(p) ? p.waiting.length : 0), 0)
}

// session.start: the session's pipes come back from $.store when $.state has none; other sessions' old copies go.
export async function restorePipes($: EngineInterface) {
  const now = await $.clock.now()
  const mine = `${PIPES_PREFIX}${await $.session.id()}`
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PIPES_PREFIX) || key === mine) continue
    const { at = 0 } = ((await $.store.get(key)) ?? {}) as { at?: number }
    if (now - at > JOBS_KEEP_MS) await $.store.delete(key)
  }
  if (Object.keys(await pipes($)).length > 0) return
  const kept = (await $.store.get(mine)) as { pipes?: Record<string, Pipe> } | undefined
  if (kept?.pipes && Object.keys(kept.pipes).length > 0) await update($, pipesAtom, all => ({ ...kept.pipes, ...all }))
}
