import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  SENT_HIDE_MS,
  UNDO_MS,
  ageText,
  applyFile,
  boardId,
  cancelAction,
  currentPin,
  debugLine,
  deriveBar,
  doneAction,
  actionFile,
  hiddenKeys,
  labelOf,
  markRead,
  newBarState,
  newPinIds,
  openNeeds,
  pinbarMode,
  pins,
  pruneRead,
  queueAction,
  readKey,
  resolveBoard,
  segments,
  settleSent,
  slimLine,
  takeDue,
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

// ---- S4: pin bar ----

const know = (key, extra = {}) => ({ key, kind: 'know', isOpen: true, at: 100, from: 'w-api', text: `${key} text`, ...extra })
const pinBoard = (needs, session = 's') => ({ session, needs })

test('pins are the open know items, in board order; ask, do and closed ones are not pins', () => {
  const b = pinBoard([
    know('K1'),
    { key: 'D1', kind: 'ask', isOpen: true },
    { key: 'T1', kind: 'do', isOpen: true },
    know('K2', { isOpen: false }),
    know('K3'),
  ])
  assert.deepEqual(
    pins(b).map(p => p.key),
    ['K1', 'K3'],
  )
  assert.deepEqual(pins(null), [])
})

test('pin fields fall back: title from the first line of text, summary from the rest, no tag, key as the last title', () => {
  const [a, b, c, d, e] = pins(
    pinBoard([
      know('K1', { title: 'Retry budget', text: 'Retries 3 times.\nThen gives up.', tag: ' infra ' }),
      know('K2', { text: 'Index added\nTakes 4 s.\nSafe.' }),
      know('K3', { text: '', title: undefined }),
      know('K4', { title: 'T', summary: 'Short', text: 'long text' }),
      know('K5', { text: 'One line only' }),
    ]),
  )
  assert.equal(a.title, 'Retry budget')
  assert.equal(a.summary, 'Retries 3 times. Then gives up.')
  assert.equal(a.tag, 'infra')
  assert.equal(b.title, 'Index added')
  assert.equal(b.summary, 'Takes 4 s. Safe.')
  assert.equal(b.tag, null)
  assert.equal(c.title, 'K3')
  assert.equal(c.summary, '')
  assert.equal(d.summary, 'Short')
  assert.equal(e.title, 'One line only')
  assert.equal(e.summary, '')
  assert.equal(a.who, 'w-api')
})

test('unread comes from the read map; hidden keys are left out', () => {
  const b = pinBoard([know('K1'), know('K2')])
  const read = { [readKey('s', 'K1')]: true }
  assert.deepEqual(
    pins(b, read).map(p => p.unread),
    [false, true],
  )
  assert.deepEqual(
    pins(b, read, new Set([readKey('s', 'K2')])).map(p => p.key),
    ['K1'],
  )
})

test('currentPin: the newest unread; the later one on equal times; a picked pin while it exists', () => {
  const b = pinBoard([know('K1', { at: 300 }), know('K2', { at: 200 }), know('K3', { at: 300 })])
  assert.equal(currentPin(pins(b)).key, 'K3', 'equal at: the later in board order')
  const read = { [readKey('s', 'K3')]: true, [readKey('s', 'K1')]: true }
  assert.equal(currentPin(pins(b, read)).key, 'K2', 'read ones are skipped')
  assert.equal(currentPin(pins(b, read), readKey('s', 'K1')).key, 'K1', 'picked, though read')
  assert.equal(currentPin(pins(b), readKey('s', 'gone')).key, 'K3', 'a picked pin that is gone falls back')
})

test('pinbarMode: empty without pins, slim when all read, full otherwise or when one is picked', () => {
  assert.equal(pinbarMode(pins(pinBoard([]))), 'empty')
  assert.equal(pinbarMode(pins(pinBoard([{ key: 'D1', kind: 'ask', isOpen: true }]))), 'empty')
  const b = pinBoard([know('K1'), know('K2')])
  const all = { [readKey('s', 'K1')]: true, [readKey('s', 'K2')]: true }
  assert.equal(pinbarMode(pins(b, all)), 'slim')
  assert.equal(pinbarMode(pins(b, { [readKey('s', 'K1')]: true })), 'full')
  assert.equal(pinbarMode(pins(b, all), readKey('s', 'K1')), 'full')
})

