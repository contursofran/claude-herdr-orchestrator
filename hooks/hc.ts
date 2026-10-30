import type { EngineInterface } from 'claude-code'
import { config } from './config'
import { session } from './session'

// What `hc ls` reports for a terminal: `status` is the flat word its program reported, left out when it has none.
export type HcListed = { address: string; name?: string; agent?: string; cwd?: string; state: string; status?: string; turn?: number }
// What `hc get` reports: `status` is the program's last record (null when it never reported), `kind` says what a
// blocked one waits for (permission, question, auth).
export type HcTerminal = {
  address: string
  name?: string | null
  state: string
  status: { state: string; app?: string; kind?: string | null } | null
  turn?: number
  labels?: Record<string, string>
  cwd?: string
}
// What `hc wait` returns. `status` is the word the program reported; `ended` is false on a timeout.
export type HcWait = { ended: boolean; reason: string; status: string | null; exit_code?: number | null; signal?: number | null }
// What `hc send` returns. `started` is null when the program reports no status.
export type HcSend = { started: boolean | null; status: string | null; turn: number }

// The last status hc reported for each worker (working, idle, done, blocked, error or unknown),
// or 'gone' once a report said its terminal was gone. The watches and the sweep set it from what
// hc says, prompt() sets 'working' once a prompt is delivered.
export const lastStatus = new Map<string, string>()

// The mod's hc calls run with no caller: from inside an hc terminal, hc would tag what agents
// receive with the caller's address (<hc from="t4">) and end every wait with the caller's message.
const NO_CALLER = { HC_TERMINAL_ID: '' }

// Runs the hc CLI and returns its JSON (--json goes right after the subcommand, before any `--` that
// starts a program's own arguments), typed by the caller (`T`); a non-zero exit throws with
// hc's message, and its error `kind` (not_found, blocked, finished…) and `hint` on the error.
// An hc that is not installed rejects in $.process.run, which callers treat as any CLI error.
export async function hc<T = unknown>($: EngineInterface, args: string[], timeoutMs = 90_000): Promise<T> {
  const ran = await $.process.run(['hc', args[0]!, '--json', ...args.slice(1)], { timeoutMs, env: NO_CALLER })
  if (ran.exitCode !== 0) {
    let e: { kind?: string; message?: string; hint?: string } | undefined
    try {
      e = JSON.parse(ran.stderr).error
    } catch {}
    const err = new Error(`hc ${args[0]}: ${e?.message ?? (ran.stderr || ran.stdout).trim()}`)
    throw Object.assign(err, { kind: e?.kind, hint: e?.hint })
  }
  return JSON.parse(ran.stdout) as T
}

export const kindOf = (err: unknown) => (err as { kind?: string }).kind

// Every live terminal hc lists, or only those with all of `labels` (key=value).
export async function listTerminals($: EngineInterface, labels: string[] = []) {
  return (await hc<{ terminals: HcListed[] }>($, ['ls', ...labels.flatMap(l => ['--label', l])])).terminals
}

// The live terminals of the workers this mod started. Throws when hc cannot answer.
export async function listWorkers($: EngineInterface) {
  return await listTerminals($, ['herdr-agents.role=worker'])
}

// A terminal's screen as hc reads it, with `lines` lines of history above it when given. A finished terminal stays readable.
export async function readScreen($: EngineInterface, name: string, lines?: number) {
  return (await hc<{ text: string }>($, ['read', name, ...(lines ? ['--lines', String(lines)] : [])])).text
}

// Ends a worker's terminal: kill, then remove (which also takes its tab away). One already gone is fine.
// hc refuses to remove a terminal that is still live, which a kill that is slow to land can leave for a moment.
export async function closeTerminal($: EngineInterface, name: string) {
  const tolerant = async (args: string[]) => {
    try {
      await hc($, args)
    } catch (err) {
      if (kindOf(err) !== 'not_found') throw err
    }
  }
  await tolerant(['kill', name])
  try {
    await tolerant(['rm', name])
  } catch (err) {
    if (kindOf(err) !== 'live') throw err
    await $.clock.sleep(1000)
    await tolerant(['rm', name])
  }
}

// A toast in this session. hc has no notification of its own; Herdr's app plays its sound and shows
// its own toast when a worker blocks or finishes.
export function notify($: EngineInterface, title: string, body: string) {
  $.ui.toast(`${title}: ${body}`)
}

