import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { Bot, ensureChannels, makeApi } from '../discord/bot.mjs'
import { allowed, clip, closedText, diffBoard, metricsDue, metricsText, needText, pruneSeen } from '../discord/model.mjs'

const NOW = 1_800_000_000_000
const ask = {
  key: 'D1',
  kind: 'ask',
  title: 'Pick',
  text: 'Which one?',
  from: 'w-api',
  at: NOW - 1000,
  isOpen: true,
  options: ['A', 'B'],
  recommended: 1,
}
const todo = {
  key: 'T1',
  kind: 'do',
  title: 'Test it',
  text: 'Check the build',
  from: 'w',
  at: NOW - 1000,
  isOpen: true,
  url: 'http://localhost:5173',
}
const board = over => ({ session: 's', cwd: '/home/code/shop', needs: [], tasks: [], workers: [], ...over })
const diff = (b, seen = {}, extra = {}) => diffBoard(b, seen, { now: NOW, owner: 'me', ...extra })

test('a new question goes to decisions and mentions the owner; a to-do goes to to-do', () => {
  const [a, b] = diff(board({ needs: [ask, todo] }))
  assert.equal(a.type, 'post')
  assert.equal(a.channel, 'decisions')
  assert.equal(a.mention, true)
  assert.equal(a.open, true)
  assert.match(a.content, /^<@me> \*\*D1 · Pick\*\* \(shop, w-api\)\nWhich one\?\n1\. A\n2\. B \(recommended\)$/)
  assert.equal(b.channel, 'to-do')
  assert.match(b.content, /http:\/\/localhost:5173$/)
})

test('something to read goes to updates with no mention', () => {
  const [a] = diff(board({ needs: [{ ...todo, kind: 'know' }] }))
  assert.equal(a.channel, 'updates')
  assert.equal(a.mention, undefined)
  assert.doesNotMatch(a.content, /<@/)
})

test('what was seen is not posted again', () => {
  assert.deepEqual(diff(board({ needs: [ask] }), { 's:D1': { open: true, message: 'm', channel: 'c' } }), [])
})

test('a closed item edits its message, with no mention and its answer', () => {
  const [a] = diff(board({ needs: [{ ...ask, isOpen: false, end: 'B' }] }), { 's:D1': { open: true, message: 'm', channel: 'c' } })
  assert.deepEqual([a.type, a.message, a.channel], ['edit', 'm', 'c'])
  assert.match(a.content, /~~D1 · Pick~~ \(shop\): B/)
  assert.doesNotMatch(a.content, /<@/)
})

test('an item that left the board closes its message once', () => {
  const [a] = diff(board(), { 's:D1': { open: true, message: 'm', channel: 'c' }, 'other:D1': { open: true, message: 'n', channel: 'c' } })
  assert.equal(a.type, 'edit')
  assert.equal(a.message, 'm')
  assert.deepEqual(diff(board(), { 's:D1': { open: false, message: 'm', channel: 'c' } }), [])
})

test('the first look only remembers', () => {
  const b = board({
    needs: [ask],
    tasks: [{ key: 'x', label: '#1', isMerged: true, mergedAt: NOW }],
    workers: [{ name: 'w', state: 'blocked', since: NOW }],
  })
  const actions = diff(b, {}, { first: true })
  assert.equal(actions.length, 3)
  assert.ok(actions.every(a => a.type === 'mark'))
})

test('anything older than a day is remembered, not posted', () => {
  const old = NOW - 25 * 3600 * 1000
  const b = board({
    needs: [{ ...ask, at: old }],
    tasks: [
      { key: 'x', label: '#1', isMerged: true, mergedAt: old },
      { key: 'y', label: '#2', isMerged: true, mergedAt: null },
    ],
  })
  assert.ok(diff(b).every(a => a.type === 'mark'))
})

