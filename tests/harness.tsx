import { mock } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'
import type { Settings } from '../types'

// What the tests share: the band's render props, and start(), which stands in for the
// engine beneath the mod (hc, git, the file system) and starts a session in /repo.

export const BAND = {
  plugin: 'herdr-agents',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 140, scroll: { offset: 0, bodyRows: 29 }, view: {} },
} as const

// What the engine's tool registrations wait for, if a test sets it before start(): a real one waits 8 s for its tool.
export const registering: { until?: Promise<void> } = {}

// The clock of the session start() began last: tests run one at a time.
let latest: MockClock | undefined
// Lets the background start of the workers just spawned finish.
export const settled = () => latest!.settle()

// What a test answers for one command the mod runs (process.run): its exit code and output, or a
// rejection (a command that cannot start).
export type Answer = { exitCode: number; stdout?: string; stderr?: string; reject?: string }

// hc's status for the workers the tests name; a worker that starts without one is idle. A CLI boots
// idle and takes this status with the first prompt it is sent; the stored jobs' workers have it from the start.
const STATUS: Record<string, string> = { 'w-busy': 'working', 'w-done': 'done', 'w-stuck': 'blocked' }

// The exit code hc gives each kind of error (hc's manual); any other kind exits 1.
const EXIT: Record<string, number> = { not_found: 3, blocked: 9, status_mismatch: 10, finished: 11, invalid_params: 6 }

// A terminal the fake hc knows: the ones `hc run` started, the stored jobs' workers, and what a test adds.
type Term = {
  name: string
  address: string
  cwd: string
  labels: Record<string, string>
  argv: string[]
  finished: boolean
  removed: boolean
}

// An `hc events` child the fake holds open: the lines it still has to yield, and the wake-up of its reader.
type Stream = { name: string; queue: string[]; wake?: () => void }

// Splits the arguments of an hc call into positionals, flags (repeated ones keep every value) and what follows `--`.
const VALUED = new Set(['--name', '--cwd', '--label', '--timeout', '--lines', '--parent', '--terminal'])
function parseArgs(args: string[]) {
  const dash = args.indexOf('--')
  const head = dash >= 0 ? args.slice(0, dash) : args
  const pos: string[] = []
  const flags: Record<string, string[]> = {}
  for (let i = 0; i < head.length; i++) {
    const a = head[i]!
    if (!a.startsWith('--')) pos.push(a)
    else (flags[a] ??= []).push(VALUED.has(a) ? (head[++i] ?? '') : '')
  }
  return { pos, flags, rest: dash >= 0 ? args.slice(dash + 1) : [] }
}

