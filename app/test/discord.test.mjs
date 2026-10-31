import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { Bot, ensureChannels, makeApi } from '../discord/bot.mjs'
import { Gateway } from '../discord/gateway.mjs'
import {
  allowed,
  buttons,
  clip,
  closedText,
  diffBoard,
  herdrOnly,
  metricsDue,
  metricsText,
  needText,
  parseTap,
  planTap,
  pruneSeen,
} from '../discord/model.mjs'

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

// Buttons.
const live = over => board({ at: NOW - 1000, needs: [ask, todo], ...over })
const tapOf = (id, over = {}) => ({
  id: 'i1',
  token: 'tok',
  type: 3,
  guild_id: 'g',
  member: { user: { id: 'me' } },
  message: { id: 'm' },
  data: { custom_id: id },
  ...over,
})
const TRACK = { 's:D1': { open: true, message: 'm', channel: 'cd' }, 's:T1': { open: true, message: 'm', channel: 'ct' } }
const plan = (id, b = live(), seen = TRACK, over = {}) =>
  planTap(id, { interaction: tapOf(id, over), config: { ownerId: 'me', guildId: 'g' }, seen, board: b, now: NOW })

test('buttons: one per option, the recommended one stands out, and Done for a to-do', () => {
  const [row] = buttons(ask, board())
  assert.deepEqual(
    row.components.map(b => [b.label, b.style]),
    [
      ['1. A', 2],
      ['2. B', 1],
    ],
  )
  assert.equal(row.components[1].custom_id, 'hrd|a|s|D1|1')
  assert.equal(buttons(todo, board())[0].components[0].label, 'Done')
  assert.deepEqual(buttons({ ...todo, kind: 'know' }, board()), [])
  assert.deepEqual(buttons({ ...ask, options: [] }, board()), [])
})

test('buttons: rows of five, labels Discord accepts', () => {
  const rows = buttons({ ...ask, options: Array.from({ length: 7 }, (_, i) => `${i}${'x'.repeat(100)}`) }, board())
  assert.deepEqual(
    rows.map(r => r.components.length),
    [5, 2],
  )
  assert.ok(rows.flatMap(r => r.components).every(b => b.label.length <= 80 && b.custom_id.length <= 100))
  const long = buttons(ask, board({ session: '0a9feb0d-9ffd-4d08-9555-00bf44eff4c4' }))[0].components[0]
  assert.ok(long.custom_id.length <= 100)
  assert.deepEqual(parseTap(long.custom_id), { kind: 'a', session: '0a9feb0d-9ffd-4d08-9555-00bf44eff4c4', key: 'D1', index: 0 })
})

test('deploys and releases are answered in Herdr: no buttons, and the message says so', () => {
  for (const text of ['Deploy tonight?', 'Run the promotion to main?', 'Cut the release', 'Touch production?', 'force-push it?']) {
    const need = { ...ask, text }
    assert.equal(herdrOnly(need), true, text)
    assert.deepEqual(buttons(need, board()), [], text)
    assert.match(needText(need, board(), 'me'), /Answer this one in Herdr/)
  }
  assert.equal(herdrOnly({ ...ask, options: ['Yes', 'Deploy it'] }), true)
  assert.equal(herdrOnly(ask), false)
  assert.equal(herdrOnly({ ...ask, text: 'The progress bar' }), false)
  assert.doesNotMatch(needText(ask, board(), 'me'), /in Herdr/)
})

test('a question with no options says to answer in Herdr', () => {
  assert.match(needText({ ...ask, options: [] }, board(), 'me'), /Answer this one in Herdr/)
})

test('a tap sends the full option text, and Done the to-do', () => {
  const b = live({ needs: [{ ...ask, options: ['A', 'x'.repeat(200)] }, todo] })
  assert.deepEqual(plan('hrd|a|s|D1|1', b).action, { action: 'answer', key: 'D1', answer: 'x'.repeat(200) })
  const done = plan('hrd|d|s|T1')
  assert.deepEqual(done.action, { action: 'done', key: 'T1' })
  assert.match(done.content, /Done, sent to the coordinator/)
})

