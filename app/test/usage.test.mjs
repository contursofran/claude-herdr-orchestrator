import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { app, textOf } from './fake-gpui.mjs'

const u = await import('../mods/herdr-agents/usage.js')

// Trimmed from what each service really answers.
const CLAUDE = {
  five_hour: null,
  seven_day: { utilization: 95.0, resets_at: '2026-11-02T17:00:00.632702+00:00' },
  limits: [{ kind: 'weekly_all', group: 'weekly', percent: 95, resets_at: '2026-11-02T17:00:00.632702+00:00', scope: null }],
}
const CODEX = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 12.4, limit_window_seconds: 18000, reset_at: 1793594948 },
    secondary_window: { used_percent: 68, limit_window_seconds: 604800, reset_at: 1793800835 },
  },
}
const answer = (body, status = 200) => ({ code: 0, stdout: `${JSON.stringify(body)}\nHTTP ${status}\n`, stderr: '' })
const isCodex = args => args[1].includes('wham/usage')

test('Claude: a window it does not report stays empty, and microseconds in a reset time are fine', () => {
  assert.deepEqual(u.parseClaude(CLAUDE), { session: null, weekly: { pct: 95, resets: Date.UTC(2026, 10, 2, 17, 0, 0, 632) } })
})

test('Claude: the limits list wins, and the fixed fields stand in without it', () => {
  const limits = [
    { kind: 'session', percent: 40 },
    { kind: 'weekly_scoped', percent: 99 },
  ]
  assert.equal(u.parseClaude({ limits, five_hour: { utilization: 1 } }).session.pct, 40)
  assert.equal(u.parseClaude({ five_hour: { utilization: 7.6 } }).session.pct, 8)
  assert.equal(u.parseClaude({}), null)
  assert.equal(u.parseClaude(null), null)
})

test('Codex: windows are known by length, in either slot; the slot decides only without a length', () => {
  assert.deepEqual(u.parseCodex(CODEX), {
    session: { pct: 12, resets: 1793594948000 },
    weekly: { pct: 68, resets: 1793800835000 },
  })
  const { primary_window: five, secondary_window: week } = CODEX.rate_limit
  assert.equal(u.parseCodex({ rate_limit: { primary_window: week, secondary_window: five } }).session.pct, 12)
  assert.equal(u.parseCodex({ rate_limit: { primary_window: { used_percent: 3 } } }).session.pct, 3)
  // A plan with only a weekly limit has it in the first slot: not a 5-hour figure.
  assert.deepEqual(u.parseCodex({ rate_limit: { primary_window: week } }), { session: null, weekly: { pct: 68, resets: 1793800835000 } })
  assert.equal(u.parseCodex({}), null)
})

test('percents stay in 0..100', () => {
  assert.equal(u.parseClaude({ five_hour: { utilization: 140 } }).session.pct, 100)
  assert.equal(u.parseClaude({ five_hour: { utilization: -3 } }).session.pct, 0)
})

test('an answer needs its status line', () => {
  assert.deepEqual(u.splitAnswer('{"a":1}\nHTTP 200\n'), { status: 200, body: '{"a":1}' })
  assert.deepEqual(u.splitAnswer('\nHTTP 429\n'), { status: 429, body: '' })
  for (const bad of ['', null, undefined, '{"a":1}', 'HTTP 200']) assert.equal(u.splitAnswer(bad), null, String(bad))
})

test('a poll reads both and reports each change once', async () => {
  const exec = async (_cmd, args) => answer(isCodex(args) ? CODEX : CLAUDE)
  const tracker = new u.UsageTracker(exec, () => 1000)
  let changes = 0
  await tracker.poll(() => changes++)
  assert.equal(changes, 2)
  assert.equal(tracker.readings.claude.weekly.pct, 95)
  assert.equal(tracker.readings.codex.session.pct, 12)
  assert.equal(tracker.readings.codex.at, 1000)
})

test('a failed read keeps the last figures with their time', async () => {
  let reply = answer(CLAUDE)
  const tracker = new u.UsageTracker(
    async () => reply,
    () => 1000,
  )
  await tracker.read({ id: 'claude', script: '', parse: u.parseClaude })
  for (const bad of [answer({}, 500), { code: 7, stdout: '' }, answer({}), { code: 0, stdout: 'not json\nHTTP 200\n' }]) {
    reply = bad
    assert.equal(await tracker.read({ id: 'claude', script: '', parse: u.parseClaude }), false)
    assert.equal(tracker.readings.claude.weekly.pct, 95)
  }
  const failing = new u.UsageTracker(async () => {
    throw new Error('gone')
  })
  assert.equal(await failing.read({ id: 'claude', script: '', parse: u.parseClaude }), false)
})

test('no sign-in: the provider goes, and comes back with one', async () => {
  let reply = answer(CLAUDE)
  const provider = { id: 'claude', script: '', parse: u.parseClaude }
  const tracker = new u.UsageTracker(async () => reply)
  await tracker.read(provider)
  reply = { code: 3, stdout: '' }
  assert.equal(await tracker.read(provider), true)
  assert.equal(tracker.readings.claude, undefined)
  assert.equal(await tracker.read(provider), false)
})

test('a refusal leaves the provider alone for a while, then it is asked again', async () => {
  for (const status of [401, 403, 429]) {
    let time = 0
    let asked = 0
    const exec = async () => {
      asked++
      return answer({}, status)
    }
    const tracker = new u.UsageTracker(exec, () => time)
    const provider = { id: 'codex', script: '', parse: u.parseCodex }
    await tracker.read(provider)
    time = u.REFUSED_MS - 1
    await tracker.read(provider)
    assert.equal(asked, 1, String(status))
    time = u.REFUSED_MS
    await tracker.read(provider)
    assert.equal(asked, 2, String(status))
  }
})

