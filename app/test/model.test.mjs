import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  FLASH_MS,
  anyFlashing,
  applyFile,
  boardId,
  counts,
  debugLine,
  flashing,
  isUnseen,
  labelOf,
  nextPick,
  observeArrivals,
  openNeeds,
  otherCount,
  pickAt,
  pickNumber,
  resolveBoard,
  stripItems,
} from '../mods/herdr-agents/model.js'

const board = (session, terminal, extra = {}) => ({
  session,
  at: 1000,
  cwd: '/work',
  coordinator: { terminal },
  workers: [],
  needs: [],
  ...extra,
})
const term = (address, extra = {}) => ({
  address,
  state: 'live',
  program: { agent: true, name: 'claude' },
  labels: { 'herdr.space': 's1' },
  ...extra,
})
const focus = (terminal, space = 's1') => ({ space, tab: 'a', terminal })

test('rule 1: a board whose coordinator terminal is gone, not live or not an agent is dropped', () => {
  const boards = [board('gone', 't9'), board('exited', 't2'), board('shell', 't3'), board('ok', 't1'), { session: 'old', at: 5, cwd: '/x' }]
  const terminals = [term('t1'), term('t2', { state: 'exited' }), term('t3', { program: { agent: false } })]
  assert.equal(resolveBoard(boards, terminals, focus('t9', 'elsewhere')).board, null)
  assert.equal(resolveBoard(boards, terminals, focus('t2', 'elsewhere')).board, null)
  assert.equal(resolveBoard(boards, terminals, focus('t3', 'elsewhere')).board, null)
  assert.equal(resolveBoard(boards, terminals, focus('t1')).board.session, 'ok')
  assert.equal(resolveBoard([boards[4]], terminals, focus('t1')).board, null, 'a board without the field is ignored')
})

test('rule 2: the focused terminal is a coordinator', () => {
  const boards = [board('a', 't1'), board('b', 't2', { at: 9000 })]
  const r = resolveBoard(boards, [term('t1'), term('t2')], focus('t1'))
  assert.deepEqual([r.board.session, r.via], ['a', 2])
  assert.deepEqual(r.pick, { s1: 'a' })
})

test('rule 3: the focused terminal is a worker of a board, by name', () => {
  const boards = [board('a', 't1'), board('b', 't2', { workers: [{ name: 'w-api' }] })]
  const terminals = [term('t1'), term('t2'), term('t7', { name: 'w-api', labels: {} })]
  const r = resolveBoard(boards, terminals, focus('t7'))
  assert.deepEqual([r.board.session, r.via], ['b', 3])
})

test('rule 3 loses to rule 2 and needs a live board', () => {
  const boards = [board('a', 't1', { workers: [{ name: 'w-api' }] }), board('b', 't7')]
  const terminals = [term('t1'), term('t7', { name: 'w-api' })]
  assert.equal(resolveBoard(boards, terminals, focus('t7')).board.session, 'b')
  assert.equal(resolveBoard([board('a', 't8', { workers: [{ name: 'w-api' }] })], terminals, focus('t7')).board, null)
})

test('rule 4: a shell in the space of a coordinator shows its board; the newest of two wins', () => {
  const boards = [board('old', 't1', { at: 1 }), board('new', 't2', { at: 2 }), board('other', 't3', { at: 9 })]
  const terminals = [term('t1'), term('t2'), term('t3', { labels: { 'herdr.space': 's2' } }), term('t5', { program: null })]
  const r = resolveBoard(boards, terminals, focus('t5'))
  assert.deepEqual([r.board.session, r.via], ['new', 4])
  assert.equal(resolveBoard(boards, terminals, focus('t5', 's2')).board.session, 'other')
  assert.equal(resolveBoard(boards, terminals, focus(null)).board.session, 'new', 'a mod pane has no terminal')
})

