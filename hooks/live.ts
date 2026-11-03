import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { LIVE_COMMAND_MS, LIVE_SAVE_MS, QUIET_SHOW_MS, QUIET_WARN_MS } from './defaults'

// What an agent is doing right now (#277), for its row: the tool it is running and when the model last said anything.
// Every session records its own from its hooks. A worker also writes it to the file spawn named in HERDR_AGENTS_LIVE, and its
// coordinator reads that file at its tick. Only workers running this mod have one: a Codex or opencode worker shows no line.

export type Live = {
  inTurn: boolean
  outputAt: number
  command: string | null
  commandAt: number | null
  // When this turn started and how many tools it has run (#174): the coordinator's own live line only. Older files lack them.
  turnAt?: number | null
  tools?: number
  // The context fill after its last turn; kept between turns.
  context?: { tokens: number; limit: number }
}

const running = new Set<{ command: string; at: number }>()
let path: string | null = null
let inTurn = false
let outputAt = 0
let turnAt: number | null = null
let tools = 0
let savedAt = 0
let context: Live['context']

export type BandText = { text: string; warn: boolean } | null

// What the band last drew. Its render reads it, so a change redraws the band: a tool call or a turn start/end updates it at once,
// the coordinator's tick when the minute or the quiet state moves.
const shown = atom({ plugin: 'herdr-agents', key: 'liveline' } as const, { line: null as BandText })

export async function liveLine($: EngineInterface): Promise<BandText> {
  return (await read($, shown)).line
}

// Works out the band's line now and stores it if it changed (the text carries the minute, so a same-minute tick writes nothing).
export async function syncLive($: EngineInterface) {
  const line = bandLine(await $.clock.now())
  const prev = (await read($, shown)).line
  if (prev?.text === line?.text && prev?.warn === line?.warn) return
  await update($, shown, () => ({ line }))
}

function liveNow(): Live {
  const oldest = [...running].sort((a, b) => a.at - b.at)[0]
  return {
    inTurn,
    outputAt,
    turnAt,
    tools,
    command: oldest?.command ?? null,
    commandAt: oldest?.at ?? null,
    ...(context ? { context } : {}),
  }
}

async function save($: EngineInterface, now: number) {
  savedAt = now
  if (path) await $.fs.write(path, JSON.stringify(liveNow()))
}

export async function startLive($: EngineInterface) {
  path = (await $.env.get('HERDR_AGENTS_LIVE')) || null
  running.clear()
  inTurn = false
  outputAt = 0
  turnAt = null
  tools = 0
  savedAt = 0
  context = undefined
  await syncLive($)
}

// After each turn: how full this session's context is, for the worker panel's `ctx 41%`.
export async function liveContext($: EngineInterface, tokens: number, limit: number) {
  context = { tokens, limit }
  await save($, await $.clock.now())
}

export async function liveTurn($: EngineInterface, started: boolean) {
  const now = await $.clock.now()
  running.clear()
  inTurn = started
  if (started) outputAt = now
  turnAt = started ? now : null
  tools = 0
  await save($, now)
  await syncLive($)
}

// A piece of the model's answer. It arrives many times a second, so the file follows at most every LIVE_SAVE_MS.
export async function liveOutput($: EngineInterface) {
  const now = await $.clock.now()
  outputAt = now
  if (now - savedAt >= LIVE_SAVE_MS) await save($, now)
}

// A tool started; what it returns ends it. Its end counts as output: the model has something to answer now.
export async function liveTool($: EngineInterface, e: { tool: string; command?: unknown }) {
  const call = { command: toolLabel(e), at: await $.clock.now() }
  running.add(call)
  tools++
  await save($, call.at)
  await syncLive($)
  return async () => {
    running.delete(call)
    const now = await $.clock.now()
    outputAt = now
    await save($, now)
    await syncLive($)
  }
}

const toolLabel = (e: { tool: string; command?: unknown }) =>
  (e.tool === 'Bash' && typeof e.command === 'string' && commandLabel(e.command)) || e.tool.replace(/^mcp__.*__/, '')

// `cd x && FOO=1 npm test -- --watch | tail` reads as `npm test`: the first step that does the work, up to its first flag.
// Stopping there also keeps most arguments that could hold a secret off the board.
export function commandLabel(command: string) {
  const steps = (command.trim().split('\n')[0] ?? '')
    .split(/&&|\|\||;/)
    .map(s => s.trim())
    .filter(Boolean)
  const step = steps.find(s => !/^(cd|export|set|source|\.)\s/.test(s)) ?? steps[0] ?? ''
  const words: string[] = []
  for (const word of (step.split('|')[0] ?? '').trim().split(/\s+/)) {
    if (words.length === 0 && /^\w+=/.test(word)) continue
    if (words.length > 0 && (words.length === 4 || /^-|=|['"`$]/.test(word))) break
    words.push(word)
  }
  return words.join(' ').slice(0, 40)
}

// What goes on the board. A command only once it has run LIVE_COMMAND_MS, and the output time rounded up to the minute, so that
// a busy agent doesn't rewrite the board file on every tick (#151): the app works the clocks out from these.
export function liveFields(live: Live | null, now: number) {
  if (!live?.inTurn) return {}
  const shown = live.command !== null && live.commandAt !== null && now - live.commandAt >= LIVE_COMMAND_MS
  return {
    ...(shown ? { command: live.command, commandAt: live.commandAt } : {}),
    outputAt: Math.ceil(live.outputAt / 60_000) * 60_000,
  }
}

// This session's own, for a coordinator's row.
// It also has the turn's start (rounded down to the minute, like the output time) and its tool count (#174); a worker's row has neither,
// so the board isn't rewritten at every tool call of every worker.
export function ownLiveFields(now: number) {
  const live = liveNow()
  const fields = liveFields(live, now)
  if (!live.inTurn || live.turnAt == null) return fields
  return { ...fields, turnAt: Math.floor(live.turnAt / 60_000) * 60_000, tools: live.tools ?? 0 }
}

// The coordinator's line above its prompt when the app mod isn't drawing: `3m · 12 tools · running npm test`, or `· no output · 2m`
// once the model has said nothing for QUIET_SHOW_MS. Null outside a turn.
export function bandLine(now: number) {
  const live = liveNow()
  if (!live.inTurn || live.turnAt == null) return null
  const mins = (ms: number) => `${Math.max(0, Math.floor(ms / 60_000))}m`
  const n = live.tools ?? 0
  const parts = [mins(now - live.turnAt), `${n} ${n === 1 ? 'tool' : 'tools'}`]
  if (live.command) parts.push(`running ${live.command}`)
  else if (now - live.outputAt >= QUIET_SHOW_MS) parts.push(`no output · ${mins(now - live.outputAt)}`)
  return { text: parts.join(' · '), warn: !live.command && now - live.outputAt >= QUIET_WARN_MS }
}

// A worker's, from the file it writes, read once: the live line (only while it works) and its context fill as a whole percent
// (what the board shows, so it only rewrites when the number moves). No file, or one caught mid-write, shows nothing until the next tick.
export async function workerLive($: EngineInterface, dir: string, now: number, working: boolean) {
  let live: Live
  try {
    live = JSON.parse(await $.fs.read(`${dir}/LIVE.json`)) as Live
  } catch {
    return {}
  }
  // `?.`: a LIVE.json holding JSON null reads as null.
  const c = live?.context
  const context = c && c.limit > 0 && c.tokens >= 0 ? { context: Math.min(100, Math.round((c.tokens / c.limit) * 100)) } : {}
  return { ...(working ? liveFields(live, now) : {}), ...context }
}