test('the view shows both windows, a dash for an unreported one, and 0 past a reset', () => {
  app.theme = { ...app.theme, chrome: '#101010', border: '#202020', dim: '#303030', foreground: '#404040', blocked: '#505050' }
  const tracker = new u.UsageTracker(async () => null)
  const at = Date.UTC(2026, 10, 2, 12)
  tracker.readings = {
    claude: { session: null, weekly: { pct: 95, resets: at + 3600000 }, at },
    codex: { session: { pct: 40, resets: at - 1 }, weekly: { pct: 75, resets: at + 3600000 }, at },
  }
  const view = u.usageView(tracker, at)
  assert.deepEqual(textOf(view), ['5h –', '7d 95%', '5h 0%', '7d 75%'])
  assert.deepEqual(
    view.node.kids.map(row => row.node.kids[0].node.init),
    [['icons/claude.svg'], ['icons/codex.svg']],
  )
  tracker.readings = {}
  assert.deepEqual(textOf(u.usageView(tracker, at)), [])
})

test('a limit gets louder as it fills', () => {
  app.theme = { ...app.theme, chrome: '#101010', border: '#202020', dim: '#303030', foreground: '#404040', blocked: '#505050' }
  const colour = pct => {
    const tracker = new u.UsageTracker(async () => null)
    tracker.readings = { codex: { session: null, weekly: { pct, resets: null }, at: 0 } }
    const row = u.usageView(tracker, 0).node.kids[0]
    return row.node.kids.at(-1).node.calls.text_color[0]
  }
  assert.deepEqual([colour(69), colour(70), colour(89), colour(90)], ['#303030', '#404040', '#404040', '#505050'])
})

test('the hover text says when each window resets and when this was read', () => {
  const now = new Date(2026, 10, 2, 12, 0).getTime()
  const today = new Date(2026, 10, 2, 14, 2).getTime()
  const later = new Date(2026, 10, 6, 9, 5).getTime() // a Friday
  assert.equal(
    u.usageTip('Codex', { session: { pct: 3, resets: today }, weekly: { pct: 68, resets: later }, at: now }, now),
    'Codex: 5h 3%, resets 14:02 · 7d 68%, resets Fri 09:05. Read at 12:00.',
  )
  assert.equal(u.usageTip('Claude', { session: null, weekly: { pct: 95, resets: null }, at: now }, now), 'Claude: 7d 95%. Read at 12:00.')
})

// The scripts really run, with `security` and `curl` replaced: what reaches curl, and that a token never reaches its arguments.
function fakeBin(t, { keychain = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const write = (name, text) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${text}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  write('uname', 'echo Darwin')
  write('security', keychain ? `printf '%s' '${keychain}'` : 'exit 44')
  write('curl', `echo "ARGS $*"; echo "STDIN"; cat; printf '{}\\nHTTP 200\\n'`)
  return { dir, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, USER: 'me' } }
}
const run = (script, env) => spawnSync('sh', ['-c', script], { env, encoding: 'utf8' })

test('Claude script: the keychain token goes to curl on stdin only', t => {
  const { env } = fakeBin(t, { keychain: '{"claudeAiOauth":{"accessToken":"sk-secret","subscriptionType":"max"}}' })
  const r = run(u.CLAUDE_SCRIPT, env)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /STDIN\nheader = "Authorization: Bearer sk-secret"\n/)
  assert.match(r.stdout.split('STDIN')[0], /https:\/\/api\.anthropic\.com\/api\/oauth\/usage/)
  assert.doesNotMatch(r.stdout.split('STDIN')[0], /sk-secret/)
})

test('Claude script: the credentials file stands in; with no sign-in nothing is asked', t => {
  const { dir, env } = fakeBin(t)
  assert.equal(run(u.CLAUDE_SCRIPT, env).status, 3)
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude', '.credentials.json'), '{\n  "claudeAiOauth": {\n    "accessToken": "from-file"\n  }\n}\n')
  assert.match(run(u.CLAUDE_SCRIPT, env).stdout, /Bearer from-file/)
})

test('Claude script: a chosen profile never reads the default keychain item', t => {
  const { dir, env } = fakeBin(t, { keychain: '{"claudeAiOauth":{"accessToken":"other-account"}}' })
  const profile = join(dir, 'profile')
  mkdirSync(profile)
  assert.equal(run(u.CLAUDE_SCRIPT, { ...env, CLAUDE_CONFIG_DIR: profile }).status, 3)
})

test('Codex script: token and account from auth.json, on stdin only; an API-key login asks nothing', t => {
  const { dir, env } = fakeBin(t)
  assert.equal(run(u.CODEX_SCRIPT, env).status, 3)
  mkdirSync(join(dir, '.codex'))
  writeFileSync(join(dir, '.codex', 'auth.json'), '{"OPENAI_API_KEY": "k"}\n')
  assert.equal(run(u.CODEX_SCRIPT, env).status, 3)
  writeFileSync(
    join(dir, '.codex', 'auth.json'),
    '{\n  "tokens": {\n    "id_token": "idt",\n    "access_token": "cx-secret",\n    "account_id": "acct"\n  }\n}\n',
  )
  const r = run(u.CODEX_SCRIPT, env)
  assert.match(r.stdout, /Authorization: Bearer cx-secret"\nheader = "ChatGPT-Account-Id: acct"/)
  assert.doesNotMatch(r.stdout.split('STDIN')[0], /cx-secret|acct/)
})