test('rule 4: the board last picked by rule 2 or 3 in this space stays picked, and only in this space', () => {
  const boards = [board('old', 't1', { at: 1 }), board('new', 't2', { at: 2 })]
  const terminals = [term('t1'), term('t2'), term('t5', { program: null })]
  const first = resolveBoard(boards, terminals, focus('t1'))
  const next = resolveBoard(boards, terminals, focus('t5'), first.pick)
  assert.equal(next.board.session, 'old')
  assert.equal(resolveBoard(boards, terminals, focus('t5', 's1'), { s2: 'old' }).board.session, 'new')
  assert.equal(resolveBoard(boards, terminals, focus('t5'), { s1: 'gone' }).board.session, 'new')
})

test('rule 4: the pick is remembered per space: pick on t1, visit space B, come back to t1 and a shell', () => {
  const boards = [board('old', 't1', { at: 1 }), board('new', 't2', { at: 2 }), board('b', 't3', { at: 5 })]
  const terminals = [
    term('t1'),
    term('t2'),
    term('t3', { labels: { 'herdr.space': 's2' } }),
    term('t5', { program: null }),
    term('t6', { program: null, labels: { 'herdr.space': 's2' } }),
  ]
  let r = resolveBoard(boards, terminals, focus('t1'))
  assert.equal(r.board.session, 'old')
  r = resolveBoard(boards, terminals, focus('t6', 's2'), r.pick)
  assert.equal(r.board.session, 'b')
  r = resolveBoard(boards, terminals, focus('t5'), r.pick)
  assert.deepEqual([r.board.session, r.via], ['old', 4])
})

test('rule 4: two coordinators in one space do not flip while both rewrite; a rule 4 pick is kept too', () => {
  const terminals = [term('t1'), term('t2'), term('t5', { program: null })]
  let pick = null
  let first = null
  for (const at of [10, 20, 30, 40]) {
    const boards = [board('a', 't1', { at: at + (at % 20 === 0 ? 0 : 5) }), board('b', 't2', { at: at + (at % 20 === 0 ? 5 : 0) })]
    const r = resolveBoard(boards, terminals, focus('t5'), pick)
    first ??= r.board.session
    assert.equal(r.board.session, first)
    pick = r.pick
  }
  // The remembered file is gone: the newest of what is left.
  assert.equal(resolveBoard([board('b', 't2', { at: 1 })], terminals, focus('t5'), pick).board.session, 'b')
})

test('rule 5: nothing, and nothing when focus is unknown', () => {
  const terminals = [term('t1', { labels: { 'herdr.space': 's2' } })]
  assert.equal(resolveBoard([board('a', 't1')], terminals, focus('t5')).board, null)
  assert.equal(resolveBoard([board('a', 't1')], terminals, null).board, null)
  assert.equal(resolveBoard([], terminals, focus('t1')).board, null)
})

test('a plain claude started by hand in a coordinator terminal writes a second board for the same terminal: the first stays', () => {
  const real = board('real', 't1', { at: 1000, workers: [{ name: 'w-api' }] })
  const stray = board('stray', 't1', { at: 1500 })
  const terminals = [term('t1')]
  // Both rewrite every 3 s, so the newest `at` alternates; the one picked last stays.
  let pick = resolveBoard([real], terminals, focus('t1')).pick
  for (const at of [3000, 6000]) {
    const r = resolveBoard(
      [
        { ...real, at: at - 1500 },
        { ...stray, at },
      ],
      terminals,
      focus('t1'),
      pick,
    )
    assert.equal(r.board.session, 'real')
    pick = r.pick
  }
  // With no memory (the mod just loaded) the newest wins, and it is then kept.
  const cold = resolveBoard([real, stray], terminals, focus('t1'))
  assert.equal(cold.board.session, 'stray')
  assert.equal(resolveBoard([real, { ...stray, at: 1 }], terminals, focus('t1'), cold.pick).board.session, 'stray')
  // When the stray ends, its file goes and the real one is shown again.
  assert.equal(resolveBoard([real], terminals, focus('t1'), cold.pick).board.session, 'real')
})

test('stray/real/stray on one terminal while focus is on a plain shell in the space does not flip', () => {
  const terminals = [term('t1'), term('t5', { program: null })]
  const real = board('real', 't1')
  const stray = board('stray', 't1')
  let pick = null
  const seen = []
  ;[
    [stray, real],
    [real, stray],
    [stray, real],
  ].forEach(([newest, other], i) => {
    const r = resolveBoard(
      [
        { ...newest, at: 100 + i * 10 },
        { ...other, at: 50 },
      ],
      terminals,
      focus('t5'),
      pick,
    )
    seen.push(r.board.session)
    pick = r.pick
  })
  assert.deepEqual(new Set(seen).size, 1)
})

