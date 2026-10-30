import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  aliveBoards,
  applyFile,
  boardId,
  debugLine,
  labelOf,
  listOrder,
  openNeeds,
  orchestratorSection,
  resolveBoard,
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

// --- S12: the agents list's Orchestrators section ---

const agent = (address, status = 'idle') => ({ address, status, seq: 1 })

test("S12: an agent is an orchestrator when its address is a live board's coordinator terminal", () => {
  const boards = [board('a', 't1'), board('b', 't3')]
  const terminals = [term('t1'), term('t2'), term('t3', { state: 'exited' })]
  const r = orchestratorSection([agent('t1'), agent('t2'), agent('t3')], boards, terminals)
  assert.deepEqual(
    r.orchestrators.map(a => a.address),
    ['t1'],
  )
})

test('S12: workers of a board and boards without the field are not orchestrators', () => {
  const boards = [board('a', 't1', { workers: [{ name: 'w-api' }] }), { session: 'old', at: 1 }]
  const terminals = [term('t1'), term('t7', { name: 'w-api' })]
  assert.deepEqual(
    orchestratorSection([agent('t1'), agent('t7')], boards, terminals).orchestrators.map(a => a.address),
    ['t1'],
  )
})

test('S12: a state change keeps the row in the section and the order', () => {
  const boards = [board('a', 't1'), board('b', 't2')]
  const terminals = [term('t1'), term('t2')]
  for (const status of ['idle', 'working', 'blocked', 'done']) {
    const r = orchestratorSection(
      [agent('t1', status), agent('t5', 'blocked'), agent('t2', status === 'idle' ? 'blocked' : 'idle')],
      boards,
      terminals,
    )
    assert.deepEqual(
      r.orchestrators.map(a => a.address),
      ['t1', 't2'],
      status,
    )
  }
})

test('S12: orchestrators keep agents() order when the sort reverses them', () => {
  const natural = [agent('t1', 'idle'), agent('t2', 'idle'), agent('t5', 'idle')]
  const sorted = [natural[1], natural[2], natural[0]]
  const boards = [board('a', 't1'), board('b', 't2')]
  const terminals = ['t1', 't2', 't5'].map(a => term(a))
  const r = listOrder(sorted, boards, terminals, [], natural)
  assert.deepEqual(
    r.orchestrators.map(a => a.address),
    ['t1', 't2'],
  )
  assert.deepEqual(
    r.list.map(a => a.address),
    ['t1', 't2', 't5'],
  )
})

test('S12: a pinned orchestrator shows once, in the section', () => {
  const sorted = [agent('t5'), agent('t1'), agent('t6')]
  const r = listOrder(sorted, [board('a', 't1')], [term('t1'), term('t5'), term('t6')], ['t1', 't6'])
  assert.deepEqual(
    r.list.map(a => a.address),
    ['t1', 't6', 't5'],
  )
  assert.deepEqual(
    r.pinned.map(a => a.address),
    ['t6'],
  )
  assert.deepEqual(
    r.orchestrators.map(a => a.address),
    ['t1'],
  )
})

test('S12: orchestrators, then pinned in pin order, then the rest in the given order; stale pins are skipped', () => {
  const sorted = [agent('t5'), agent('t1'), agent('t6'), agent('t2')]
  const boards = [board('a', 't1'), board('b', 't2')]
  const terminals = ['t1', 't2', 't5', 't6'].map(a => term(a))
  const r = listOrder(sorted, boards, terminals, ['t6', 'gone', 't5'])
  assert.deepEqual(
    r.list.map(a => a.address),
    ['t1', 't2', 't6', 't5'],
  )
  assert.deepEqual(r.rest, [])
  const none = listOrder(sorted, boards, terminals, [])
  assert.deepEqual(
    none.rest.map(a => a.address),
    ['t5', 't6'],
  )
})

test('S12: with no board the list matches the shipped order (pinned, then the rest)', () => {
  const sorted = [agent('t1'), agent('t2', 'working'), agent('t3')]
  const terminals = [term('t1'), term('t2'), term('t3')]
  for (const boards of [[], undefined]) {
    const r = listOrder(sorted, boards, terminals, ['t3'])
    assert.deepEqual(r.orchestrators, [])
    assert.deepEqual(
      r.list.map(a => a.address),
      ['t3', 't1', 't2'],
    )
    assert.deepEqual(listOrder(sorted, boards, terminals, []).list, sorted)
  }
  assert.deepEqual(listOrder(undefined, [], []).list, [])
})

test('S12: with no board the section is empty', () => {
  const list = [agent('t1'), agent('t2', 'working')]
  assert.deepEqual(orchestratorSection(list, [], [term('t1'), term('t2')]), { orchestrators: [] })
  assert.deepEqual(orchestratorSection(list, undefined, undefined).orchestrators, [])
})

test("S12: a remote terminal's address carries its machine, so a local board does not match it", () => {
  const r = orchestratorSection([agent('t1'), agent('vps/t1')], [board('a', 't1')], [term('t1'), term('vps/t1')])
  assert.deepEqual(
    r.orchestrators.map(a => a.address),
    ['t1'],
  )
  const remote = orchestratorSection([agent('vps/t1')], [board('a', 'vps/t1')], [term('vps/t1')])
  assert.deepEqual(
    remote.orchestrators.map(a => a.address),
    ['vps/t1'],
  )
})

test("S12: aliveBoards is the resolver's rule 1", () => {
  const boards = [board('gone', 't9'), board('shell', 't3'), board('ok', 't1')]
  const terminals = [term('t1'), term('t3', { program: { agent: false } })]
  assert.deepEqual(
    aliveBoards(boards, terminals).map(b => b.session),
    ['ok'],
  )
})

test('S12: a terminal labelled as a worker is never a coordinator, even with a leftover board', () => {
  const boards = [board('old', 't1')]
  const terminals = [term('t1', { labels: { 'herdr-agents.role': 'worker' } })]
  assert.deepEqual(aliveBoards(boards, terminals), [])
  assert.deepEqual(orchestratorSection([agent('t1')], boards, terminals).orchestrators, [])
  assert.equal(resolveBoard(boards, terminals, focus('t1')).board, null)
})