test('a merge and a worker that stopped go to updates, once per kind of stop', () => {
  const b = board({
    tasks: [
      { key: 'x', label: '#7', title: 'Fix', url: 'https://x/7', isMerged: true, mergedAt: NOW },
      { key: 'y', label: '#8', isMerged: false },
    ],
    workers: [
      { name: 'w1', state: 'blocked', since: NOW, note: 'a prompt' },
      { name: 'w2', state: 'working', since: NOW },
      { name: 'w3', state: 'reported', endedAt: NOW },
      { name: 'w4', state: 'done', endedAt: NOW },
    ],
  })
  const [merged, blocked, reported, done] = diff(b)
  assert.match(merged.content, /Merged in shop: \*\*#7\*\* Fix\n<https:\/\/x\/7>/)
  assert.match(blocked.content, /\*\*w1\*\* is blocked in shop: a prompt/)
  assert.match(reported.content, /\*\*w3\*\* finished/)
  assert.match(done.content, /\*\*w4\*\* finished/)
  assert.equal(diff(b).length, 4)
  const same = diff(board({ workers: [{ name: 'w3', state: 'done', endedAt: NOW }] }), { 's:worker:w3:finished': { at: NOW } })
  assert.deepEqual(same, [])
})

test('a long question stays under Discord limit with its options intact', () => {
  const text = needText({ ...ask, text: 'x'.repeat(5000) }, board(), 'me')
  assert.ok(text.length <= 2000)
  assert.match(text, /2\. B \(recommended\)$/)
  assert.ok(closedText({ key: 'D1', title: 'y'.repeat(5000), end: 'z' }, board()).length <= 2000)
  assert.equal(clip('abc', 2), 'a…')
})

test('only the listed folders post', () => {
  assert.equal(allowed('/h/work/x', undefined, '/h'), true)
  assert.equal(allowed('/h/code/personal/x', ['~/code/personal'], '/h'), true)
  assert.equal(allowed('/h/code/personal', ['~/code/personal/'], '/h'), true)
  assert.equal(allowed('/h/code/personal-work', ['~/code/personal'], '/h'), false)
  assert.equal(allowed('/h/code/work/x', ['~/code/personal'], '/h'), false)
  assert.equal(allowed(undefined, ['~/code/personal'], '/h'), false)
})

test('pruning keeps what is open or recent', () => {
  const month = 31 * 24 * 3600 * 1000
  const kept = pruneSeen({ a: { at: NOW - month, open: true }, b: { at: NOW - month }, c: { at: NOW } }, NOW)
  assert.deepEqual(Object.keys(kept), ['a', 'c'])
})

test('the metrics summary', () => {
  const text = metricsText({
    workers: { sessions: 3, by_model: { sonnet: { sessions: 2, cost: 1.5 }, opus: { sessions: 1, cost: 2 } } },
    github: {
      repos: [
        {
          repo: 'o/n',
          runs_capped: true,
          prs: { merged: 4, capped: true },
          workflows: [
            { runs: 10, failures: 1 },
            { runs: 5, failures: 2 },
          ],
        },
      ],
    },
  })
  assert.match(text, /3 sessions, \$3\.50/)
  assert.match(text, /o\/n: 4\+ PRs merged, 15\+ CI runs, 3 failed/)
  assert.match(metricsText({}), /0 sessions, \$0\.00/)
})

test('metrics are due once a day from nine', () => {
  const at = h => new Date(2026, 9, 31, h)
  assert.equal(metricsDue(null, at(8)), null)
  assert.equal(metricsDue(null, at(9)), '2026-10-31')
  assert.equal(metricsDue('2026-10-31', at(20)), null)
  assert.equal(metricsDue('2026-10-30', at(9)), '2026-10-31')
})

// The bot with a fake Discord and a real folder.
let home
let calls
const api = async (method, path, body) => {
  calls.push({ method, path, body })
  if (api.fail) throw new Error('down')
  return { id: `m${calls.length}` }
}
const writeBoard = b => writeFileSync(join(home, 'board', `${b.session}.json`), JSON.stringify(b))
const makeBot = (over = {}) =>
  new Bot({
    api,
    home,
    userHome: '/home',
    config: { ownerId: 'me' },
    channels: { decisions: 'cd', 'to-do': 'ct', updates: 'cu', metrics: 'cm' },
    now: () => NOW,
    ...over,
  })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hrd-discord-'))
  mkdirSync(join(home, 'board'))
  calls = []
  api.fail = false
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

test('first run posts nothing, then a new question posts once and only the owner can be notified', async () => {
  writeBoard(board({ needs: [ask] }))
  const bot = makeBot()
  await bot.look()
  assert.deepEqual(calls, [])
  writeBoard(board({ needs: [ask, { ...ask, key: 'D2' }] }))
  bot.mtimes = {}
  await bot.look()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/channels/cd/messages')
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [], users: ['me'] })
  bot.mtimes = {}
  await bot.look()
  assert.equal(calls.length, 1)
})

