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

// What a test answers for one command the mod runs (process.run): its exit code and output, or a
// rejection (a command that cannot start).
export type Answer = { exitCode: number; stdout?: string; stderr?: string; reject?: string }

// herdr's state for the workers the tests name; a worker that starts without one is idle.
const STATUS: Record<string, string> = { 'w-busy': 'working', 'w-done': 'done', 'w-stuck': 'blocked' }

// The JSON herdr prints for a wait that ended with a status, and for a failed call.
const answer = (name: string, status: string) =>
  JSON.stringify({ result: { agent: { agent_status: status, name, pane_id: `p-${name}`, tab_id: `t-${name}` } } })
const failure = (code: string, message: string) => JSON.stringify({ error: { code, message } })

// A `herdr agent wait` the fake holds until its worker shows one of its `until` states, or
// until herdr would end it (end: its exit code and output).
type Wait = { name: string; until: string[]; end: (code: number, out: string) => void }

// Hooks that stand for the engine beneath the mod; returns the prompts the mod submitted
// to this session, the ones it typed into workers' tabs and the tabs it closed, and each
// worker's screen (by pane) and PR (by owner/name#123), which the test sets.
// `stored` is what $.store holds at the start, as an earlier load of the mod left it; `env` is
// merged over the session's environment (HOME, the herdr socket).
// The herdr fake: `calls` is every herdr argv the mod ran, `status` herdr's state per worker,
// and `emit`, `finish`, `kill` move a worker's wait (see below). `fail` makes the next
// calls fail, `gone` lists the workers herdr no longer knows.
export async function start(
  $: Engine,
  on: On,
  config: Settings = {},
  stored: Record<string, unknown> = {},
  env: Record<string, string> = {},
) {
  const submitted: string[] = []
  const typed: string[] = []
  const closed: string[] = []
  const screens: Record<string, string> = {}
  // What `gh pr view` reports for each PR, by owner/name#123; the test sets it.
  const prs: Record<string, unknown> = {}
  // How many more `agent prompt --wait` calls fail with agent_prompt_stalled, by worker; the test sets it.
  const stalls: Record<string, number> = {}
  // How many more prompts this session refuses (its `$.prompt.submit` throws); the test sets it.
  const refuse = { next: 0 }
  // Every herdr call the mod makes, in order: the CLI's process.run argv and the process.spawn ones.
  const calls: string[][] = []
  // The commands the mod runs that are not herdr's (git, install.sh, the bridge's file moves), joined by spaces, in order;
  // `runs` answers the ones a test names.
  const shell: string[] = []
  const runs = new Map<string, Answer[]>()
  // herdr's status for each worker it knows: the stored jobs' workers from the start, then each
  // `agent start`, then what emit sets.
  const status: Record<string, string> = {}
  // How many more `agent list`, `agent get` and `pane read` calls fail, by the next calls; the test sets them.
  const fail = { list: 0, get: 0, pane: 0 }
  const waits: Wait[] = []
  const end = (match: (w: Wait) => boolean, code: number, out: string) => {
    for (const w of waits.filter(match)) {
      waits.splice(waits.indexOf(w), 1)
      w.end(code, out)
    }
  }
  // The workers herdr no longer knows: adding one ends its pending waits as herdr would.
  class Gone extends Set<string> {
    add(name: string): this {
      super.add(name)
      end(w => w.name === name, 1, failure('agent_not_found', `no agent named ${name}`))
      return this
    }
  }
  const gone = new Gone()
  const clock = mock.clock(on, { now: 1_000_000 })
  // The workers the stored jobs name are herdr's already, listed at their status.
  for (const [key, value] of Object.entries(stored))
    if (key.startsWith('jobs:'))
      for (const name of Object.keys((value as { jobs?: object }).jobs ?? {})) status[name] = STATUS[name] ?? 'idle'
  // $.store, answered here rather than by mock.store, so the test can read what the mod kept in it.
  // Values go in and come out as JSON, as the engine keeps them.
  const store = new Map<string, unknown>(Object.entries(stored).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))
  on('store.get', (_, e) => ({ value: store.has(e.key) ? JSON.parse(JSON.stringify(store.get(e.key))) : undefined }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  // A turn the test starts or ends with $.turn: the plugin's hooks see it, and these answer it.
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  mock.env(on, { HOME: '/home/t', HERDR_SOCKET_PATH: '/tmp/herdr.sock', ...env })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  // The names the mod registered as slash commands, in order.
  const registered: string[] = []
  on('command.register', (_, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'session-1234' }))
  // The config names one short repo name; /repo and /srv are GitHub checkouts.
  const CONFIG = '/home/t/.claude/herdr-agents.json'
  const files: Record<string, string> = { [CONFIG]: JSON.stringify({ repos: { web: 'acme/website' }, ...config }) }
  // The clone install.sh recorded in the mod's folder (its `clone` file, read by /hrd-update); '' for none.
  const recorded = { clone: '/src/herdr' }
  // Calls held by gate(): each waits for its release function, then runs as usual.
  const gates: { match: (argv: string[]) => boolean; release: () => void; held: Promise<void>; used: boolean }[] = []
  const gate = (match: (argv: string[]) => boolean) => {
    let release = () => {}
    const held = new Promise<void>(resolve => (release = resolve))
    gates.push({ match, release, held, used: false })
    return release
  }
  // A folder exists while a file is in it.
  on('fs.exists', (_, e) => ({ value: e.path in files || Object.keys(files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.list', (_, e) => ({
    value: Object.keys(files)
      .filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path!.length + 1).includes('/'))
      .map(f => ({ name: f.slice(e.path!.length + 1), kind: 'file' as const, size: files[f]!.length, mtimeMs: 0, isLink: false })),
  }))
  // The mod's `clone` file is read from wherever the test loads the mod, so any path ending in /clone is it.
  on('fs.read', (_, e) => ({ value: e.path.endsWith('/clone') ? recorded.clone : (files[e.path] ?? '') }))
  on('fs.write', async (_, e) => {
    const hold = gates.find(g => !g.used && g.match(['fs.write', e.path]))
    if (hold) {
      hold.used = true
      await hold.held
    }
    files[e.path] = e.text
    return { value: undefined }
  })
  // The panes the mod opened, as the engine lists them.
  const panes: string[] = []
  on('ui.open', (_, e) => {
    if (!panes.includes(e.id)) panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    if (panes.includes(e.id)) panes.splice(panes.indexOf(e.id), 1)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: panes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true, plugin: 'herdr-agents' })),
  }))
  // The band's drawing when the mod passes: the engine's own.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('process.run', async (_, e) => {
    const hold = gates.find(g => !g.used && g.match([...e.argv]))
    if (hold) {
      hold.used = true
      await hold.held
    }
    const [cmd, sub, verb, name = ''] = e.argv
    if (cmd === 'herdr') calls.push([...e.argv])
    if (cmd !== 'herdr') shell.push(e.argv.join(' '))
    // The commands the test answers, in order: the last answer repeats.
    const told = runs.get(e.argv.join(' '))
    if (told) {
      const reply = told.length > 1 ? told.shift()! : told[0]!
      if (reply.reject) return { deny: reply.reject }
      return {
        value: {
          exitCode: reply.exitCode,
          stdout: reply.stdout ?? '',
          stderr: reply.stderr ?? '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    const exit = (exitCode: number, stdout = '') => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const ok = (result: unknown) => exit(0, JSON.stringify({ result }))
    // /repo and /srv are GitHub checkouts; a folder in one (/repo/wt) is a worktree of it.
    const remote: Record<string, string> = { '/repo': 'acme/app-client', '/srv': 'acme/app-server' }
    const dir = `${e.argv[2] ?? ''}/`
    const slug = cmd === 'git' && e.argv[3] === 'remote' ? Object.entries(remote).find(([d]) => dir.startsWith(`${d}/`))?.[1] : undefined
    if (slug) return exit(0, `origin\tgit@github.com:${slug}.git (fetch)\n`)
    if (cmd === 'gh' && sub === 'pr' && verb === 'view') {
      const pr = prs[`${e.argv[5]}#${name}`]
      return pr ? exit(0, JSON.stringify(pr)) : exit(1)
    }
    // The file moves and removals the bridge makes, on the files above.
    if (cmd === 'mkdir') return exit(0)
    const [from = '', to = ''] = e.argv.slice(2).filter(a => !a.startsWith('-'))
    if (cmd === 'mv' && from in files) {
      files[to] = files[from]!
      delete files[from]
      return exit(0)
    }
    if (cmd === 'rm') {
      for (const p of e.argv.slice(2).filter(a => !a.startsWith('-')))
        for (const f of Object.keys(files)) if (f === p || f.startsWith(`${p}/`)) delete files[f]
      return exit(0)
    }
    if (cmd !== 'herdr') return exit(1)
    if (sub === 'agent' && verb === 'prompt') {
      typed.push(e.argv[4] ?? '')
      if (stalls[name]) {
        stalls[name]--
        return exit(1, JSON.stringify({ error: { code: 'agent_prompt_stalled', message: 'no working state within 5000ms' } }))
      }
    }
    if (sub === 'agent' && verb === 'start') {
      status[name] = STATUS[name] ?? 'idle'
      gone.delete(name)
      return ok({})
    }
    if (sub === 'agent' && verb === 'list') {
      if (fail.list > 0) {
        fail.list--
        return exit(1, failure('server_not_running', 'herdr is not running'))
      }
      const agents = Object.keys(status)
        .filter(n => !gone.has(n) && !closed.includes(`t-${n}`))
        .map(n => ({ name: n, agent_status: status[n], pane_id: `p-${n}`, tab_id: `t-${n}` }))
      return ok({ agents })
    }
    if (sub === 'agent' && verb === 'get') {
      if (fail.get > 0) {
        fail.get--
        return exit(1, failure('server_not_running', 'herdr is not running'))
      }
      if (gone.has(name) || status[name] === undefined) return exit(1, failure('agent_not_found', `no agent named ${name}`))
      if (closed.includes(`t-${name}`)) return exit(1)
      return ok({ agent: { agent_status: status[name], pane_id: `p-${name}`, tab_id: `t-${name}` } })
    }
    if (sub === 'tab' && verb === 'close') {
      closed.push(name)
      end(w => `t-${w.name}` === name, 1, failure('agent_not_running', 'agent is no longer running in the target pane'))
    }
    if (sub === 'pane' && verb === 'read') {
      if (fail.pane > 0) {
        fail.pane--
        return exit(1, failure('server_not_running', 'herdr is not running'))
      }
      return exit(0, screens[name] ?? '')
    }
    if (sub === 'tab' && verb === 'create') return ok({ root_pane: { pane_id: 'p1' } })
    return ok({})
  })
  // `herdr agent wait` runs as a child process. Like herdr's wait, it answers at once when the worker
  // is already in one of its --until states; otherwise it is held until emit, kill, a closed tab or
  // gone ends it. Any other child exits 1.
  on('process.spawn', async function* (_, e) {
    calls.push([...e.argv])
    const [cmd, sub, verb, name = ''] = e.argv
    if (cmd !== 'herdr' || sub !== 'agent' || verb !== 'wait') return { value: { code: 1, signal: null } }
    const until = e.argv.flatMap((arg, i) => (arg === '--until' && e.argv[i + 1] !== undefined ? [e.argv[i + 1]!] : []))
    const now = status[name]
    if (now === undefined || gone.has(name)) {
      yield { stream: 'stdout', text: failure('agent_not_found', `no agent named ${name}`) }
      return { value: { code: 1, signal: null } }
    }
    if (until.includes(now)) {
      yield { stream: 'stdout', text: answer(name, now) }
      return { value: { code: 0, signal: null } }
    }
    const reply = await new Promise<{ code: number; out: string }>(resolve =>
      waits.push({ name, until, end: (code, out) => resolve({ code, out }) }),
    )
    yield { stream: 'stdout', text: reply.out }
    return { value: { code: reply.code, signal: null } }
  })
  on('prompt.submit', (_, e) => {
    if (refuse.next > 0) {
      refuse.next--
      throw new Error('the session refused the prompt')
    }
    submitted.push(e.text)
    return { text: e.text }
  })
  // A worker's status moves to `next`: the waits it ends answer with it, then the engine settles.
  const emit = async (name: string, next: string) => {
    status[name] = next
    end(w => w.name === name && w.until.includes(next), 0, answer(name, next))
    await clock.settle()
  }
  // The worker took a turn and ended it.
  const finish = async (name: string) => {
    await emit(name, 'working')
    await emit(name, 'done')
  }
  // The worker's tab is closed under its wait: the tab stays, the wait ends as herdr ends it.
  const kill = async (name: string) => {
    end(w => w.name === name, 1, failure('agent_not_running', 'agent is no longer running in the target pane'))
    await clock.settle()
  }
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return {
    clock,
    submitted,
    typed,
    closed,
    screens,
    files,
    prs,
    panes,
    stalls,
    refuse,
    store,
    calls,
    shell,
    runs,
    recorded,
    registered,
    status,
    fail,
    gone,
    gate,
    emit,
    finish,
    kill,
  }
}

// A row is one Text per column; its name is padded.
export const row = (ui: Mounted<'terminal', 'AbovePrompt'>, name: string) => ui.find({ type: 'Text', text: new RegExp(`^${name} +$`) })

export async function spawn($: Engine, names: string[], cwd?: string) {
  for (const worker of names)
    await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker, profile: 'reviewer', cwd: cwd ?? `/repo-${worker}`, task: 'x' })
}
// Settles until `done` holds, up to 200 times. Work the mod leaves running unawaited (a refresh
// learning a repo's remote, the sidebar's PR poll) waits on a process.run answer that can land
// after clock.settle() returns on a busy machine; the test's expect then checks it.
export async function until(clock: MockClock, done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200 && !(await done()); i++) await clock.settle()
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