test('nobody but the owner can answer', () => {
  assert.match(plan('hrd|a|s|D1|0', live(), TRACK, { member: { user: { id: 'other' } } }).say, /Only the owner/)
  assert.match(plan('hrd|a|s|D1|0', live(), TRACK, { guild_id: 'elsewhere' }).say, /Only the owner/)
  assert.equal(plan('hrd|a|s|D1|0', live(), TRACK, { member: { user: { id: 'other' } } }).action, undefined)
})

test('a late tap sends nothing and takes the buttons away', () => {
  const closed = plan('hrd|a|s|D1|0', live({ needs: [{ ...ask, isOpen: false }] }))
  assert.equal(closed.action, undefined)
  assert.equal(closed.gone, true)
  assert.equal(plan('hrd|a|s|D1|0', live({ needs: [] })).gone, true)
  assert.equal(plan('hrd|a|s|D1|0', null).action, undefined)
})

test('a second tap, a stopped coordinator and a changed question send nothing', () => {
  assert.match(plan('hrd|a|s|D1|0', live(), { 's:D1': { ...TRACK['s:D1'], pending: 'f' } }).say, /Already sent/)
  const stopped = plan('hrd|a|s|D1|0', live({ at: NOW - 4 * 60 * 1000 }))
  assert.match(stopped.say, /isn't running/)
  assert.equal(stopped.gone, undefined)
  assert.equal(plan('hrd|a|s|D1|0', live({ at: undefined })).action, undefined)
  assert.equal(plan('hrd|a|s|D1|9').gone, true)
  assert.equal(plan('hrd|d|s|D1').gone, true)
  assert.equal(plan('hrd|a|s|T1|0').gone, true)
  // A question that became a deploy after it was posted.
  assert.equal(plan('hrd|a|s|D1|0', live({ needs: [{ ...ask, text: 'Deploy now?' }] })).action, undefined)
})

test('a tap that is not ours gets no reply: wrong message, unknown item, or a forged id', () => {
  assert.equal(plan('other|a|s|D1|0'), null)
  assert.equal(plan('hrd|a|s|D2|0'), null)
  assert.equal(plan('hrd|a|s|D1|0', live(), TRACK, { message: { id: 'different' } }), null)
  assert.equal(parseTap('hrd|a|../../etc|D1|0'), null)
  assert.equal(parseTap('hrd|a|s|../x|0'), null)
  assert.equal(parseTap('hrd|a|s|D1|x'), null)
  assert.equal(parseTap('hrd|z|s|D1'), null)
})

test('closing takes the buttons away; a refused answer brings them back with why', () => {
  const seen = { 's:D1': { open: true, message: 'm', channel: 'c', pending: 'f1' } }
  assert.equal(diff(board({ needs: [{ ...ask, isOpen: false }] }), seen)[0].components, undefined)
  const [back] = diff(board({ needs: [ask], actions: [{ id: 'f1', ok: false, message: 'D1 is not an open decision' }] }), seen)
  assert.equal(back.keepOpen, true)
  assert.match(back.content, /didn't go through: D1 is not an open decision/)
  assert.equal(back.components[0].components.length, 2)
  assert.doesNotMatch(back.content, /<@/)
  assert.deepEqual(diff(board({ needs: [ask], actions: [{ id: 'f1', ok: true, message: '' }] }), seen), [])
})

test('tap end to end: the same action file Herdr writes, one reply, and a retry after a refusal', async () => {
  writeFileSync(join(home, 'discord-state.json'), '{"seen":{},"metricsDay":null}')
  writeBoard(live({ needs: [ask] }))
  const bot = makeBot({ config: { ownerId: 'me', guildId: 'g' } })
  await bot.look()
  const post = calls.pop()
  assert.equal(post.body.components[0].components.length, 2)
  const interaction = tapOf('hrd|a|s|D1|1', { message: { id: 'm1' } })
  await bot.tap(interaction)
  const files = readdirSync(join(home, 'board', 's.actions'))
  assert.equal(files.length, 1)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'board', 's.actions', files[0]), 'utf8')), {
    action: 'answer',
    key: 'D1',
    answer: 'B',
  })
  assert.deepEqual(readdirSync(join(home, 'outgoing')), [])
  assert.equal(calls[0].path, '/interactions/i1/tok/callback')
  assert.equal(calls[0].body.type, 7)
  assert.deepEqual(calls[0].body.data.components, [])
  calls.length = 0
  await bot.tap(interaction)
  assert.equal(readdirSync(join(home, 'board', 's.actions')).length, 1)
  assert.equal(calls[0].body.data.flags, 64)
  calls.length = 0
  // The plugin refused it: the buttons come back and a new tap can go.
  writeBoard(live({ needs: [ask], actions: [{ id: files[0], ok: false, message: 'no' }] }))
  bot.mtimes = {}
  await bot.look()
  assert.equal(calls[0].method, 'PATCH')
  assert.equal(calls[0].body.components[0].components.length, 2)
  calls.length = 0
  await bot.tap(interaction)
  assert.equal(readdirSync(join(home, 'board', 's.actions')).length, 2)
})

