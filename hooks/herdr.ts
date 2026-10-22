import type { EngineInterface } from 'claude-code'
import { config } from './config'
import { session } from './session'

// What `herdr agent get` and `herdr agent list` report for a worker.
export type HerdrAgent = { agent_status: string; pane_id: string; tab_id: string; cwd?: string }

// Runs the herdr CLI and returns its JSON `result`, typed by the caller (`T`); a
// non-zero exit or an `error` in the JSON throws with herdr's message.
export async function herdr<T = unknown>($: EngineInterface, args: string[], timeoutMs = 90_000): Promise<T> {
  const ran = await $.process.run(['herdr', ...args], { timeoutMs })
  let json: { result?: T; error?: { message?: string } } | undefined
  try {
    json = JSON.parse(ran.stdout)
  } catch {
    json = undefined
  }
  if (ran.exitCode !== 0 || json?.error) {
    throw new Error(`herdr ${args[0]} ${args[1] ?? ''}: ${json?.error?.message ?? (ran.stderr || ran.stdout).trim()}`)
  }
  return json?.result as T
}

// A herdr notification with the request sound, plus a toast in this session.
export async function notify($: EngineInterface, title: string, body: string, sound = true) {
  $.ui.toast(`${title}: ${body}`)
  try {
    await $.process.run(['herdr', 'notification', 'show', title, '--body', body.slice(0, 200), ...(sound ? ['--sound', 'request'] : [])])
  } catch {}
}

// Workers trust their worktree on their own: when a CLI stops at its first-run
// folder-trust prompt for a folder under one of the trusted roots, answer it in the tab. Any other prompt stays blocked.
// `trustRoots` sets the roots; by default they are the coordinator's folder and,
// when it is below the home folder, its parent (worktrees next to the repo).
export async function acceptFolderTrust($: EngineInterface, worker: string, pane: string, cwd: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const parent = session.cwd.replace(/\/[^/]+$/, '')
  const roots: string[] = (await config($)).trustRoots ?? [session.cwd, ...(parent.startsWith(`${home}/`) ? [parent] : [])]
  const resolved = roots.map((r: string) => r.replace(/^~(?=\/)/, home).replace(/\/$/, ''))
  if (!resolved.some((r: string) => cwd === r || cwd.startsWith(`${r}/`))) return false

  const screen = (await $.process.run(['herdr', 'pane', 'read', pane, '--source', 'visible'])).stdout
  if (!screen.includes(cwd)) return false
  let keys: string[]
  if (/Yes, I trust this folder/.test(screen)) keys = ['down', 'enter']
  else if (/Trust and continue/.test(screen)) keys = ['enter']
  else return false

  await herdr($, ['agent', 'send-keys', worker, ...keys])
  await herdr($, ['agent', 'wait', worker, '--until', 'idle', '--timeout', '60000'], 70_000)
  return true
}