test('/clear or resume leaves two session files for one terminal: the newest, then the same one', () => {
  const boards = [board('before', 't1', { at: 1 }), board('after', 't1', { at: 2 })]
  assert.equal(resolveBoard(boards, [term('t1')], focus('t1')).board.session, 'after')
  assert.equal(resolveBoard([...boards].reverse(), [term('t1')], focus('t1')).board.session, 'after')
})

test('labelOf reads the object shape only', () => {
  assert.equal(labelOf({ labels: { a: 'x' } }, 'a'), 'x')
  assert.equal(labelOf({ labels: ['a=x'] }, 'a'), null, 'only the object shape')
  assert.equal(labelOf({ labels: { a: 'x' } }, 'b'), null)
  assert.equal(labelOf({ labels: {} }, 'a'), null)
  assert.equal(labelOf({}, 'a'), null)
  assert.equal(labelOf(undefined, 'a'), null)
})

test('boardId takes <session>.json in the board folder and nothing else', () => {
  const dir = '/h/.herdr-agents/board'
  assert.equal(boardId(dir, `${dir}/abc.json`), 'abc')
  assert.equal(boardId(`${dir}/`, `${dir}/abc.json`), 'abc')
  assert.equal(boardId(dir, `${dir}/abc.json.tmp`), null)
  assert.equal(boardId(dir, `${dir}/abc.tmp`), null)
  assert.equal(boardId(dir, `${dir}/abc.actions/1-x.json`), null)
  assert.equal(boardId(dir, `${dir}/abc.actions`), null)
  assert.equal(boardId(dir, '/elsewhere/abc.json'), null)
})

test('applyFile: a changed file replaces, a bad one keeps the last good copy, a removed one drops the board', () => {
  const one = applyFile({}, 'a', '{"session":"a","at":1}')
  assert.equal(one.a.at, 1)
  const two = applyFile(one, 'a', '{"session":"a","at":2}')
  assert.equal(two.a.at, 2)
  assert.equal(one.a.at, 1, 'the old map is not changed')
  assert.equal(applyFile(two, 'a', '{"session":').a.at, 2)
  assert.equal(applyFile(two, 'a', '[1]').a.at, 2)
  assert.equal(applyFile(two, 'a', 'null').a.at, 2)
  assert.deepEqual(applyFile(two, 'a', null), {})
  assert.equal(applyFile(two, 'b', '{"session":"b"}').a.at, 2)
})

test('the debug line is the folder and the open count, and empty without a board', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))
  assert.equal(debugLine(fixture), '/work/shop · 7 open')
  assert.equal(debugLine(null), '')
  assert.equal(openNeeds({ needs: [{ isOpen: true }, { isOpen: false, end: 'done' }] }).length, 1)
})

// ---- S3: the strip ----

const full = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))

test('stripItems: blocked workers, then open asks, then open dos, in board order; know items stay out', () => {
  const items = stripItems(full())
  assert.deepEqual(
    items.map(i => [i.kind, i.id]),
    [
      ['blocked', 'w-stuck'],
      ['ask', 'D7'],
      ['ask', 'D8'],
      ['do', 'T12'],
      ['do', 'T13'],
    ],
  )
  assert.equal(items[0].label, 'waiting at a permission prompt')
  assert.equal(items[1].label, 'Pagination style')
  assert.equal(new Set(items.map(i => i.key)).size, items.length)
})

test('stripItems: order does not follow the order in the file; closed needs and no board give nothing', () => {
  const b = {
    workers: [
      { name: 'a', state: 'working' },
      { name: 'b', state: 'blocked' },
    ],
    needs: [
      { key: 'T1', kind: 'do', text: 'second line\nx', isOpen: true },
      { key: 'D1', kind: 'ask', text: 'first\nmore', isOpen: true },
      { key: 'D2', kind: 'ask', text: 'closed', isOpen: false },
      { key: 'K1', kind: 'know', text: 'fyi', isOpen: true },
    ],
  }
  const items = stripItems(b)
  assert.deepEqual(
    items.map(i => i.id),
    ['b', 'D1', 'T1'],
  )
  assert.equal(items[0].label, 'stuck', 'a blocked worker with no note')
  assert.equal(items[1].label, 'first', 'no title: the first line of the text')
  assert.deepEqual(stripItems(null), [])
  assert.deepEqual(stripItems({}), [])
})

