import type { EngineInterface } from 'claude-code'
import type { PipelineFile, PipelineSettings, Profile, Settings } from '../types'
import {
  PIPE_CI_EVERY_MINUTES,
  PIPE_CI_MAX_MINUTES,
  PIPE_MAX_SPAWNS,
  PIPE_NO_CI_MINUTES,
  PIPE_PAUSE_MINUTES,
  PIPE_RESCUE_AFTER,
  PIPE_ROUNDS,
  RESET_AT,
  STATE_OWNER,
  TARGET,
  WRAP_UP,
} from './defaults'
import { session } from './session'

// Claude workers run in their reviewed auto mode (each approval goes to the
// CLI's own automatic reviewer). A worker waiting at a prompt is reported as
// blocked. Profiles in herdr-agents.json add to these or replace them by name,
// which is where the person adds other CLIs (codex, opencode) or approval modes.
export const PROFILES: Record<string, Profile> = {
  // The subagents in this repo's agents/ folder, which Claude Code names after the plugin.
  // `claude --agent` ignores a subagent's `effort:` line, so each profile passes --effort.
  planner: {
    kind: 'claude',
    args: ['--agent', 'herdr-agents:planner', '--effort', 'high', '--permission-mode', 'auto'],
    note: 'Claude planner agent (Opus high)',
  },
  builder: {
    kind: 'claude',
    args: ['--agent', 'herdr-agents:builder', '--effort', 'medium', '--permission-mode', 'auto'],
    note: 'Claude builder agent (Sonnet medium)',
  },
  reviewer: {
    kind: 'claude',
    args: ['--agent', 'herdr-agents:reviewer', '--effort', 'high', '--permission-mode', 'auto'],
    note: 'Claude reviewer agent (Opus high)',
  },
  // No subagent: the full toolset, for root-cause hunts and fixes that failed twice.
  debugger: {
    kind: 'claude',
    args: ['--model', 'opus', '--effort', 'medium', '--permission-mode', 'auto'],
    note: 'Claude Opus medium, full tools (debugging, tricky fixes)',
  },
}

// The built-in profiles are the playbook's steps: a profile of the same name in
// herdr-agents.json changes its model or flags, and `disable` turns off any but the
// builder, which every issue needs. `smallTasks` names a profile for small,
// well-defined tasks (none by default).
export const BUILT_IN = Object.keys(PROFILES)

export const OPTIONAL = ['planner', 'reviewer', 'debugger']

export async function readJson($: EngineInterface, path: string): Promise<Settings> {
  if (!(await $.fs.exists(path))) return {}
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return {}
  }
}

