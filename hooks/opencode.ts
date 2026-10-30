import type { EngineInterface } from 'claude-code'

// The opencode plugin that reports a worker's status to hc. opencode loads every file in its plugins folder;
// this one is written for workers of kind `opencode` (see ensureOpencodePlugin). It is active only inside an
// hc terminal (HC_TERMINAL_ID set) and writes hc's status record (OSC 7501) to the controlling terminal.
// Like Herdr's own opencode plugin it ignores the events of child sessions (subagents), except a question or
// permission they ask, which blocks the worker. HC_STATUS_TTY replaces /dev/tty (for tests).
// The plugin's logic is this function; the file written for opencode is its source text (it stands alone, with no
// types), so tests call it directly. `fs` and `env` are node:fs and process.env.
export function hcStatusPlugin(fs: any, env: any) {
  const STATES = new Map([
    ['permission.asked', 'blocked:kind=permission'],
    ['question.asked', 'blocked:kind=question'],
    ['permission.replied', 'working'],
    ['question.replied', 'working'],
    ['question.rejected', 'working'],
    ['session.compacted', 'working'],
    ['tool.execute.before', 'working'],
    ['tool.execute.after', 'working'],
    ['session.error', 'error'],
    ['session.idle', 'idle'],
  ])
  const CHILD_STATES = new Set(['permission.asked', 'question.asked', 'permission.replied', 'question.replied', 'question.rejected'])
  const WORKING = new Set(['active', 'busy', 'pending', 'retry', 'running', 'streaming', 'working'])

  const stateOf = (type: any, properties: any) => {
    if (type === 'session.status') {
      const s = properties?.status
      const kind = String((typeof s === 'string' ? s : s?.type) ?? '').toLowerCase()
      return WORKING.has(kind) ? 'working' : kind === 'idle' ? 'idle' : undefined
    }
    return STATES.get(type)
  }

  return async () => {
    if (!env.HC_TERMINAL_ID) return {}
    const tty = env.HC_STATUS_TTY || '/dev/tty'
    const report = (state: any) => {
      try {
        fs.appendFileSync(tty, '\x1b]7501;state=' + state + ':app=opencode\x1b\\')
      } catch (e) {}
    }
    const children = new Set()
    // After an error the worker stays `error` (idle reports are ignored) until the next sign of work.
    let failed = false
    const send = (state: any) => {
      if (state === 'idle' && failed) return
      if (state !== 'idle') failed = state === 'error'
      report(state)
    }
    report('idle')
    return {
      'chat.message': async ({ sessionID }: any) => {
        if (!sessionID || !children.has(sessionID)) send('working')
      },
      'tool.execute.before': async ({ sessionID }: any = {}) => {
        if (!sessionID || !children.has(sessionID)) send('working')
      },
      'tool.execute.after': async ({ sessionID }: any = {}) => {
        if (!sessionID || !children.has(sessionID)) send('working')
      },
      event: async ({ event }: any) => {
        const type = event?.type
        const properties = event?.properties ?? {}
        const info = properties.info
        if (info?.id && info.parentID) children.add(info.id)
        const state = stateOf(type, properties)
        if (!state) return
        const id = typeof properties.sessionID === 'string' ? properties.sessionID : undefined
        if (id && children.has(id) && !CHILD_STATES.has(type)) return
        send(state)
      },
    }
  }
}

export const OPENCODE_PLUGIN = `// installed by herdr-agents; rewritten when it differs, so do not edit it.
import fs from "node:fs";

${hcStatusPlugin.toString()}

export const HcStatusPlugin = hcStatusPlugin(fs, process.env);

export default { id: "hc.status", server: HcStatusPlugin };
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