// Workers trust their worktree on their own: when a CLI stops at its first-run
// folder-trust prompt for a folder under one of the trusted roots, answer it in the terminal. Any other prompt stays blocked.
// `trustRoots` sets the roots; by default they are the coordinator's folder and,
// when it is below the home folder, its parent (worktrees next to the repo).
export async function acceptFolderTrust($: EngineInterface, worker: string, cwd: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const parent = session.cwd.replace(/\/[^/]+$/, '')
  const roots: string[] = (await config($)).trustRoots ?? [session.cwd, ...(parent.startsWith(`${home}/`) ? [parent] : [])]
  const resolved = roots.map((r: string) => r.replace(/^~(?=\/)/, home).replace(/\/$/, ''))
  if (!resolved.some((r: string) => cwd === r || cwd.startsWith(`${r}/`))) return false

  const screen = await readScreen($, worker)
  // A narrow terminal wraps a long path over several lines, so compare without whitespace.
  const squash = (t: string) => t.replace(/\s+/g, '')
  if (!squash(screen).includes(squash(cwd))) return false
  let keys: string[]
  if (/Yes, I trust this folder/.test(screen)) keys = ['down', 'enter']
  else if (/Trust and continue/.test(screen)) keys = ['enter']
  else return false

  await hc($, ['keys', worker, ...keys])
  await hc($, ['wait', worker, '--timeout', '60'], 70_000)
  return true
}

// Waits until a freshly started CLI is ready for its first prompt: idle or done. A CLI that exits or
// reports an error throws; one stopped at the folder-trust prompt is answered (acceptFolderTrust), any
// other prompt throws. Out of tries it returns anyway: the prompt then goes in, and a CLI that
// reports no status is caught by the quiet-screen rule if it hung.
export async function waitReady($: EngineInterface, worker: string, cwd: string, kind: string) {
  const tries = kind === 'claude' || kind === 'codex' ? 12 : 3
  let checkedTrust = false
  for (let i = 0; i < tries; i++) {
    const w = await hc<HcWait>($, ['wait', worker, '--timeout', '5'], 15_000)
    // A program that exits during a pending wait can read as reason "status" with no status.
    if (w.ended && (!w.status || w.reason === 'exit')) throw new Error(`the CLI exited (code ${w.exit_code ?? w.signal ?? 'unknown'})`)
    if (w.status === 'idle' || w.status === 'done') {
      // A trust prompt can read as idle: answer it once before the first prompt goes in, and keep waiting if it was one.
      if (!checkedTrust) {
        checkedTrust = true
        if (await acceptFolderTrust($, worker, cwd)) continue
      }
      return
    }
    if (w.status === 'error') throw new Error('the CLI reported an error while it started')
    if ((w.status === 'blocked' || !w.ended) && (await acceptFolderTrust($, worker, cwd))) continue
    if (w.status === 'blocked') throw new Error('the CLI is blocked during startup')
  }
}

// The command a worker runs: the CLI with the profile's environment and the role, through the
// user's login shell so its rc files set PATH (the core's own PATH lacks tools like opencode). Codex
// needs --no-daemon to run under hc.
export async function workerArgv($: EngineInterface, kind: string, args: string[], env: [string, string][]) {
  const rest = kind === 'codex' && !args.includes('--no-daemon') ? ['--no-daemon', ...args] : args
  const cmd = ['/usr/bin/env', ...env.map(([k, v]) => `${k}=${v}`), kind, ...rest]
  const shell = (await $.env.get('SHELL')) ?? ''
  const base = shell.split('/').pop()
  if (base === 'zsh' || base === 'bash') return [shell, '-ilc', 'exec "$@"', base, ...cmd]
  if (base === 'fish') return [shell, '-ilc', 'exec $argv', ...cmd]
  return cmd
}

// Watches a worker with `hc events` in a child process until its status is one of `until`, and
// returns that status. Returns undefined when the terminal finished, was removed or is unknown, when
// the stream missed events or ended, or when `stale()` says a newer watch replaced this one (checked
// on every line, and hc sends a heartbeat every 15 s). The first line is a snapshot, so a status the
// worker is already in answers at once. Leaving the loop ends the child.
export async function watch($: EngineInterface, name: string, until: string[], stale: () => boolean): Promise<string | undefined> {
  let pending = ''
  try {
    for await (const piece of $.process.spawn({ argv: ['hc', 'events', '--terminal', name, '--json'], env: NO_CALLER })) {
      if (piece.stream !== 'stdout') continue
      // Pieces are not lines: a line may arrive in parts, and a piece may hold several.
      pending += piece.text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (stale()) return undefined
        let msg: {
          terminals?: { state?: string; status?: { state?: string } | null }[]
          method?: string
          params?: { type?: string; data?: { status?: { state?: string } | null } }
        }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        let status: string | undefined
        if (msg.terminals) {
          const t = msg.terminals[0]
          if (!t || (t.state !== undefined && t.state !== 'live')) return undefined
          status = t.status?.state
        } else if (msg.method === 'event') {
          const type = msg.params?.type
          if (type === 'finished' || type === 'removed' || type === 'missed') return undefined
          if (type === 'status') status = msg.params?.data?.status?.state
        }
        if (status && until.includes(status)) return status
      }
    }
  } catch {}
  return undefined
}