test('slimLine: count, nothing new, last title', () => {
  const b = pinBoard([know('K1', { title: 'Old', at: 1 }), know('K2', { title: 'New', at: 2 })])
  assert.equal(slimLine(pins(b)), '2 pins · nothing new · last: New')
  assert.equal(slimLine(pins(pinBoard([know('K1', { title: 'Only' })]))), '1 pin · nothing new · last: Only')
  assert.equal(slimLine([]), '')
})

test('segments mark the current, unread and read pins in board order', () => {
  const b = pinBoard([know('K1', { at: 1 }), know('K2', { at: 3 }), know('K3', { at: 2 })])
  const list = pins(b, { [readKey('s', 'K1')]: true })
  assert.deepEqual(
    segments(list, currentPin(list)).map(s => s.kind),
    ['read', 'current', 'unread'],
  )
})

test('newPinIds: nothing is new on the first call; later ones are the ids not seen before', () => {
  const list = pins(pinBoard([know('K1'), know('K2')]))
  assert.deepEqual(newPinIds(null, list), [])
  assert.deepEqual(newPinIds(new Set([readKey('s', 'K1')]), list), [readKey('s', 'K2')])
})

test('ageText: now, minutes, hours, days', () => {
  assert.equal(ageText(1000, 1000 + 30_000), 'now')
  assert.equal(ageText(0, 5000), '')
  assert.equal(ageText(1000, 1000 + 5 * 60_000), '5m')
  assert.equal(ageText(1000, 1000 + 3 * 3_600_000), '3h')
  assert.equal(ageText(1000, 1000 + 2 * 86_400_000), '2d')
})

test('pruneRead drops marks of sessions with no board and keeps the same object when nothing goes', () => {
  const read = { 'a:K1': true, 'b:K1': true }
  const next = pruneRead(read, [{ session: 'a' }])
  assert.deepEqual(next, { 'a:K1': true })
  assert.equal(pruneRead(read, [{ session: 'a' }, { session: 'b' }]), read)
  assert.equal(markRead(read, 'a:K1'), read)
  assert.deepEqual(markRead(read, 'a:K2'), { 'a:K1': true, 'b:K1': true, 'a:K2': true })
})

test('done action and action file name', () => {
  assert.deepEqual(doneAction('K3'), { action: 'done', key: 'K3' })
  assert.ok(actionFile(5, 'x').localeCompare(actionFile(10, 'a')) < 0, 'names sort by time')
  assert.match(actionFile(1790000000000, 'ab12'), /^1790000000000-ab12\.json$/)
})

test('undo window: an action goes out only after UNDO_MS (5 s); undo before that removes it', () => {
  assert.equal(UNDO_MS, 5000)
  let q = queueAction([], { id: 'f1', session: 's', action: doneAction('K1'), now: 1000 })
  q = queueAction(q, { id: 'f2', session: 's', action: doneAction('K2'), now: 3000 })
  assert.equal(takeDue(q, 5999).due.length, 0, 'not at 4.999 s')
  assert.deepEqual(
    takeDue(q, 6000).due.map(x => x.id),
    ['f1'],
  )
  assert.deepEqual(
    takeDue(q, 8000).due.map(x => x.id),
    ['f1', 'f2'],
  )
  assert.deepEqual(
    takeDue(q, 6000).rest.map(x => x.id),
    ['f2'],
  )
  const undone = cancelAction(q, 'f1')
  assert.deepEqual(
    takeDue(undone, 9000).due.map(x => x.id),
    ['f2'],
    'f1 never goes out',
  )
})

test('hiddenKeys: queued and sent items are hidden; settleSent keeps them until the board shows the outcome or the item closed', () => {
  const queue = queueAction([], { id: 'f1', session: 's', action: doneAction('K1'), now: 0 })
  const sent = [{ id: 'f0', session: 's', key: 'K2' }]
  assert.deepEqual([...hiddenKeys(queue, sent)].sort(), ['s:K1', 's:K2'])

  const open = pinBoard([know('K2')])
  assert.deepEqual(settleSent(sent, [open]), { sent, failed: [] }, 'still open, no outcome: keep hiding')
  assert.deepEqual(settleSent(sent, [pinBoard([know('K2', { isOpen: false })])]), { sent: [], failed: [] }, 'closed: settled')
  assert.deepEqual(settleSent(sent, []), { sent: [], failed: [] }, 'board gone')
  const failed = { ...open, actions: [{ id: 'f0', ok: false, message: 'no such item' }] }
  assert.deepEqual(
    settleSent(sent, [failed]),
    { sent: [], failed: [{ id: 'f0', message: 'no such item' }] },
    'ok:false is reported and un-hidden',
  )
  const ok = { ...open, actions: [{ id: 'f0', ok: true, message: '' }] }
  assert.deepEqual(settleSent(sent, [ok]), { sent: [], failed: [] })
})

