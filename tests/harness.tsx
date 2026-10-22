import { mock } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'
import type { Settings } from '../types'

// What the tests share: the band's render props, and start(), which stands in for the
// engine beneath the mod (herdr, git, the file system) and starts a session in /repo.

export const BAND = {
  plugin: 'herdr-agents',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 140, scroll: { offset: 0, bodyRows: 29 }, view: {} },
} as const

// herdr's state for the workers the tests name; any other worker is idle.
const STATUS: Record<string, string> = { 'w-busy': 'working', 'w-done': 'done', 'w-stuck': 'blocked' }

// Hooks that stand for the engine beneath the mod; returns the prompts the mod submitted
// to this session and the ones it typed into workers' tabs.
export async function start($: Engine, on: On, config: Settings = {}) {
  const submitted: string[] = []
  const typed: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/t', HERDR_SOCKET_PATH: '/tmp/herdr.sock' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'session-1234' }))
  // The config names one short repo name; /repo and /srv are GitHub checkouts.
  const CONFIG = '/home/t/.claude/herdr-agents.json'
  const files: Record<string, string> = { [CONFIG]: JSON.stringify({ repos: { web: 'acme/website' }, ...config }) }
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // The band's drawing when the mod passes: the engine's own.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('process.run', (_, e) => {
    const [cmd, sub, verb, name = ''] = e.argv
    const exit = (exitCode: number, stdout = '') => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const ok = (result: unknown) => exit(0, JSON.stringify({ result }))
    // /repo and /srv are GitHub checkouts.
    const remote: Record<string, string> = { '/repo': 'acme/app-client', '/srv': 'acme/app-server' }
    const slug = cmd === 'git' && e.argv[3] === 'remote' ? remote[e.argv[2] ?? ''] : undefined
    if (slug) return exit(0, `origin\tgit@github.com:${slug}.git (fetch)\n`)
    if (cmd !== 'herdr') return exit(1)
    if (sub === 'agent' && verb === 'prompt') typed.push(e.argv[4] ?? '')
    if (sub === 'agent' && verb === 'get') return ok({ agent: { agent_status: STATUS[name] ?? 'idle', pane_id: 'p1' } })
    if (sub === 'tab' && verb === 'create') return ok({ root_pane: { pane_id: 'p1' } })
    return ok({})
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return { clock, submitted, typed, files }
}

// A row is one Text per column; its name is padded.
export const row = (ui: Mounted<'terminal', 'AbovePrompt'>, name: string) => ui.find({ type: 'Text', text: new RegExp(`^${name} +$`) })

export async function spawn($: Engine, names: string[], cwd?: string) {
  for (const worker of names)
    await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker, profile: 'reviewer', cwd: cwd ?? `/repo-${worker}`, task: 'x' })
}
// Their watch loops end before the test does.
export async function stopAll($: Engine, clock: MockClock, names: string[]) {
  for (const worker of names) await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker })
  await clock.advance(10_000)
}

// Runs one of the mod's commands as the person typing it; the engine stamps where the
// run came from and how it is shown, so the test leaves those out.
export async function command($: Engine, name: string, args = '') {
  return $.command.run({ command: name, args } as CommandRunInput)
}