test('counts: workers by state', () => {
  assert.deepEqual(counts(full()), { working: 2, waiting: 1, blocked: 1 })
  assert.deepEqual(counts(null), { working: 0, waiting: 0, blocked: 0 })
})

test('pickAt: keys 1 to 6 reach the first six; later tabs are reached by scrolling', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ key: `k${i + 1}` }))
  assert.equal(pickAt(items, 1).key, 'k1')
  assert.equal(pickAt(items, 6).key, 'k6')
  assert.equal(pickAt(items, 7), null)
  assert.equal(pickAt(items, 0), null)
  assert.equal(pickAt(items.slice(0, 2), 3), null)
})

test('otherCount: a terminal counts once, by its newest board; the shown terminal is not other', () => {
  const withItems = (session, terminal, at, n) =>
    board(session, terminal, { at, needs: Array.from({ length: n }, (_, i) => ({ key: `D${i}`, kind: 'ask', text: 'q', isOpen: true })) })
  const here = withItems('here', 't1', 5, 1)
  const terminals = [term('t1'), term('t2'), term('t3'), term('t4', { state: 'exited' }), term('t5', { program: { agent: false } })]
  const boards = [
    here,
    withItems('a', 't2', 10, 2),
    withItems('b', 't3', 20, 3),
    withItems('gone', 't4', 30, 9),
    withItems('shell', 't5', 40, 9),
    withItems('stray', 't1', 60, 4),
  ]
  assert.deepEqual(otherCount(boards, terminals, here), { count: 5, terminal: 't2' })
  assert.deepEqual(otherCount([here], terminals, here), { count: 0, terminal: null })
  assert.deepEqual(
    otherCount(boards, terminals, null),
    { count: 9, terminal: 't1' },
    'with no board shown, every live terminal is other, and t1 counts its newest board',
  )
  // After a /clear elsewhere two files point at t2: only the newest counts.
  const cleared = [here, withItems('new', 't2', 20, 1), withItems('old', 't2', 10, 3)]
  assert.equal(otherCount(cleared, terminals, here).count, 1)
  // The newest board decides, even when it is empty.
  assert.deepEqual(otherCount([here, withItems('old', 't3', 10, 3), withItems('new', 't3', 20, 0)], terminals, here), {
    count: 0,
    terminal: null,
  })
  // Equal times go by session id.
  assert.equal(otherCount([here, withItems('b', 't2', 10, 5), withItems('a', 't2', 10, 2)], terminals, here).count, 2)
})

test('otherCount: the terminal cycles through every other board, in address order, wrapping', () => {
  const one = (session, terminal) => board(session, terminal, { needs: [{ key: 'D1', kind: 'ask', text: 'q', isOpen: true }] })
  const terminals = ['t1', 't2', 't3', 't4'].map(a => term(a))
  const boards = ['t1', 't2', 't3', 't4'].map(t => one(`s-${t}`, t))
  const next = from =>
    otherCount(
      boards,
      terminals,
      boards.find(b => b.coordinator.terminal === from),
    ).terminal
  assert.equal(next('t1'), 't2')
  assert.equal(next('t2'), 't3')
  assert.equal(next('t3'), 't4')
  assert.equal(next('t4'), 't1', 'wraps')
  // Walking from board to board visits all of them.
  const seen = []
  for (let at = 't1', i = 0; i < 4; i++) seen.push(at), (at = next(at))
  assert.deepEqual(seen, ['t1', 't2', 't3', 't4'])
  // A shown board with no place in the order still gets the first one after it.
  const withGap = otherCount(boards, terminals, board('x', 't25'))
  assert.equal(withGap.terminal, 't3')
  // Boards with nothing open are skipped.
  const quiet = [boards[0], board('s-t2', 't2'), boards[2]]
  assert.equal(otherCount(quiet, terminals, boards[0]).terminal, 't3')
})