// Hooks that stand for the engine beneath the mod; returns the prompts the mod submitted
// to this session, the ones it typed into workers' terminals and the terminals it killed, and each
// worker's screen (by name) and PR (by owner/name#123), which the test sets.
// `stored` is what $.store holds at the start, as an earlier load of the mod left it; `env` is
// merged over the session's environment (HOME, the coordinator's hc terminal).
// The hc fake: `calls` is every hc argv the mod ran, `status` hc's status per worker,
// and `emit`, `kill` and `gone` move a worker's events stream (see below). `fail` makes the next
// calls fail, `gone` lists the workers hc no longer knows.
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
  const removed: string[] = []
  const screens: Record<string, string> = {}
  // What `gh pr view` reports for each PR, by owner/name#123; the test sets it.
  const prs: Record<string, unknown> = {}
  // How many more `hc send` calls report started: false, by worker; the test sets it.
  const stalls: Record<string, number> = {}
  // Workers whose CLI sits on what it is sent, as Claude does until its session.start hooks are done: hc says idle
  // and started: false, the screen shows a paste placeholder, and each copy runs in turn once the test lets the turn start.
  const holds = new Set<string>()
  // The turn count hc reports per worker.
  const turns: Record<string, number> = {}
  // How many more prompts this session refuses (its `$.prompt.submit` throws); the test sets it.
  const refuse = { next: 0 }
  // Every hc call the mod makes, in order: the CLI's process.run argv (with the --json the wrapper adds)
  // and the process.spawn ones; `hcEnvs` is the env each of them carried.
  const calls: string[][] = []
  const hcEnvs: (Record<string, string> | undefined)[] = []
  // Any call to the old `herdr` CLI: the mod makes none, and the fake answers it with exit 127.
  const herdrCalls: string[][] = []
  // The commands the mod runs that are not hc's (git, herdr-app, install.sh, the bridge's file moves), joined by spaces, in order;
  // `runs` answers the ones a test names.
  const shell: string[] = []
  const runs = new Map<string, Answer[]>()
  // What was typed into workers and with which keys, in order: `hc send` (text, force) and `hc keys`.
  const sends: { name: string; text: string; force: boolean }[] = []
  const keyed: string[][] = []
  // hc's status for each worker it knows: the stored jobs' workers from the start, then each
  // `hc run`, then what emit sets.
  const status: Record<string, string> = {}
  // Workers whose program reports no status (hc get says null, hc ls leaves it out, hc send says started: null).
  const noStatus = new Set<string>()
  // What a blocked worker waits for (permission, question, auth), by worker; hc get reports it as the status's kind.
  const blockedKind: Record<string, string> = {}
  // The replies of the next `hc wait` calls for a worker (merged over the default one), in order: how a CLI boots.
  const waitReplies: Record<string, Record<string, unknown>[]> = {}
  // How many more `hc rm` calls for a worker fail with `live` after its kill (a program slow to die).
  const stubborn: Record<string, number> = {}
  // The status a worker takes once keys are sent to it (the Enter that submits a prompt left in its input box), by worker.
  const onKeys: Record<string, string> = {}
  // The coordinator's own terminal (HC_TERMINAL_ID): its labels place the workers' tabs; clear them for a coordinator outside a space.
  const self = { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' } as Record<string, string> }
  // How many more `hc ls`, `hc get`, `hc read`, `hc run` and `herdr-app do tab.rename` calls fail; the test sets them.
  const fail = { list: 0, get: 0, pane: 0, start: 0, rename: 0 }
  // Whether the events streams yield each line in two pieces (a piece is not a line).
  const pieces = { split: false }
  const terms = new Map<string, Term>()
  // The workers that have been sent their first prompt.
  const prompted = new Set<string>()
  let addresses = 10
  const addTerm = (name: string, cwd: string, labels: Record<string, string>, argv: string[] = []) => {
    terms.set(name, { name, address: `t${++addresses}`, cwd, labels, argv, finished: false, removed: false })
    return terms.get(name)!
  }
  const streams: Stream[] = []
  const push = (name: string, msg: unknown) => {
    for (const s of streams.filter(x => x.name === name)) {
      s.queue.push(`${JSON.stringify(msg)}\n`)
      s.wake?.()
    }
  }
  const event = (name: string, type: string, data: unknown = {}) =>
    push(name, { method: 'event', params: { type, terminal: name, seq: 1, data } })
  // The workers hc no longer knows: adding one ends its streams' terminal as hc does (a finished event).
  class Gone extends Set<string> {
    add(name: string): this {
      super.add(name)
      event(name, 'finished')
      return this
    }
  }
  const gone = new Gone()
  const find = (ref: string) => [...terms.values()].find(t => t.name === ref || t.address === ref)
  // The terminal a ref names, unless hc no longer knows it.
  const known = (ref: string) => {
    const t = find(ref)
    return t && !t.removed && !gone.has(t.name) ? t : undefined
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  latest = clock
  // The workers the stored jobs name are hc's already, listed at their status.
  for (const [key, value] of Object.entries(stored))
    if (key.startsWith('jobs:'))
      for (const [name, job] of Object.entries((value as { jobs?: Record<string, { cwd: string }> }).jobs ?? {})) {
        status[name] = STATUS[name] ?? 'idle'
        addTerm(name, job.cwd, { 'herdr-agents.role': 'worker' })
      }
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
  mock.env(on, { HOME: '/home/t', HC_TERMINAL_ID: 't1', HC_TERMINAL_SOCKET: '/tmp/hc.sock', SHELL: '/bin/zsh', ...env })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The spec of each tool the mod registered, and how often.
  const tools: Record<string, { description: string }> = {}
  const toolCalls: string[] = []
  on('tool.register', async (_, e) => {
    await registering.until
    tools[e.name] = e
    toolCalls.push(e.name)
    return { value: { tool: e.name } }
  })
  // The names the mod registered as slash commands, in order.
  const registered: string[] = []
  on('command.register', (_, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  // The toasts the mod showed, as JSON.
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-1234' }))
  // The config names one short repo name; /repo and /srv are GitHub checkouts.
  const CONFIG = '/home/t/.claude/herdr-agents.json'
  const files: Record<string, string> = { [CONFIG]: JSON.stringify({ repos: { web: 'acme/website' }, ...config }) }
  // The clone install.sh recorded in the mod's folder (its `clone` file, read by /hrd-update); '' for none.
  const recorded = { clone: '/src/herdr', modPlugin: '' }
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
  // Likewise the mod's own .claude-plugin/plugin.json (read for the band's version): recorded.modPlugin, unless the test put a file there.
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('/clone')
      ? recorded.clone
      : (files[e.path] ?? (e.path.endsWith('/.claude-plugin/plugin.json') ? recorded.modPlugin : '')),
  }))
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
  // What hc prints for a terminal, as `hc get` and the events snapshot show it.
  const terminal = (t: Term) => {
    const word = status[t.name]
    return {
      address: t.address,
      name: t.name,
      cwd: t.cwd,
      state: t.finished ? 'finished' : 'live',
      turn: turns[t.name] ?? 0,
      status:
        !word || noStatus.has(t.name) || t.finished
          ? null
          : { state: word, ...(blockedKind[t.name] && word === 'blocked' ? { kind: blockedKind[t.name] } : {}) },
      labels: t.labels,
      keep: false,
      reported: true,
      foreground: null,
    }
  }
  on('process.run', async (_, e) => {
    const hold = gates.find(g => !g.used && g.match([...e.argv]))
    if (hold) {
      hold.used = true
      await hold.held
    }
    const [cmd, sub, verb, name = ''] = e.argv
    if (cmd === 'hc') {
      calls.push([...e.argv])
      hcEnvs.push(e.init?.env)
    } else if (cmd === 'herdr') herdrCalls.push([...e.argv])
    else shell.push(e.argv.join(' '))
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
    const exit = (exitCode: number, stdout = '', stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    // hc prints errors on stderr as {error:{kind,message,hint}} and exits by kind.
    const err = (kind: string, message: string) => exit(EXIT[kind] ?? 1, '', JSON.stringify({ error: { kind, message, hint: '' } }))
    if (cmd === 'herdr') return exit(127, '', 'herdr: command not found')
    if (cmd === 'herdr-app') {
      if (fail.rename > 0) {
        fail.rename--
        return exit(1)
      }
      return exit(0, '{}')
    }
    if (cmd === 'hc') {
      // --json counts only before a `--`: after it, it is the worker's own argument.
      const dash = e.argv.indexOf('--')
      const own = dash >= 0 ? e.argv.slice(0, dash) : e.argv
      const json = own.includes('--json')
      const { pos, flags, rest } = parseArgs([...own.slice(2).filter(a => a !== '--json'), ...(dash >= 0 ? e.argv.slice(dash) : [])])
      const ref = pos[0] ?? ''
      const t = known(ref)
      const unreachable = () => err('unavailable', 'hc cannot reach its core')
      // Without --json hc prints text, which the mod cannot parse.
      const ok = (result: unknown) => exit(0, json ? JSON.stringify(result) : 'ok')
      const missing = () => err('not_found', `no terminal ${ref}`)
      if (sub === 'run') {
        if (fail.start > 0) {
          fail.start--
          return err('spawn_failed', 'the program would not start')
        }
        const wanted = flags['--name']?.[0] ?? ''
        const taken = known(wanted)
        if (taken && !taken.finished) return err('name_taken', `${wanted} is taken`)
        const labels = Object.fromEntries((flags['--label'] ?? []).map(l => [l.split('=')[0]!, l.slice(l.indexOf('=') + 1)]))
        const made = addTerm(wanted, flags['--cwd']?.[0] ?? '', labels, rest)
        status[wanted] = 'idle'
        gone.delete(wanted)
        return ok({ address: made.address, agent: rest.at(-1), cwd: made.cwd, name: wanted, state: 'live', turn: 0 })
      }
      if (sub === 'ls') {
        if (fail.list > 0) {
          fail.list--
          return unreachable()
        }
        const wanted = (flags['--label'] ?? []).map(l => [l.split('=')[0]!, l.slice(l.indexOf('=') + 1)] as const)
        const terminals = [...terms.values()]
          .filter(x => !x.removed && !gone.has(x.name) && ('--all' in flags || !x.finished) && wanted.every(([k, v]) => x.labels[k] === v))
          .map(x => ({
            address: x.address,
            name: x.name,
            cwd: x.cwd,
            state: x.finished ? 'finished' : 'live',
            ...(status[x.name] && !noStatus.has(x.name) && !x.finished ? { status: status[x.name] } : {}),
            turn: 0,
          }))
        return ok({ terminals, hidden_finished: 0, machines: [] })
      }
      if (sub === 'get') {
        if (fail.get > 0) {
          fail.get--
          return unreachable()
        }
        // The coordinator's own terminal is not one of the workers.
        if (ref === 't1') return ok({ address: 't1', name: null, state: 'live', status: null, labels: self.labels })
        return t ? ok(terminal(t)) : missing()
      }
      if (sub === 'read') {
        if (fail.pane > 0) {
          fail.pane--
          return unreachable()
        }
        return t ? ok({ text: screens[t.name] ?? '', complete: true, how: 'screen' }) : missing()
      }
      if (sub === 'wait') {
        if (!t) return missing()
        const reply = waitReplies[t.name]?.shift()
        const word = noStatus.has(t.name) ? null : (status[t.name] ?? null)
        // A word the worker is in answers at once (hc wait without --until); working or no word is a timeout.
        const settled = word === 'idle' || word === 'done' || word === 'blocked' || word === 'error'
        const base = t.finished
          ? { ended: true, reason: 'exit', status: null, exit_code: 0 }
          : { ended: settled, reason: settled ? 'status' : 'timeout', status: word }
        return ok({ signal: null, exit_code: null, terminal: t.address, turn: 0, children: [], ...base, ...reply })
      }
      if (sub === 'send') {
        if (!t) return missing()
        if (t.finished) return err('finished', `${t.name} has finished`)
        const force = '--force' in flags
        if (status[t.name] === 'blocked' && !force && !noStatus.has(t.name)) return err('blocked', `${t.name} waits at a prompt`)
        const text = pos[1] ?? ''
        typed.push(text)
        if (!prompted.has(t.name)) {
          prompted.add(t.name)
          status[t.name] = STATUS[t.name] ?? status[t.name]!
        }
        sends.push({ name: t.name, text, force })
        if (holds.has(t.name)) {
          screens[t.name] = '❯ [Pasted text #1]\n✻ Shimmying… (4s)\n❯'
          status[t.name] = 'idle'
          return ok({ started: false, status: 'idle', turn: turns[t.name] ?? 0 })
        }
        const word = noStatus.has(t.name) ? null : (status[t.name] ?? null)
        if (stalls[t.name]) {
          stalls[t.name]! -= 1
          return ok({ started: false, status: word, turn: 0 })
        }
        return ok({ started: word === null ? null : true, status: word, turn: 0 })
      }
      if (sub === 'keys') {
        if (!t) return missing()
        keyed.push([t.name, ...pos.slice(1)])
        // The prompt the keys answer is gone from the screen.
        screens[t.name] = ''
        if (onKeys[t.name]) status[t.name] = onKeys[t.name]!
        return ok({ status: status[t.name] ?? null, turn: 0 })
      }
      if (sub === 'kill') {
        if (!t) return missing()
        if (!t.finished) {
          t.finished = true
          closed.push(t.name)
          event(t.name, 'finished')
        }
        return ok(terminal(t))
      }
      if (sub === 'rm') {
        if (!t) return missing()
        if (!t.finished) return err('live', `${t.name} is still running`)
        if (stubborn[t.name]) {
          stubborn[t.name]! -= 1
          return err('live', `${t.name} is still running`)
        }
        t.removed = true
        removed.push(t.name)
        event(t.name, 'removed')
        return ok({ removed: t.address })
      }
      return ok({})
    }
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
    return exit(1)
  })
  // `hc events --terminal <name>` runs as a child process. Like hc's, it prints a snapshot line first, then one
  // JSON-RPC line per change (emit, kill, gone), and never ends by itself: the mod leaves the loop. An unknown
  // terminal is a not_found error on stderr with nothing on stdout. Any other child exits 1.
  on('process.spawn', async function* (_, e) {
    calls.push([...e.argv])
    hcEnvs.push(e.env)
    const [cmd, sub] = e.argv
    if (cmd !== 'hc' || sub !== 'events') return { value: { code: 1, signal: null } }
    const name = e.argv[e.argv.indexOf('--terminal') + 1] ?? ''
    const t = known(name)
    if (!t) {
      yield { stream: 'stderr', text: JSON.stringify({ error: { kind: 'not_found', message: `no terminal ${name}`, hint: '' } }) }
      return { value: { code: 3, signal: null } }
    }
    const stream: Stream = { name, queue: [`${JSON.stringify({ channel: 1, seq: 0, terminals: [terminal(t)] })}\n`] }
    streams.push(stream)
    try {
      for (;;) {
        while (stream.queue.length === 0) await new Promise<void>(resolve => (stream.wake = resolve))
        const line = stream.queue.shift()!
        if (pieces.split) {
          yield { stream: 'stdout', text: line.slice(0, 10) }
          yield { stream: 'stdout', text: line.slice(10) }
        } else yield { stream: 'stdout', text: line }
      }
    } finally {
      streams.splice(streams.indexOf(stream), 1)
    }
  })
  on('prompt.submit', (_, e) => {
    if (refuse.next > 0) {
      refuse.next--
      throw new Error('the session refused the prompt')
    }
    submitted.push(e.text)
    return { text: e.text }
  })
  // A worker's status moves to `next`: its events stream says so, then the engine settles.
  const emit = async (name: string, next: string) => {
    status[name] = next
    event(name, 'status', { status: { state: next }, records: {}, reported: true })
    await clock.settle()
  }
  // The worker took a turn and ended it.
  const finish = async (name: string) => {
    await emit(name, 'working')
    await emit(name, 'done')
  }
  // The worker's terminal finishes under its events stream: the stream says so and the mod leaves it.
  const kill = async (name: string) => {
    event(name, 'finished')
    await clock.settle()
  }
  // hc's keepalive on a worker's events stream.
  const heartbeat = async (name: string) => {
    push(name, { method: 'heartbeat' })
    await clock.settle()
  }
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return {
    clock,
    submitted,
    typed,
    closed,
    removed,
    screens,
    files,
    prs,
    panes,
    stalls,
    holds,
    turns,
    refuse,
    store,
    calls,
    hcEnvs,
    herdrCalls,
    shell,
    runs,
    sends,
    keyed,
    recorded,
    registered,
    toasts,
    tools,
    toolCalls,
    status,
    noStatus,
    blockedKind,
    onKeys,
    waitReplies,
    stubborn,
    self,
    fail,
    pieces,
    terms,
    addTerm,
    streams,
    gone,
    gate,
    emit,
    finish,
    kill,
    heartbeat,
  }
}

// A row is one Text per column; its name is padded.
export const row = (ui: Mounted<'terminal', 'AbovePrompt'>, name: string) => ui.find({ type: 'Text', text: new RegExp(`^${name} +$`) })

// Spawn returns at once; `clock.settle()` then lets each worker's background start finish.
export async function spawn($: Engine, names: string[], cwd?: string, clock: MockClock = latest!) {
  for (const worker of names) {
    await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker, profile: 'reviewer', cwd: cwd ?? `/repo-${worker}`, task: 'x' })
    await clock.settle()
  }
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
