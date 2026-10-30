import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { applyFile, boardId, debugLine, labelOf, openNeeds, resolveBoard } from '../mods/herdr-agents/model.js'

const board = (session, terminal, extra = {}) => ({
  session,
  at: 1000,
  cwd: '/work',
  coordinator: { terminal },
  workers: [],
  needs: [],
  ...extra,
})
const term = (address, extra = {}) => ({ address, state: 'live', agent: 'claude-code', labels: { 'herdr.space': 's1' }, ...extra })
const focus = (terminal, space = 's1') => ({ space, tab: 'a', terminal })

test('rule 1: a board whose coordinator terminal is gone, not live or not an agent is dropped', () => {
  const boards = [board('gone', 't9'), board('exited', 't2'), board('shell', 't3'), board('ok', 't1'), { session: 'old', at: 5, cwd: '/x' }]
  const terminals = [term('t1'), term('t2', { state: 'exited' }), term('t3', { agent: null })]
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
  assert.deepEqual(r.pick, { space: 's1', session: 'a' })
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
  const terminals = [term('t1'), term('t2'), term('t3', { labels: { 'herdr.space': 's2' } }), term('t5', { agent: null })]
  const r = resolveBoard(boards, terminals, focus('t5'))
  assert.deepEqual([r.board.session, r.via], ['new', 4])
  assert.equal(resolveBoard(boards, terminals, focus('t5', 's2')).board.session, 'other')
  assert.equal(resolveBoard(boards, terminals, focus(null)).board.session, 'new', 'a mod pane has no terminal')
})

test('rule 4: the board last picked by rule 2 or 3 in this space stays picked, and only in this space', () => {
  const boards = [board('old', 't1', { at: 1 }), board('new', 't2', { at: 2 })]
  const terminals = [term('t1'), term('t2'), term('t5', { agent: null })]
  const first = resolveBoard(boards, terminals, focus('t1'))
  const next = resolveBoard(boards, terminals, focus('t5'), first.pick)
  assert.equal(next.board.session, 'old')
  assert.equal(resolveBoard(boards, terminals, focus('t5', 's1'), { space: 's2', session: 'old' }).board.session, 'new')
  assert.equal(resolveBoard(boards, terminals, focus('t5'), { space: 's1', session: 'gone' }).board.session, 'new')
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

test('/clear or resume leaves two session files for one terminal: the newest, then the same one', () => {
  const boards = [board('before', 't1', { at: 1 }), board('after', 't1', { at: 2 })]
  assert.equal(resolveBoard(boards, [term('t1')], focus('t1')).board.session, 'after')
  assert.equal(resolveBoard([...boards].reverse(), [term('t1')], focus('t1')).board.session, 'after')
})

test('labelOf reads an object, "k=v" strings and {key, value} items', () => {
  assert.equal(labelOf({ labels: { a: 'x' } }, 'a'), 'x')
  assert.equal(labelOf({ labels: ['a=x', 'b=y=z'] }, 'b'), 'y=z')
  assert.equal(labelOf({ labels: [{ key: 'a', value: 'x' }] }, 'a'), 'x')
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