test('a tap that is not ours touches nothing and gets no reply', async () => {
  writeBoard(live({ needs: [ask] }))
  const bot = makeBot({ config: { ownerId: 'me', guildId: 'g' } })
  await bot.tap(tapOf('hrd|a|s|D1|0'))
  await bot.tap(tapOf('something-else'))
  assert.deepEqual(calls, [])
})

// The gateway with a fake socket.
function gateway() {
  const sockets = []
  class Socket {
    constructor() {
      this.sent = []
      sockets.push(this)
    }
    send(text) {
      this.sent.push(JSON.parse(text))
    }
    close() {
      this.onclose({ code: 1000 })
    }
  }
  const timers = { later: [], every: [], stopped: [] }
  const taps = []
  const g = new Gateway({
    token: 'tok',
    onTap: t => taps.push(t),
    Socket,
    later: (f, ms) => timers.later.push({ f, ms }),
    every: (f, ms) => (timers.every.push({ f, ms }), timers.every.length),
    stopEvery: id => timers.stopped.push(id),
  })
  g.start()
  const socket = () => sockets.at(-1)
  const receive = m => socket().onmessage({ data: JSON.stringify(m) })
  return { g, sockets, socket, receive, timers, taps }
}

test('gateway: identifies with no intents, and hands on button taps only', () => {
  const { socket, receive, timers, taps } = gateway()
  receive({ op: 10, d: { heartbeat_interval: 1000 } })
  assert.equal(timers.every[0].ms, 1000)
  assert.deepEqual([socket().sent[0].op, socket().sent[0].d.token, socket().sent[0].d.intents], [2, 'tok', 0])
  receive({ op: 0, s: 5, t: 'INTERACTION_CREATE', d: { type: 3, id: 'tap' } })
  receive({ op: 0, s: 6, t: 'INTERACTION_CREATE', d: { type: 2, id: 'slash' } })
  receive({ op: 0, s: 7, t: 'GUILD_CREATE', d: {} })
  assert.deepEqual(
    taps.map(t => t.id),
    ['tap'],
  )
})

test('gateway: heartbeats with the last sequence, and reconnects when none is answered', () => {
  const { socket, receive, timers, sockets } = gateway()
  receive({ op: 10, d: { heartbeat_interval: 1000 } })
  receive({ op: 0, s: 9, t: 'READY', d: {} })
  timers.every[0].f()
  assert.deepEqual(socket().sent.at(-1), { op: 1, d: 9 })
  receive({ op: 11 })
  timers.every[0].f()
  timers.every[0].f()
  assert.deepEqual(timers.stopped, [1])
  assert.equal(timers.later.length, 1)
  timers.later[0].f()
  assert.equal(sockets.length, 2)
})

test('gateway: asked to reconnect it does; a bad token waits longer', () => {
  const { receive, timers, socket } = gateway()
  receive({ op: 7 })
  assert.equal(timers.later[0].ms, 5000)
  timers.later[0].f()
  socket().onclose({ code: 4004 })
  assert.equal(timers.later[1].ms, 300000)
})
