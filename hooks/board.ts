import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Board, Links, Row } from '../types'
import { config, target, wrappingUp } from './config'
import { LINGER_MS, QUIET_MAX_MS } from './defaults'
import { elapsed } from './format'
import { lastStatus } from './hc'
import { openQuestions, pingQuiet } from './owner'
import { session } from './session'
import { active, jobs } from './state'

// What the band shows of the workers, and the GitHub repo of each folder they used.
const board = atom({ plugin: 'herdr-agents', key: 'board' } as const, { now: 0, rows: [] } as Board)
const links = atom({ plugin: 'herdr-agents', key: 'links' } as const, { byCwd: {}, extra: {} } as Links)

export function readBoard($: EngineInterface) {
  return read($, board)
}
export function repoLinks($: EngineInterface) {
  return read($, links)
}

// After each turn: the context fill, shown on the band.
export async function showContext($: EngineInterface, tokens: number, limit: number) {
  await update($, board, b => ({ ...b, context: { tokens, limit } }))
}

// Folders whose git remotes were read this load (see learnRepos).
const scanned = new Set<string>()

// The GitHub repo (owner/name) of each folder not seen yet, from its git remotes, and the
// config's `repos` (short name -> owner/name): what a #123 on the band links to.
async function learnRepos($: EngineInterface, cwds: string[]): Promise<Links> {
  const found: Record<string, string> = {}
  for (const cwd of new Set(cwds)) {
    if (!cwd || scanned.has(cwd)) continue
    scanned.add(cwd)
    try {
      const ran = await $.process.run(['git', '-C', cwd, 'remote', '-v'])
      const slug = ran.exitCode === 0 ? ran.stdout.match(/github\.com[:/]([^/\s]+\/[^\s]+?)(?:\.git)?\s/)?.[1] : undefined
      if (slug) found[cwd] = slug
    } catch {}
  }
  const extra: Record<string, string> = (await config($)).repos ?? {}
  const held = await read($, links)
  if (Object.keys(found).length === 0 && JSON.stringify(extra) === JSON.stringify(held.extra)) return held
  let out = held
  await update($, links, l => (out = { byCwd: { ...l.byCwd, ...found }, extra }))
  return out
}

// Puts each shown worker's state into the band's atom. It makes no hc calls: a running
// worker shows the state its wait or the sweep last saw (lastStatus), and a failed sweep
// leaves that as it was, so one error never shows a worker as gone.
export async function refresh($: EngineInterface) {
  const now = await $.clock.now()
  await pingQuiet($, d => now - d.at > QUIET_MAX_MS)
  const { byCwd } = await learnRepos($, [session.cwd, ...Object.values(await jobs($)).map(j => j.cwd)])
  const asking = new Set((await openQuestions($)).map(d => d.from))
  const shown = Object.values(await jobs($)).filter(
    j => active(j) || asking.has(j.name) || (j.endedAt !== undefined && now - j.endedAt < LINGER_MS),
  )
  const rows: Row[] = []
  for (const j of shown) {
    let state = 'reported'
    if (j.status === 'starting') state = 'starting'
    if (j.status === 'running') state = lastStatus.get(j.name) ?? 'working'
    if (j.status === 'running' && j.wait && state !== 'blocked' && state !== 'gone') state = 'waiting'
    rows.push({
      name: j.name,
      profile: j.profile,
      state,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      ...(j.status === 'running' && j.wait ? { note: `${elapsed(now - j.wait.since)} · ${j.wait.for}` } : {}),
      ...(byCwd[j.cwd] ? { repo: byCwd[j.cwd] } : {}),
    })
  }
  const held = await read($, board)
  if (rows.length === 0 && held.rows.length === 0) return
  const want = await target($)
  const wrapUp = await wrappingUp($)
  await update($, board, b => ({ ...b, now, rows, target: want, wrapUp }))
}
