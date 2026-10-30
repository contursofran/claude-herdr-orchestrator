import type { EngineInterface } from 'claude-code'

// The opencode plugin that reports a worker's status to hc. opencode loads every file in its plugins folder;
// this one is written for workers of kind `opencode` (see ensureOpencodePlugin). It is active only inside an
// hc terminal (HC_TERMINAL_ID set) and writes hc's status record (OSC 7501) to the terminal.
// Like Herdr's own opencode plugin it ignores the events of child sessions (subagents), except a question or
// permission they ask, which blocks the worker. HC_STATUS_TTY replaces /dev/tty (for tests).
// The plugin's logic is this function; the file written for opencode is its source text (it stands alone, with no
// types), so tests call it directly. `fs` and `env` are node:fs and process.env; `proc` is {pid, ppid} of this
// process (and `now`, replacing Date.now for tests) and `run(cmd, args)` returns a command's stdout
// (node:child_process execFileSync).
// opencode 1 loads `server`, in the program itself. opencode 2 loads `setup`, and with --standalone runs it in a
// child `opencode serve` that has the worker's environment but no controlling terminal, so /dev/tty fails and the
// report goes to its parent's terminal. Without --standalone it runs in the shared background server, which has no
// HC_TERMINAL_ID, so the plugin stays off and the worker reports nothing.
// A nested opencode (started by another program in the same terminal, e.g. a claude worker) inherits
// HC_TERMINAL_ID, so it reports only when it is the terminal's own program: hc's `pid` for the terminal is this
// process, or it is this process's parent and runs opencode (opencode 2's own program above its server). `ps -o comm=`
// names the program alone, so an agent's arguments can't pass for it. If hc or ps can't tell, it reports.
export function hcStatusPlugin(fs: any, env: any, proc: any = {}, run: any = null) {
  const STATES = new Map([
    ['permission.asked', 'blocked:kind=permission'],
    ['question.asked', 'blocked:kind=question'],
    ['form.created', 'blocked:kind=question'],
    ['permission.replied', 'working'],
    ['question.replied', 'working'],
    ['question.rejected', 'working'],
    ['form.replied', 'working'],
    ['form.cancelled', 'working'],
    ['session.compacted', 'working'],
    ['session.execution.started', 'working'],
    ['tool.execute.before', 'working'],
    ['tool.execute.after', 'working'],
    ['session.error', 'error'],
    ['session.execution.failed', 'error'],
    ['session.idle', 'idle'],
    ['session.execution.succeeded', 'idle'],
    ['session.execution.interrupted', 'idle'],
  ])
  // form.created has its session inside `form`, so it is never filtered: a subagent's question blocks the worker too.
  const CHILD_STATES = new Set([
    'permission.asked',
    'question.asked',
    'permission.replied',
    'question.replied',
    'question.rejected',
    'form.replied',
    'form.cancelled',
  ])
  const WORKING = new Set(['active', 'busy', 'pending', 'retry', 'running', 'streaming', 'working'])

  const stateOf = (type: any, properties: any) => {
    if (type === 'session.status') {
      const s = properties?.status
      const kind = String((typeof s === 'string' ? s : s?.type) ?? '').toLowerCase()
      return WORKING.has(kind) ? 'working' : kind === 'idle' ? 'idle' : undefined
    }
    return STATES.get(type)
  }

  const ps = (field: any, pid: any) => run('ps', ['-o', `${field}=`, '-p', String(pid)]).trim()
  const isTerminalProgram = () => {
    try {
      const { pid: root } = JSON.parse(run('hc', ['get', env.HC_TERMINAL_ID, '--json']))
      if (typeof root !== 'number' || root === proc.pid) return true
      if (proc.ppid !== root) return false
      const program = ps('comm', root)
      return !program || /(^|\/)opencode(\.exe)?$/.test(program)
    } catch (e) {
      return true
    }
  }

  // What both versions share, once this process is known to report: `send` and the handling of an event.
  const start = () => {
    if (!env.HC_TERMINAL_ID || !isTerminalProgram()) return undefined
    let tty = env.HC_STATUS_TTY || '/dev/tty'
    const now = proc.now || Date.now
    let askAfter = 0
    const report = (state: any) => {
      const record = '\x1b]7501;state=' + state + ':app=opencode\x1b\\'
      try {
        fs.appendFileSync(tty, record)
      } catch (e) {
        // ps can hold up a report for 3 s, so after any failed write it is asked at most once a minute.
        if (env.HC_STATUS_TTY || now() < askAfter) return
        askAfter = now() + 60000
        try {
          const parent = ps('tty', proc.ppid)
          if (!/^\w/.test(parent)) return
          tty = '/dev/' + parent
          fs.appendFileSync(tty, record)
        } catch (e) {}
      }
    }
    const children = new Set()
    // After an error the worker stays `error` (idle reports are ignored) until the next sign of work.
    let failed = false
    const send = (state: any) => {
      if (state === 'idle' && failed) return
      if (state !== 'idle') failed = state === 'error'
      report(state)
    }
    const handle = (type: any, properties: any) => {
      const info = properties.info
      if (info?.id && info.parentID) children.add(info.id)
      if (type === 'session.created' && properties.parentID) children.add(properties.sessionID)
      const state = stateOf(type, properties)
      if (!state) return
      const id = typeof properties.sessionID === 'string' ? properties.sessionID : undefined
      if (id && children.has(id) && !CHILD_STATES.has(type)) return
      send(state)
    }
    report('idle')
    return { send, handle, isChild: (id: any) => children.has(id) }
  }

  return {
    server: async () => {
      const on = start()
      if (!on) return {}
      const work = async ({ sessionID }: any = {}) => {
        if (!sessionID || !on.isChild(sessionID)) on.send('working')
      }
      return {
        'chat.message': work,
        'tool.execute.before': work,
        'tool.execute.after': work,
        event: async ({ event }: any) => on.handle(event?.type, event?.properties ?? {}),
      }
    },
    setup: (ctx: any) => {
      const on = start()
      if (!on) return undefined
      const stop = new AbortController()
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: stop.signal })) on.handle(event?.type, event?.data ?? {})
      })().catch(() => {})
      return () => stop.abort()
    },
  }
}

export const OPENCODE_PLUGIN = `// installed by herdr-agents; rewritten when it differs, so do not edit it.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

${hcStatusPlugin.toString()}

const plugin = hcStatusPlugin(fs, process.env, { pid: process.pid, ppid: process.ppid }, (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 3000 }));

export default { id: "hc.status", ...plugin };
`

// Writes the plugin to ${OPENCODE_CONFIG_DIR, or XDG_CONFIG_HOME or ~/.config + /opencode}/plugins/hc-status.js when it is missing or
// different. Returns whether it wrote. A failure is ignored: the worker then just reports no status.
// `profileEnv` is the profile's env: it wins over the coordinator's own, as it does for the worker.
export async function ensureOpencodePlugin($: EngineInterface, profileEnv: Record<string, string> = {}) {
  try {
    const dir = profileEnv.OPENCODE_CONFIG_DIR || (await $.env.get('OPENCODE_CONFIG_DIR'))
    const xdg = profileEnv.XDG_CONFIG_HOME || (await $.env.get('XDG_CONFIG_HOME'))
    const base = dir || `${xdg || `${(await $.env.get('HOME')) ?? ''}/.config`}/opencode`
    const path = `${base}/plugins/hc-status.js`
    if ((await $.fs.exists(path)) && (await $.fs.read(path)) === OPENCODE_PLUGIN) return false
    await $.fs.write(path, OPENCODE_PLUGIN)
    return true
  } catch {
    return false
  }
}
