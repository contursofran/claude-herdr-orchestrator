import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Arrivals } from '../mods/herdr-agents/arrivals.js'
import {
  FLASH_MS,
  coreIdOf,
  heartbeat,
  localCoordinators,
  SENT_HIDE_MS,
  UNDO_MS,
  actionFile,
  ageText,
  aliveBoards,
  anyFlashing,
  applyFile,
  boardId,
  boardIdIn,
  cancelAction,
  counts,
  currentPin,
  debugLine,
  deriveBar,
  doneAction,
  emptyLine,
  flashing,
  hiddenKeys,
  isUnseen,
  keyStep,
  labelOf,
  listOrder,
  markRead,
  newBarState,
  arrivalNotice,
  newArrivals,
  newPinIds,
  nextPick,
  observeArrivals,
  openNeeds,
  orchestratorSection,
  otherCount,
  pickAt,
  pickNumber,
  pinStepDir,
  pinbarMode,
  pins,
  pruneRead,
  queueAction,
  readKey,
  resolveBoard,
  segments,
  settleSent,
  slimLine,
  stepPin,
  stripItems,
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

test('boardIdIn: a path under the resolved folder (/tmp is /private/tmp) still gives the id', () => {
  const dirs = ['/tmp/h/board', '/private/tmp/h/board']
  assert.equal(boardIdIn(dirs, '/private/tmp/h/board/abc.json'), 'abc')
  assert.equal(boardIdIn(dirs, '/tmp/h/board/abc.json'), 'abc')
  assert.equal(boardIdIn(dirs, '/private/tmp/h/board/abc.actions/1-x.json'), null)
  assert.equal(boardIdIn(dirs, '/elsewhere/abc.json'), null)
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

test('pins are the open know and do items, in board order; ask and closed ones are not pins', () => {
  const b = pinBoard([
    know('K1'),
    { key: 'D1', kind: 'ask', isOpen: true },
    { key: 'T1', kind: 'do', isOpen: true },
    know('K2', { isOpen: false }),
    know('K3'),
  ])
  assert.deepEqual(
    pins(b).map(p => p.key),
    ['K1', 'T1', 'K3'],
  )
  assert.deepEqual(
    pins(b).map(p => p.kind),
    ['know', 'do', 'know'],
  )
  assert.deepEqual(pins(null), [])
})

test('a board with only a to-do has a pin: the bar is not empty, can go slim once read, and the strip keeps the tab', () => {
  const b = pinBoard([{ key: 'T1', kind: 'do', isOpen: true, text: 'Merge #7', at: 5 }])
  assert.equal(pinbarMode(pins(b)), 'full')
  assert.equal(pinbarMode(pins(b, { [readKey('s', 'T1')]: true })), 'slim', 'a read to-do counts as read')
  assert.equal(slimLine(pins(b, { [readKey('s', 'T1')]: true })), '1 pin · nothing new · last: Merge #7')
  assert.deepEqual(
    stripItems(b).map(i => i.key),
    ['T1'],
    'the strip tab stays',
  )
  assert.equal(deriveBar(newBarState(), b).view.mode, 'full')
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

test("S6: the heartbeat lists live local coordinators only: another machine's t4 is not this machine's t4", () => {
  const boards = [board('a', 't1'), board('b', 'vps/t4'), board('c', 't1'), board('d', 't9'), board('e', 't3')]
  const terminals = [term('t1'), term('vps/t4'), term('t3', { program: { agent: false } })]
  assert.deepEqual(localCoordinators(boards, terminals), ['t1'])
  assert.deepEqual(JSON.parse(heartbeat(boards, terminals, 5000)), { at: 5000, terminals: ['t1'] })
  assert.deepEqual(JSON.parse(heartbeat([], [], 7)), { at: 7, terminals: [] })
  // The core's id rides along when known; a missing one is left out.
  assert.deepEqual(JSON.parse(heartbeat(boards, terminals, 5, 'c1')), { at: 5, terminals: ['t1'], core: 'c1' })
  assert.equal(coreIdOf('{"core":{"id":"c1","name":"x"}}'), 'c1')
  assert.equal(coreIdOf('{"core":{}}'), '')
  assert.equal(coreIdOf('nope'), '')
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

test('stepPin moves to the next or previous pin and wraps; with fewer than two there is nowhere to go', () => {
  const list = pins(pinBoard([know('K1'), know('K2'), know('K3')]))
  const id = k => readKey('s', k)
  assert.equal(stepPin(list, list[0], 1), id('K2'))
  assert.equal(stepPin(list, list[2], 1), id('K1'), 'next wraps to the first')
  assert.equal(stepPin(list, list[0], -1), id('K3'), 'previous wraps to the last')
  assert.equal(stepPin(list, null, 1), id('K2'), 'no current counts as the first')
  assert.equal(stepPin(list.slice(0, 1), list[0], 1), null)
  assert.equal(stepPin([], null, -1), null)
})

test('pinStepDir reads the key commands', () => {
  assert.equal(pinStepDir('herdr-agents.nextpin'), 1)
  assert.equal(pinStepDir('herdr-agents.prevpin'), -1)
  assert.equal(pinStepDir('herdr-agents.pick1'), null)
})

test('emptyLine: No pins, then what is working; zeros and a missing summary leave it out', () => {
  assert.equal(emptyLine({ summary: { busy: 2 } }), 'No pins · 2 working')
  assert.equal(emptyLine({ summary: { busy: 0 } }), 'No pins')
  assert.equal(emptyLine({}), 'No pins')
})

test('deriveBar tells the bar about several pins and carries the empty line', () => {
  const two = deriveBar(newBarState(), { ...pinBoard([know('K1'), know('K2')]), summary: { busy: 1 } })
  assert.equal(two.view.many, true)
  assert.equal(two.view.segments[0].title.length > 0, true)
  const one = deriveBar(newBarState(), pinBoard([know('K1')]))
  assert.equal(one.view.many, false)
  const none = deriveBar(newBarState(), { ...pinBoard([]), summary: { busy: 2 } })
  assert.equal(none.view.empty, 'No pins · 2 working')
})

test('keyStep: moves from the pin shown, marks it read, and a second press before the redraw moves on', () => {
  const list = pins(pinBoard([know('K1'), know('K2'), know('K3')]))
  const marked = []
  const shown = { mode: 'full', list, current: list[0] }
  const one = keyStep(shown, 1, id => marked.push(id))
  assert.equal(one.sel, list[1].id)
  assert.deepEqual(marked, [list[1].id], 'the pin moved to is marked read')
  const two = keyStep(one.shown, 1, id => marked.push(id))
  assert.equal(two.sel, list[2].id, 'two presses before a redraw move two pins')
  assert.deepEqual(marked, [list[1].id, list[2].id])
})

test('keyStep does nothing, and marks nothing, unless the row shows a full or slim pin bar', () => {
  const list = pins(pinBoard([know('K1'), know('K2')]))
  const marked = []
  for (const mode of ['undo', 'empty'])
    assert.equal(
      keyStep({ mode, list, current: list[0] }, 1, id => marked.push(id)),
      null,
      mode,
    )
  assert.equal(
    keyStep(null, 1, id => marked.push(id)),
    null,
    'no board',
  )
  assert.equal(
    keyStep({ mode: 'full', list: list.slice(0, 1), current: list[0] }, 1, id => marked.push(id)),
    null,
    'one pin',
  )
  assert.deepEqual(marked, [])
})

test('keyStep from the slim row (2+ pins, all read) starts at the newest pin, the one a click on the row opens', () => {
  const read = ['K1', 'K2', 'K3'].reduce((r, k) => markRead(r, readKey('s', k)), {})
  const list = pins(pinBoard([know('K1', { at: 100 }), know('K2', { at: 300 }), know('K3', { at: 200 })]), read)
  assert.equal(pinbarMode(list), 'slim')
  const shown = { mode: 'slim', list, current: null }
  // The newest is K2 (list index 1): next is K3, previous is K1. From the first pin they would be K2 and K3.
  assert.equal(keyStep(shown, 1, () => {}).sel, readKey('s', 'K3'))
  assert.equal(keyStep(shown, -1, () => {}).sel, readKey('s', 'K1'))
})

// ---- S10: sound and notification ----

const needsBoard = (...needs) => ({
  session: 's1',
  coordinator: { terminal: 't4' },
  needs: needs.map(([key, kind, isOpen = true]) => ({ key, kind, isOpen, text: `text ${key}\nmore` })),
  workers: [{ name: 'w', state: 'blocked', note: 'stuck' }],
})

test('newArrivals: the first sight of a board is silent', () => {
  const r = newArrivals(null, needsBoard(['D1', 'ask'], ['P1', 'know']))
  assert.deepEqual(r.fresh, [])
  assert.deepEqual([...r.keys].sort(), ['D1', 'P1'])
})

test('newArrivals: a later know, do or ask is new; closed items and blocked workers are not', () => {
  const first = newArrivals(null, needsBoard(['D1', 'ask']))
  const r = newArrivals(first.keys, needsBoard(['D1', 'ask'], ['D2', 'ask'], ['P1', 'know'], ['T1', 'do'], ['P2', 'know', false]))
  assert.deepEqual(
    r.fresh.map(f => [f.key, f.kind, f.text]),
    [
      ['D2', 'ask', 'text D2'],
      ['P1', 'know', 'text P1'],
      ['T1', 'do', 'text T1'],
    ],
  )
})

test('newArrivals: a reread with the same keys fires nothing', () => {
  const b = needsBoard(['D1', 'ask'], ['P1', 'know'])
  assert.deepEqual(newArrivals(newArrivals(null, b).keys, b).fresh, [])
})

test('arrivalNotice: none, one, and several make one notice', () => {
  assert.equal(arrivalNotice([{ terminal: 't4', fresh: [] }]), null)
  const one = [{ key: 'D2', kind: 'ask', text: 'Ship it?' }]
  assert.deepEqual(arrivalNotice([{ terminal: 't4', fresh: one }]), { title: 'New question', body: 'Ship it?', terminal: 't4' })
  const pin = [{ key: 'P1', kind: 'know', text: 'Note' }]
  assert.deepEqual(arrivalNotice([{ terminal: 't4', fresh: pin }]).title, 'New pin')
  const many = arrivalNotice([
    { terminal: 't7', fresh: [...one, ...pin] },
    { terminal: 't9', fresh: pin },
  ])
  assert.deepEqual(many, { title: '3 new items', body: '1 question, 2 pins', terminal: 't7' })
  const todo = [{ key: 'T1', kind: 'do', text: 'Merge' }]
  assert.deepEqual(arrivalNotice([{ terminal: 't4', fresh: todo }]).title, 'New to-do')
  assert.equal(arrivalNotice([{ terminal: 't4', fresh: [...todo, ...pin] }]).body, '1 to-do, 1 pin')
})

test('Arrivals: a to-do and a pin made together sound and post once; the same to-do again is silent', () => {
  const calls = []
  const a = new Arrivals({ play: s => calls.push(['play', s]), post: n => calls.push(['post', n.title]) })
  a.observe([needsBoard(['D1', 'ask'])])
  a.observe([needsBoard(['D1', 'ask'], ['T1', 'do'], ['P1', 'know'])])
  assert.deepEqual(calls, [
    ['play', 'done'],
    ['post', '2 new items'],
  ])
  calls.length = 0
  a.observe([needsBoard(['D1', 'ask'], ['T1', 'do'], ['P1', 'know'])])
  assert.deepEqual(calls, [])
})

test('Arrivals: silent first sight, one sound and notice per change, a returning board is silent', () => {
  const calls = []
  const a = new Arrivals({ play: s => calls.push(['play', s]), post: n => calls.push(['post', n]) })
  const b1 = needsBoard(['D1', 'ask'])
  a.observe([b1])
  assert.deepEqual(calls, [])
  a.observe([needsBoard(['D1', 'ask'], ['P1', 'know'], ['D2', 'ask'])])
  assert.deepEqual(calls, [
    ['play', 'done'],
    ['post', { title: '2 new items', body: '1 question, 1 pin', action: { name: 'pane.focus', args: { terminal: 't4' } } }],
  ])
  calls.length = 0
  a.observe([]) // file gone
  a.observe([needsBoard(['D1', 'ask'], ['P1', 'know'], ['D2', 'ask'])]) // and back
  a.observe([needsBoard(['D1', 'ask'], ['P1', 'know'], ['D2', 'ask'])])
  assert.deepEqual(calls, [])
  // keys are kept while the file is gone: an item that arrived meanwhile still fires on return
  a.observe([])
  a.observe([needsBoard(['D1', 'ask'], ['P1', 'know'], ['D2', 'ask'], ['D3', 'ask'])])
  assert.equal(calls.length, 2)
  calls.length = 0
  a.observe([needsBoard(['D1', 'ask'], ['P1', 'know'], ['D2', 'ask'], ['D3', 'ask'])])
  // a board seen for the first time later is silent too, while another board's arrival fires
  const other = { ...needsBoard(['X1', 'ask']), session: 's2', coordinator: { terminal: 't9' } }
  a.observe([needsBoard(['D1', 'ask'], ['P1', 'know'], ['D2', 'ask']), other])
  assert.deepEqual(calls, [])
  a.observe([
    needsBoard(['D1', 'ask'], ['P1', 'know'], ['D2', 'ask']),
    { ...other, needs: [...other.needs, { key: 'X2', kind: 'know', isOpen: true, text: 'Hi' }] },
  ])
  assert.equal(calls[1][1].action.args.terminal, 't9')
  assert.equal(calls[1][1].title, 'New pin')
})

test('Arrivals: a click goes to the first board with a terminal; with none the notice has no action', () => {
  const posts = []
  const a = new Arrivals({ play: () => {}, post: n => posts.push(n) })
  const none = (...needs) => ({ ...needsBoard(...needs), session: 'a', coordinator: { terminal: null } })
  const t9 = (...needs) => ({ ...needsBoard(...needs), session: 'b', coordinator: { terminal: 't9' } })
  a.observe([none(['A1', 'ask']), t9(['B1', 'ask'])])
  a.observe([none(['A1', 'ask'], ['A2', 'ask']), t9(['B1', 'ask'], ['B2', 'ask'])])
  assert.deepEqual(posts.at(-1).action, { name: 'pane.focus', args: { terminal: 't9' } })
  a.observe([none(['A1', 'ask'], ['A2', 'ask'], ['A3', 'ask']), t9(['B1', 'ask'], ['B2', 'ask'])])
  assert.deepEqual(posts.at(-1), { title: 'New question', body: 'text A3' })
})

test('Arrivals: a board with no session is skipped', () => {
  const calls = []
  const a = new Arrivals({ play: s => calls.push(s), post: n => calls.push(n) })
  const { session, ...nameless } = needsBoard(['D1', 'ask'])
  a.observe([nameless])
  a.observe([{ ...nameless, needs: [...nameless.needs, { key: 'D2', kind: 'ask', isOpen: true, text: 'Hi' }] }])
  assert.deepEqual(calls, [])
})

test('parkedNote: a worker parked on WAIT.json shows what it waits for; finished, blocked and unknown ones show nothing', async () => {
  const { parkedNote } = await import('../mods/herdr-agents/model.js')
  const boards = [
    {
      workers: [
        { name: 'w-park', state: 'waiting', note: '02:13 · PR checks\nmore' },
        { name: 'w-done', state: 'reported', note: 'x' },
        { name: 'w-stuck', state: 'blocked', note: 'x' },
        { name: 'w-bare', state: 'waiting' },
      ],
    },
  ]
  const terminals = [
    { address: 't1', name: 'w-park' },
    { address: 't2', name: 'w-done' },
    { address: 't3', name: 'w-stuck' },
    { address: 't4', name: 'w-bare' },
  ]
  assert.equal(parkedNote(boards, terminals, 't1'), 'PR checks')
  assert.equal(parkedNote(boards, terminals, 't2'), null)
  assert.equal(parkedNote(boards, terminals, 't3'), null)
  assert.equal(parkedNote(boards, terminals, 't4'), 'waiting')
  assert.equal(parkedNote(boards, terminals, 't9'), null)
  assert.equal(parkedNote(undefined, undefined, 't1'), null)
})

test('parkedNote: a board with `since` keeps its note whole; an older board loses the clock in front', async () => {
  const { parkedNote } = await import('../mods/herdr-agents/model.js')
  const terms = [{ address: 'a', name: 'w' }]
  const with_ = w => [{ workers: [{ name: 'w', state: 'waiting', ...w }] }]
  assert.equal(parkedNote(with_({ note: 'PR checks', since: 5 }), terms, 'a'), 'PR checks')
  assert.equal(parkedNote(with_({ note: '10:30 · standup', since: 5 }), terms, 'a'), '10:30 · standup')
  assert.equal(parkedNote(with_({ note: '02:13 · PR checks' }), terms, 'a'), 'PR checks')
  assert.equal(parkedNote(with_({ note: '02:13 · PR checks', since: null }), terms, 'a'), 'PR checks')
})

test('drawnKey: each copy changes only with what it draws', async () => {
  const { drawnKey } = await import('../mods/herdr-agents/model.js')
  const base = {
    session: 's',
    at: 1,
    coordinator: { terminal: 't' },
    workers: [{ name: 'w', state: 'waiting', note: 'CI', since: 5, startedAt: 1 }],
    tasks: [{ key: 'k', who: { text: 'w 1m' } }],
    needs: [],
  }
  const other = { ...base, session: 'o' }
  const key = (role, b, session) => drawnKey(role, b, session, role === 'sheet' ? { session: 's' } : null)
  for (const role of ['agents', 'board', 'sheet', 'pinbar', 'strip', 'card']) {
    assert.equal(key(role, [{ ...base, at: 2 }], 's'), key(role, [base], 's'), `${role}: the time of a write draws nothing`)
  }
  // A task row's minute: only the pop-up draws those.
  const minute = { ...base, tasks: [{ key: 'k', who: { text: 'w 2m' } }] }
  assert.notEqual(key('board', [minute], 's'), key('board', [base], 's'))
  for (const role of ['agents', 'pinbar', 'strip', 'card']) assert.equal(key(role, [minute], 's'), key(role, [base], 's'), role)
  // The sheet lists the tasks waiting on an item, so a task row's text counts there too.
  assert.notEqual(key('sheet', [minute], 's'), key('sheet', [base], 's'))
  assert.equal(key('sheet', [{ ...base, at: 2 }], 's'), key('sheet', [base], 's'))
  // The strip sizes the pop-up from the number of rows.
  const added = { ...base, tasks: [...base.tasks, { key: 'k2' }] }
  assert.notEqual(key('strip', [added], 's'), key('strip', [base], 's'))
  // The pop-up draws one board, whichever other one moves.
  assert.equal(key('board', [base, { ...other, needs: [1] }], 's'), key('board', [base, other], 's'))
  assert.notEqual(key('pinbar', [base, { ...other, needs: [1] }], 's'), key('pinbar', [base, other], 's'))
  // The agents list draws the workers' lines and who is a coordinator, not the needs.
  const need = { ...base, needs: [{ key: 'D1' }] }
  assert.equal(key('agents', [need], 's'), key('agents', [base], 's'))
  assert.notEqual(key('strip', [need], 's'), key('strip', [base], 's'))
  const note = { ...base, workers: [{ ...base.workers[0], note: 'PR' }] }
  assert.notEqual(key('agents', [note], 's'), key('agents', [base], 's'))
  const coord = { ...base, coordinator: { terminal: 'x' } }
  assert.notEqual(key('agents', [coord], 's'), key('agents', [base], 's'))
  assert.notEqual(key('agents', [base, other], 's'), key('agents', [base], 's'), 'a board gone or new')
  // A closed sheet draws nothing, so nothing on a board redraws it.
  assert.equal(drawnKey('sheet', [minute], 's', null), drawnKey('sheet', [base], 's', null))
})

const MIN = 60_000
const T0 = 1_000_000_000

test('AgeClock: the clock past a minute asks for a redraw, within a minute it does not, and nothing to age never does', async () => {
  const { AgeClock } = await import('../mods/herdr-agents/model.js')
  const ages = new AgeClock()
  ages.drawn([T0], T0 + 2 * MIN)
  assert.equal(ages.moved([T0], T0 + 2 * MIN + 30_000), false, 'still 2m')
  assert.equal(ages.moved([T0], T0 + 3 * MIN), true, 'now 3m')
  assert.equal(ages.moved([T0], T0 + 3 * MIN + 1000), false, 'asked once for 3m')
  // Past an hour the text moves once an hour.
  ages.drawn([T0], T0 + 61 * MIN)
  assert.equal(ages.moved([T0], T0 + 62 * MIN), false)
  const none = new AgeClock()
  none.drawn([], T0)
  assert.equal(none.moved([], T0 + 90 * MIN), false)
})

test('agedTimes: the ages each copy has on screen', async () => {
  const { agedTimes } = await import('../mods/herdr-agents/model.js')
  const board = {
    session: 's',
    needs: [
      { key: 'D1', kind: 'ask', isOpen: true, at: 7 },
      { key: 'D2', kind: 'ask', isOpen: false, at: 8 },
    ],
  }
  const boards = [board]
  for (const role of ['card', 'sheet']) {
    assert.deepEqual(agedTimes(role, { boards, open: { session: 's', key: 'D1' } }), [7], role)
    assert.deepEqual(agedTimes(role, { boards, open: null }), [], `${role} closed`)
    assert.deepEqual(agedTimes(role, { boards, open: { session: 'x', key: 'D1' } }), [], `${role} on a board that ended`)
  }
  assert.deepEqual(agedTimes('card', { boards, open: { session: 's', key: 'D2' } }), [], 'the card draws no answered item')
  assert.deepEqual(agedTimes('sheet', { boards, open: { session: 's', key: 'D2' } }), [8], 'the sheet still draws an answered item')
  assert.deepEqual(agedTimes('pinbar', { pinAt: 9 }), [9])
  assert.deepEqual(agedTimes('pinbar', { pinAt: null }), [])
  const list = [{ id: 'a', at: 1 }, { id: 'b', at: 2 }, { id: 'c' }]
  assert.deepEqual(agedTimes('pins', { pins: { list } }), [1, 2])
  assert.deepEqual(agedTimes('pins', { pins: { list, view: 'panel', id: 'b' } }), [2], 'the drop panel shows one pin')
  assert.deepEqual(agedTimes('pins', { pins: { list }, gone: new Set(['a']) }), [2], 'a pin marked done is not drawn')
  for (const role of ['strip', 'board', 'agents', 'version'])
    assert.deepEqual(agedTimes(role, { boards, pinAt: 9, open: { session: 's', key: 'D1' } }), [], role)
})