export async function userConfigPath($: EngineInterface): Promise<string> {
  return `${(await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`}/herdr-agents.json`
}

// The folder's `pipeline` keys win over the user's one by one, but `merge: "auto"` counts
// only from the folder file: a user-level "auto" would merge in every repo.
export function mergePipeline(user: PipelineFile | undefined, repo: PipelineFile | undefined): PipelineFile | undefined {
  if (!user && !repo) return undefined
  const { merge, ...rest } = user ?? {}
  return { ...rest, ...(merge !== undefined && merge !== 'auto' && { merge }), ...repo }
}

// ~/.claude/herdr-agents.json (or $CLAUDE_CONFIG_DIR's), with the repo's own
// <session cwd>/.claude/herdr-agents.json over it (its profiles merged by name),
// so each repo can set its target, state file, profiles and the rest.
export async function config($: EngineInterface): Promise<Settings> {
  const user = await readJson($, await userConfigPath($))
  const repo = session.cwd ? await readJson($, `${session.cwd}/.claude/herdr-agents.json`) : {}
  const pipeline = mergePipeline(user.pipeline, repo.pipeline)
  return { ...user, ...repo, profiles: { ...user.profiles, ...repo.profiles }, ...(pipeline && { pipeline }) }
}

// Every profile, the turned-off built-ins too.
export async function allProfiles($: EngineInterface): Promise<Record<string, Profile>> {
  return { ...PROFILES, ...(await config($)).profiles }
}

export async function turnedOff($: EngineInterface): Promise<Set<string>> {
  const named = (await config($)).disable
  return new Set((Array.isArray(named) ? named : []).filter((name: string) => OPTIONAL.includes(name)))
}

// The profiles spawn takes.
export async function profiles($: EngineInterface): Promise<Record<string, Profile>> {
  const all = await allProfiles($)
  for (const name of await turnedOff($)) delete all[name]
  return all
}

export async function smallTasks($: EngineInterface): Promise<string | undefined> {
  const name = (await config($)).smallTasks
  return typeof name === 'string' && (await profiles($))[name] ? name : undefined
}

// A built-in profile whose settings differ from the one shipped.
export function customized(name: string, p: Profile | undefined) {
  const shipped = PROFILES[name]
  return !!shipped && !!p && JSON.stringify(p) !== JSON.stringify(shipped)
}

// Workers that read a worktree without building in it; they never block a builder spawn.
export function reviewsOnly(profile: string) {
  return profile === 'reviewer' || profile === 'planner'
}

// Where the coordinator keeps its state, and the context size past which it is reset
// (see maybeReset). The state file belongs to the session that last wrote it (recorded
// under STATE_OWNER in $.store); any other session saves to a handoff file of its own.
export async function resetSettings($: EngineInterface) {
  const c = await config($)
  const named = (typeof c.statePath === 'string' ? c.statePath : 'COORDINATOR-STATE.md').replace(
    /^~(?=\/)/,
    (await $.env.get('HOME')) ?? '~',
  )
  const shared: string = named.startsWith('/') ? named : `${session.cwd}/${named}`
  const id: string = await $.session.id()
  const owner = (await $.store.get(STATE_OWNER)) as { path: string; session: string } | undefined
  const mine = !owner || owner.path !== shared || owner.session === id
  return {
    limit: typeof c.resetAt === 'number' ? c.resetAt : RESET_AT,
    coordinator: mine,
    statePath: mine ? shared : `${session.cwd}/.herdr-agents/handoff-${id.slice(0, 8)}.md`,
    shared,
  }
}

// Records this session as the owner of the shared state file once it writes it.
export async function claimState($: EngineInterface, file: unknown) {
  const { shared } = await resetSettings($)
  if (file === shared) await $.store.set(STATE_OWNER, { path: shared, session: await $.session.id() })
}

// A caller that already read the settings passes them: each read is two file checks and a parse.
export async function target($: EngineInterface, settings?: Settings): Promise<number> {
  const c = settings ?? (await config($))
  return typeof c.target === 'number' ? c.target : TARGET
}

// The owner's wrap-up switch: while it is on, no new worker starts (a reviewer excepted:
// it finishes an open PR) and reports stop asking for more, while the running workers
// finish. The wrap-up command turns it on for the coordinators of this session's folder
// (kept in $.store, so every session there sees it); `wrapUp: true` in the user's
// settings turns it on everywhere. Wrap-up off clears both.
export async function wrappingUp($: EngineInterface, settings?: Settings): Promise<boolean> {
  const folders = ((await $.store.get(WRAP_UP)) ?? {}) as Record<string, boolean>
  return folders[session.cwd] === true || (settings ?? (await config($))).wrapUp === true
}

const whole = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback

// The PR pipeline's settings, or undefined while `pipeline.enabled` is not true. Numbers are
// clamped; a profile name that is not a profile in effect falls back to its default, with a
// `warning` for the pipeline tool's status. A folder's keys win over the user's one by one.
export async function pipelineSettings($: EngineInterface): Promise<PipelineSettings | undefined> {
  return parsePipeline((await config($)).pipeline, await profiles($))
}

// The pure part: the `pipeline` key and the profiles in effect in, the settings out.
export function parsePipeline(p: PipelineFile | undefined, known: Record<string, Profile>): PipelineSettings | undefined {
  if (!p || p.enabled !== true) return undefined
  const warnings: string[] = []
  const pick = (role: 'build' | 'review' | 'rescue', fallback: string) => {
    const named: unknown = p.profiles?.[role]
    if (named === undefined) return fallback
    if (typeof named === 'string' && known[named]) return named
    warnings.push(`pipeline.profiles.${role} "${String(named)}" is not a profile; using ${fallback}`)
    return fallback
  }
  const rounds = whole(p.rounds, PIPE_ROUNDS, 1, 10)
  const cap = typeof p.cap === 'number' && Number.isFinite(p.cap) ? Math.min(20, Math.max(1, Math.round(p.cap))) : null
  return {
    enabled: true,
    merge: p.merge === 'auto' ? 'auto' : 'ready',
    rounds,
    rescueAfter: whole(p.rescueAfter, PIPE_RESCUE_AFTER, 0, rounds),
    profiles: {
      build: pick('build', 'builder'),
      review: pick('review', 'reviewer'),
      rescue: pick('rescue', 'debugger'),
    },
    cap,
    ciEveryMinutes: whole(p.ciEveryMinutes, PIPE_CI_EVERY_MINUTES, 1, 30),
    ciMaxMinutes: whole(p.ciMaxMinutes, PIPE_CI_MAX_MINUTES, 1, 24 * 60),
    noCiMinutes: whole(p.noCiMinutes, PIPE_NO_CI_MINUTES, 0, 24 * 60),
    pauseMinutes: whole(p.pauseMinutes, PIPE_PAUSE_MINUTES, 1, 24 * 60),
    maxSpawns: whole(p.maxSpawns, PIPE_MAX_SPAWNS, 1, 50),
    ownerTest: Array.isArray(p.ownerTest) ? p.ownerTest.filter((g): g is string => typeof g === 'string' && g !== '') : [],
    ...(warnings.length && { warning: warnings.join('; ') }),
  }
}
