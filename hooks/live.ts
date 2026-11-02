import type { EngineInterface } from 'claude-code'
import { LIVE_COMMAND_MS, LIVE_SAVE_MS } from './defaults'

// What an agent is doing right now (#277), for its row: the tool it is running and when the model last said anything.
// Every session records its own from its hooks. A worker also writes it to the file spawn named in HERDR_AGENTS_LIVE, and its
// coordinator reads that file at its tick. Only workers running this mod have one: a Codex or opencode worker shows no line.

export type Live = { inTurn: boolean; outputAt: number; command: string | null; commandAt: number | null }

const running = new Set<{ command: string; at: number }>()
let path: string | null = null
let inTurn = false
let outputAt = 0
let savedAt = 0

function liveNow(): Live {
  const oldest = [...running].sort((a, b) => a.at - b.at)[0]
  return { inTurn, outputAt, command: oldest?.command ?? null, commandAt: oldest?.at ?? null }
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
  savedAt = 0
}

export async function liveTurn($: EngineInterface, started: boolean) {
  const now = await $.clock.now()
  running.clear()
  inTurn = started
  if (started) outputAt = now
  await save($, now)
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
  await save($, call.at)
  return async () => {
    running.delete(call)
    const now = await $.clock.now()
    outputAt = now
    await save($, now)
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
export const ownLiveFields = (now: number) => liveFields(liveNow(), now)

// A worker's, from the file it writes. No file, or one caught mid-write, shows no line until the next tick.
export async function workerLiveFields($: EngineInterface, dir: string, now: number) {
  try {
    return liveFields(JSON.parse(await $.fs.read(`${dir}/LIVE.json`)) as Live, now)
  } catch {
    return {}
  }
}