test('real plugin shape: title equal to text counts as no title; title is first line, summary the rest, never twice', () => {
  const text = 'Index added\nTakes 4 s.\nSafe.'
  const [a, b] = pins(pinBoard([know('K1', { title: text, text }), know('K2', { title: 'One line', text: 'One line' })]))
  assert.equal(a.title, 'Index added')
  assert.equal(a.summary, 'Takes 4 s. Safe.')
  assert.equal(b.title, 'One line')
  assert.equal(b.summary, '')
})

test('a title is always one line, also when given and different from the text', () => {
  const [a] = pins(pinBoard([know('K1', { title: 'Head\nmore', text: 'Body' })]))
  assert.equal(a.title, 'Head')
  assert.equal(a.summary, 'Body')
})

test('hiddenKeys: a sent action stops hiding its item after SENT_HIDE_MS; queued ones keep hiding', () => {
  const sent = [{ id: 'f0', session: 's', key: 'K2', at: 1000 }]
  const queue = queueAction([], { id: 'f1', session: 's', action: doneAction('K1'), now: 0 })
  assert.deepEqual([...hiddenKeys(queue, sent, 1000 + SENT_HIDE_MS - 1)].sort(), ['s:K1', 's:K2'])
  assert.deepEqual([...hiddenKeys(queue, sent, 1000 + SENT_HIDE_MS)].sort(), ['s:K1'])
})

const bar = (prev, board, extra = {}) => deriveBar(prev, board, { now: 1000, ...extra })

test('deriveBar: no board is the empty view and keeps the state', () => {
  const s = newBarState()
  const r = bar(s, null)
  assert.equal(r.view.mode, 'empty')
  assert.equal(r.state, s)
})

test('deriveBar: a pin flashes once; the same pin does not flash again', () => {
  const b = pinBoard([know('K1')])
  const r1 = bar(newBarState(), b)
  assert.equal(r1.flashStart, 's:K1')
  assert.equal(bar(r1.state, b).flashStart, null)
  assert.equal(bar(r1.state, pinBoard([know('K1'), know('K2', { at: 200 })])).flashStart, 's:K2')
})

test('deriveBar: a read pin or the slim bar does not flash', () => {
  const b = pinBoard([know('K1')])
  assert.equal(bar(newBarState(), b, { read: { 's:K1': true } }).flashStart, null)
})

test('deriveBar: the selection resets on a new board and when a new pin arrives, not otherwise', () => {
  const b = pinBoard([know('K1'), know('K2')])
  const picked = { ...bar(newBarState(), b).state, sel: 's:K1' }
  assert.equal(bar(picked, b).state.sel, 's:K1', 'kept')
  const away = bar(picked, pinBoard([], 'other'))
  assert.equal(away.state.sel, null, 'other board')
  assert.equal(bar(away.state, b).state.sel, null, 'back on the first board the old pick is not revived')
  assert.equal(bar(picked, pinBoard([know('K1'), know('K2'), know('K3')])).state.sel, null, 'new pin')
})

test('deriveBar: the first draw of a board never resets by "new pins"; waiting titles come from the key', () => {
  const b = pinBoard([know('K1', { title: 'Retry' })])
  const waiting = [
    { id: 'f1', session: 's', key: 'K1' },
    { id: 'f2', session: 's', key: 'Zed' },
    { id: 'f3', session: 'x', key: 'K1' },
  ]
  const r = bar(newBarState(), b, { waiting, hidden: new Set(['s:K1']) })
  assert.deepEqual(r.view.waiting, [
    { id: 'f1', title: 'Retry' },
    { id: 'f2', title: 'Zed' },
  ])
  assert.equal(r.view.mode, 'empty', 'hidden pins are left out')
  assert.equal(bar(newBarState(), b, { now: 100 + 5 * 60000 }).view.meta, 'w-api · 5m')
})
