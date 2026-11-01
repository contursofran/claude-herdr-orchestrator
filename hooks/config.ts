import type { EngineInterface } from 'claude-code'
import type { Profile, Settings } from '../types'
import { RESET_AT, STATE_OWNER, TARGET, WRAP_UP } from './defaults'
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

// ~/.claude/herdr-agents.json (or $CLAUDE_CONFIG_DIR's), with the repo's own
// <session cwd>/.claude/herdr-agents.json over it (its profiles merged by name),
// so each repo can set its target, state file, profiles and the rest.
export async function config($: EngineInterface): Promise<Settings> {
  const user = await readJson($, await userConfigPath($))
  const repo = session.cwd ? await readJson($, `${session.cwd}/.claude/herdr-agents.json`) : {}
  return { ...user, ...repo, profiles: { ...user.profiles, ...repo.profiles } }
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