test('flashing: for 0.9 s x 4 after the first sighting, never for what was there at the start', () => {
  assert.equal(FLASH_MS, 3600)
  assert.equal(flashing('s:D7', 1000, 1000), true)
  assert.equal(flashing('s:D7', 1000, 1000 + FLASH_MS - 1), true)
  assert.equal(flashing('s:D7', 1000, 1000 + FLASH_MS), false)
  assert.equal(flashing('s:D7', 1000, 999), false, 'a clock that went back')
  assert.equal(flashing('s:D7', 0, 1790000000000), false, 'stamped 0 = there at the start')
  assert.equal(flashing('s:D7', undefined, 1000), false)
  assert.equal(flashing('', 1000, 1000), false)
})

test('observeArrivals: the first load is silent, later arrivals are stamped, gone items are dropped', () => {
  const b = full()
  const first = observeArrivals(null, [b], 5000)
  assert.ok(Object.keys(first).length === 5 && Object.values(first).every(at => at === 0))
  const added = { ...b, workers: [...b.workers, { name: 'w-new', state: 'blocked', note: 'stuck' }] }
  const key = `${b.session}:w:w-new`
  const second = observeArrivals(first, [added], 9000)
  assert.equal(second[key], 9000)
  assert.equal(second[`${b.session}:D7`], 0, 'a known item keeps its stamp')
  const third = observeArrivals(second, [b], 9500)
  assert.equal(key in third, false)
  assert.equal(flashing('x', second[key], 9500), true)
})

test('isUnseen: a late arrival stays unseen until selected; what was there at the start never is', () => {
  const known = { a: 9000, b: 0 }
  assert.equal(isUnseen('a', known, new Set()), true)
  assert.equal(isUnseen('a', known, new Set(['a'])), false)
  assert.equal(isUnseen('b', known, new Set()), false)
  assert.equal(isUnseen('c', known, new Set()), false)
})

test('observeArrivals: only a new blocked worker flashes; asks and dos arriving later do not', () => {
  const b = full()
  const first = observeArrivals(null, [b], 5000)
  const added = {
    ...b,
    workers: [...b.workers, { name: 'w-new', state: 'blocked', note: 'stuck' }],
    needs: [...b.needs, { key: 'D9', kind: 'ask', text: 'new', isOpen: true }, { key: 'T9', kind: 'do', text: 'new', isOpen: true }],
  }
  const next = observeArrivals(first, [added], 9000)
  assert.equal(next[`${b.session}:w:w-new`], 9000)
  assert.equal(next[`${b.session}:D9`], 0)
  assert.equal(next[`${b.session}:T9`], 0)
  assert.equal(anyFlashing(next, 9500), true)
  assert.equal(anyFlashing({ a: 0, b: 0 }, 9500), false)
  assert.equal(isUnseen(`${b.session}:D9`, next, new Set()), false)
  assert.equal(isUnseen(`${b.session}:w:w-new`, next, new Set()), true)
})

test('pickNumber: pick1..6 by command name, nothing else', () => {
  assert.equal(pickNumber('herdr-agents.pick3'), 3)
  assert.equal(pickNumber('pick6'), 6)
  assert.equal(pickNumber('herdr-agents.pick7'), null)
  assert.equal(pickNumber('herdr-agents.pick0'), null)
  assert.equal(pickNumber('herdr-agents.sheet'), null)
  assert.equal(pickNumber(undefined), null)
})

test('nextPick: a click on the selected tab deselects, a key never does', () => {
  const now = { session: 's', key: 'D7' }
  assert.deepEqual(nextPick(null, 's', 'D7', true), now)
  assert.equal(nextPick(now, 's', 'D7', true), null)
  assert.deepEqual(nextPick(now, 's', 'D7', false), now, 'a key keeps it selected')
  assert.deepEqual(nextPick(now, 's', 'D8', true), { session: 's', key: 'D8' })
  assert.deepEqual(nextPick(now, 'other', 'D7', true), { session: 'other', key: 'D7' }, 'same key on another board is another tab')
})