test('a restart remembers what it posted, and closes it later', async () => {
  writeFileSync(join(home, 'discord-state.json'), '{"seen":{},"metricsDay":null}')
  writeBoard(board({ needs: [ask] }))
  await makeBot().look()
  assert.equal(calls.length, 1)
  writeBoard(board({ needs: [{ ...ask, isOpen: false, end: 'B' }] }))
  await makeBot().look()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].method, 'PATCH')
  assert.equal(calls[1].path, '/channels/cd/messages/m1')
  assert.deepEqual(calls[1].body.allowed_mentions, { parse: [] })
})

test('a failed post is tried again and not marked as seen', async () => {
  writeFileSync(join(home, 'discord-state.json'), '{"seen":{},"metricsDay":null}')
  writeBoard(board({ needs: [ask] }))
  const bot = makeBot()
  api.fail = true
  await assert.rejects(bot.look())
  api.fail = false
  bot.mtimes = {}
  await bot.look()
  assert.equal(calls.length, 2)
  assert.ok(JSON.parse(readFileSync(join(home, 'discord-state.json'), 'utf8')).seen['s:D1'].message)
})

test('a folder not listed posts nothing, and a broken board is skipped', async () => {
  writeFileSync(join(home, 'discord-state.json'), '{"seen":{},"metricsDay":null}')
  writeBoard(board({ needs: [ask], cwd: '/home/work/x' }))
  writeFileSync(join(home, 'board', 'broken.json'), '{"session":')
  await makeBot({ config: { ownerId: 'me', only: ['~/personal'] } }).look()
  assert.deepEqual(calls, [])
})

test('the daily summary posts once and mentions nobody', async () => {
  const bot = makeBot({ runMetrics: async () => ({}), today: () => new Date(2026, 9, 31, 10) })
  await bot.metrics()
  await bot.metrics()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/channels/cm/messages')
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] })
})

test('channels: what exists is kept, what is missing is made under the category', async () => {
  const made = []
  const fake = async (method, _path, body) => {
    if (method === 'GET')
      return [
        { id: 'c1', type: 4, name: 'herdr' },
        { id: 'x', type: 0, name: 'updates' },
      ]
    made.push(body)
    return { id: `new-${body.name}` }
  }
  const ids = await ensureChannels(fake, 'g')
  assert.deepEqual(
    made.map(m => m.name),
    ['decisions', 'to-do', 'metrics'],
  )
  assert.ok(made.every(m => m.parent_id === 'c1'))
  assert.equal(ids.updates, 'x')
  assert.equal(ids.decisions, 'new-decisions')
})

test('the api waits out a rate limit, then retries; an error says what failed without the token', async () => {
  const waits = []
  const replies = [
    { status: 429, ok: false, json: async () => ({ retry_after: 0.5 }) },
    { status: 200, ok: true, json: async () => ({ id: '1' }) },
    { status: 403, ok: false, text: async () => 'Missing Access' },
  ]
  const seen = []
  const call = makeApi(
    'secret',
    async (url, init) => (seen.push(init.headers.Authorization), replies.shift()),
    async ms => waits.push(ms),
  )
  assert.deepEqual(await call('POST', '/x', {}), { id: '1' })
  assert.deepEqual(waits, [600])
  assert.equal(seen[0], 'Bot secret')
  await assert.rejects(call('GET', '/y'), e => /403 Missing Access/.test(e.message) && !e.message.includes('secret'))
})
