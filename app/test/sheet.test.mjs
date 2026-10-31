import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { deriveBar, newBarState, pins, slimLine } from '../mods/herdr-agents/model.js'
import { clearStaleSheet } from '../mods/herdr-agents/cardstate.js'
import {
  SHEET_MAX_H,
  SHEET_MIN_H,
  SHEET_W,
  askTarget,
  isSheetCommand,
  sheetHint,
  sheetItems,
  sheetDoneLine,
  sheetKeyAction,
  sheetPage,
  sheetRefs,
  SHEET_MIN_W,
  sheetSize,
  sheetTarget,
  sheetView,
  waitingOn,
  whyFile,
  whyLines,
  whySource,
  whyText,
} from '../mods/herdr-agents/sheetmodel.js'

const board = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))
const need = (b, key) => b.needs.find(n => n.key === key)
const NOW = 1790000000000

test('isSheetCommand: herdr-agents.sheet, nothing else', () => {
  assert.equal(isSheetCommand('herdr-agents.sheet'), true)
  assert.equal(isSheetCommand('sheet'), true)
  assert.equal(isSheetCommand('herdr-agents.board'), false)
  assert.equal(isSheetCommand('herdr-agents.sheets'), false)
})

test('whyText: the excerpt wins, then the text, then the asker RESULT.md (only when source.file is given)', () => {
  const full = { text: 'the text', source: { excerpt: ' the excerpt ', file: '/r/RESULT.md' } }
  assert.equal(whySource(full), 'excerpt')
  assert.equal(whyText(full, 'file body'), 'the excerpt')
  const noExcerpt = { text: ' the text ', source: { file: '/r/RESULT.md' } }
  assert.equal(whySource(noExcerpt), 'text')
  assert.equal(whyText(noExcerpt, 'file body'), 'the text')
  const onlyFile = { text: '  ', source: { excerpt: '', file: '/r/RESULT.md' } }
  assert.equal(whySource(onlyFile), 'file')
  assert.equal(whyText(onlyFile, ' file body \n'), 'file body')
  assert.equal(whyText(onlyFile, null), '', 'the file has not been read yet')
  const nothing = { text: '', source: {} }
  assert.equal(whySource(nothing), null)
  assert.equal(whyText(nothing, 'ignored'), '', 'a file text without source.file is never used')
  assert.equal(whyText(undefined), '')
})

test("whyFile: only when the box falls back to RESULT.md; a relative path is the board folder's", () => {
  const b = { cwd: '/work/shop/' }
  assert.equal(whyFile(b, { text: '', source: { file: '/abs/RESULT.md' } }), '/abs/RESULT.md')
  assert.equal(whyFile(b, { text: '', source: { file: '.herdr-agents/p/RESULT.md' } }), '/work/shop/.herdr-agents/p/RESULT.md')
  assert.equal(whyFile(b, { text: 'has text', source: { file: '/abs/RESULT.md' } }), null)
  assert.equal(whyFile(b, { text: '', source: {} }), null)
})

test('whyLines: cuts a long file and says so', () => {
  assert.deepEqual(whyLines('a\nb'), ['a', 'b'])
  const long = Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n')
  const lines = whyLines(long, 200)
  assert.equal(lines.length, 201)
  assert.equal(lines[200], '…')
})

test('sheetPage: all open items in board order, 1-based, wrapping; a closed one has no place', () => {
  const b = board()
  assert.deepEqual(
    sheetItems(b).map(i => i.key),
    ['D7', 'D8', 'T12', 'T13', 'K3', 'K4', 'K5'],
  )
  assert.deepEqual(sheetPage(b, 'D7'), { i: 1, n: 7, prev: 'K5', next: 'D8' })
  assert.deepEqual(sheetPage(b, 'K5'), { i: 7, n: 7, prev: 'K4', next: 'D7' })
  need(b, 'D8').isOpen = false
  assert.deepEqual(sheetPage(b, 'D7'), { i: 1, n: 6, prev: 'K5', next: 'T12' }, 'closed items are not paged to')
  assert.deepEqual(sheetPage(b, 'D8'), { i: 0, n: 6, prev: 'K5', next: 'D7' }, 'a closed one stays shown but has no position')
  b.needs = [need(b, 'D7')]
  assert.deepEqual(sheetPage(b, 'D7'), { i: 1, n: 1, prev: null, next: null }, 'one item has nothing to page to')
  assert.deepEqual(sheetPage({ needs: [] }, 'D7'), { i: 0, n: 0, prev: null, next: null })
})

test('sheetTarget: the card item if open, else the first decision, then to-do, then note', () => {
  const b = board()
  assert.equal(sheetTarget(b, 'T13'), 'T13')
  assert.equal(sheetTarget(b, 'nope'), 'D7')
  assert.equal(sheetTarget(b), 'D7')
  b.needs = b.needs.filter(n => n.kind !== 'ask')
  assert.equal(sheetTarget(b), 'T12')
  b.needs = b.needs.filter(n => n.kind === 'know')
  assert.equal(sheetTarget(b), 'K3')
  assert.equal(sheetTarget({ needs: [] }), null)
})

test('waitingOn: names the tasks whose item is this key, or says nothing waits', () => {
  const b = board()
  assert.equal(waitingOn(b, 'D7'), 'Waiting on this: #601 Task 1')
  assert.equal(waitingOn(b, 'K3'), 'Nothing waits on this')
  b.tasks[1].item = 'D7'
  assert.equal(waitingOn(b, 'D7'), 'Waiting on this: #601 Task 1 · #602 Task 2')
  b.tasks[1].joined = 'k1'
  assert.equal(waitingOn(b, 'D7'), 'Waiting on this: #601 Task 1', 'a slot that joined another row does not count')
  assert.equal(waitingOn({}, 'D7'), 'Nothing waits on this')
})

test('sheetRefs: refs from the item and the PRs of tasks waiting on it; a PR number has an address when one is known', () => {
  const b = board()
  assert.deepEqual(sheetRefs(b, need(b, 'D7')), [], 'no refs given, no task PR: none')
  const d7 = { ...need(b, 'D7'), refs: ['src/sort.ts', '#612', { label: 'design', url: 'https://x.test/d' }, 7, ''] }
  b.tasks[0].pr = 612
  b.tasks[0].url = 'https://github.com/acme/shop/pull/612'
  assert.deepEqual(sheetRefs(b, d7), [
    { label: 'src/sort.ts', url: null },
    { label: 'PR #612', url: 'https://github.com/acme/shop/pull/612' },
    { label: 'design', url: 'https://x.test/d' },
  ])
  // A PR number the board has no address for: built from the waiting task's repo, else not clickable.
  b.tasks[0].pr = null
  b.tasks[0].url = null
  assert.deepEqual(sheetRefs(b, { ...d7, refs: ['PR #9'] }), [{ label: 'PR #9', url: 'https://github.com/acme/shop/pull/9' }])
  assert.deepEqual(sheetRefs({ tasks: [] }, { key: 'X', refs: ['#9'] }), [{ label: 'PR #9', url: null }])
  // A waiting task's own PR is listed once even if the item names it too.
  b.tasks[0].pr = 612
  b.tasks[0].url = 'https://github.com/acme/shop/pull/612'
  assert.equal(sheetRefs(b, { ...d7, refs: ['#612'] }).filter(r => r.label === 'PR #612').length, 1)
  assert.deepEqual(sheetRefs(b, need(b, 'D7')), [{ label: 'PR #612', url: 'https://github.com/acme/shop/pull/612' }])
})

test('askTarget: the coordinator terminal, or null (the button is left out)', () => {
  assert.equal(askTarget(board()), 't4')
  assert.equal(askTarget({ coordinator: { terminal: null } }), null)
  assert.equal(askTarget({}), null)
})

test('sheetView: a decision has its options, impacts, the recommended one, and the header facts', () => {
  const b = board()
  b.needs[0].impacts = ['about 40 lines']
  const v = sheetView(b, 'D7', { now: NOW })
  assert.equal(v.face, 'ask')
  assert.deepEqual(
    v.options.map(o => [o.label, o.impact, o.rec, o.action]),
    [
      ['Cursor', 'about 40 lines', true, { action: 'answer', key: 'D7', answer: 'Cursor' }],
      ['Offset', '', false, { action: 'answer', key: 'D7', answer: 'Offset' }],
    ],
  )
  assert.equal(v.title, 'Pagination style')
  assert.equal(v.meta, '#601 · w-api · 1m')
  assert.equal(v.source, 'w-api · 1m')
  assert.equal(v.why, 'Cursor or offset pagination for the orders API?')
  assert.equal(v.waitingOn, 'Waiting on this: #601 Task 1')
  assert.deepEqual(v.pos, { i: 1, n: 7, prev: 'K5', next: 'D8' })
  assert.equal(v.ask, 't4')
  assert.deepEqual(v.refs, [])
})

test('sheetView: each optional field missing leaves the section empty, not broken', () => {
  const b = { session: 's', cwd: '/w', at: 1, needs: [{ key: 'D1', kind: 'ask', isOpen: true, text: '' }], tasks: [] }
  const v = sheetView(b, 'D1', { now: NOW })
  assert.equal(v.face, 'ask')
  assert.equal(v.title, 'D1')
  assert.equal(v.meta, '')
  assert.equal(v.source, '')
  assert.equal(v.why, '')
  assert.equal(v.whyFile, null)
  assert.deepEqual(v.options, [])
  assert.deepEqual(v.refs, [])
  assert.equal(v.ask, null)
  assert.equal(v.waitingOn, 'Nothing waits on this')
  assert.deepEqual(v.pos, { i: 1, n: 1, prev: null, next: null })
})

test('sheetView: with the excerpt and a file path given, source names where the text came from', () => {
  const b = board()
  b.needs[0].source = { excerpt: 'PLAN says: ...', file: '/r/RESULT.md' }
  assert.equal(sheetView(b, 'D7', { now: NOW }).source, 'w-api · excerpt · 1m')
  b.needs[0].source = { file: '/r/RESULT.md' }
  b.needs[0].text = ''
  const v = sheetView(b, 'D7', { now: NOW, fileText: 'result body' })
  assert.equal(v.source, 'w-api · RESULT.md · 1m')
  assert.equal(v.why, 'result body')
  assert.equal(v.whyFile, '/r/RESULT.md')
})

test('sheetView: a to-do has Done, and Open link only with a url; a note has Dismiss', () => {
  const b = board()
  const t12 = sheetView(b, 'T12', { now: NOW })
  assert.equal(t12.face, 'do')
  assert.deepEqual(
    t12.options.map(o => [o.label, o.action, o.url]),
    [['Done', { action: 'done', key: 'T12' }, null]],
  )
  const t13 = sheetView(b, 'T13', { now: NOW })
  assert.deepEqual(
    t13.options.map(o => [o.label, o.action, o.url]),
    [
      ['Done', { action: 'done', key: 'T13' }, null],
      ['Open link', null, 'http://localhost:5173'],
    ],
  )
  const k3 = sheetView(b, 'K3', { now: NOW })
  assert.equal(k3.face, 'know')
  assert.deepEqual(
    k3.options.map(o => [o.label, o.action]),
    [['Dismiss', { action: 'done', key: 'K3' }]],
  )
  assert.equal(k3.title, 'Retry budget')
  assert.equal(sheetView(b, 'K5', { now: NOW }).title, 'The staging database was reset at noon, so old test orders are gone.')
})

test('sheetView: after an answer the options stay with the chosen one marked, and undo is offered while it waits', () => {
  const b = board()
  const action = { action: 'answer', key: 'D7', answer: 'Offset' }
  const queued = sheetView(b, 'D7', { now: NOW, queue: [{ id: 'q1', session: b.session, key: 'D7', action }] })
  assert.equal(queued.face, 'resolved')
  assert.equal(queued.verb, 'answer')
  assert.equal(queued.detail, 'Offset')
  assert.equal(queued.sent, false)
  assert.equal(queued.undoId, 'q1')
  assert.deepEqual(
    queued.options.map(o => [o.label, o.picked]),
    [
      ['Cursor', false],
      ['Offset', true],
    ],
  )
  const sent = sheetView(b, 'D7', { now: NOW, sent: [{ id: 'q1', session: b.session, key: 'D7', action, at: NOW }] })
  assert.equal(sent.face, 'resolved')
  assert.equal(sent.sent, true)
  assert.equal(sent.undoId, null)
  // A to-do: Done is the chosen one.
  const done = sheetView(b, 'T12', {
    now: NOW,
    queue: [{ id: 'q2', session: b.session, key: 'T12', action: { action: 'done', key: 'T12' } }],
  })
  assert.deepEqual([done.verb, done.options[0].picked, done.undoId], ['done', true, 'q2'])
  // Another board's or item's action does not count.
  assert.equal(sheetView(b, 'D7', { now: NOW, queue: [{ id: 'q', session: 'other', key: 'D7', action }] }).face, 'ask')
  assert.equal(sheetView(b, 'D7', { now: NOW, queue: [{ id: 'q', session: b.session, key: 'D8', action }] }).face, 'ask')
})

test('sheetView: an item that closed on the board shows as closed; no board is gone', () => {
  const b = board()
  need(b, 'D7').isOpen = false
  const closed = sheetView(b, 'D7', { now: NOW })
  assert.deepEqual([closed.face, closed.verb, closed.undoId], ['resolved', 'closed', null])
  assert.equal(closed.pos.i, 0)
  assert.equal(sheetView(b, 'zz', { now: NOW }).face, 'resolved')
  assert.equal(sheetView(null, 'D7').face, 'gone')
})

test('sheetKeyAction: Esc closes, arrows page, 1-3 press an option that exists, the rest is left alone', () => {
  assert.deepEqual(sheetKeyAction('escape'), { type: 'close' })
  assert.deepEqual(sheetKeyAction('left'), { type: 'prev' })
  assert.deepEqual(sheetKeyAction('right'), { type: 'next' })
  assert.deepEqual(sheetKeyAction('2', { options: 3 }), { type: 'option', index: 1 })
  assert.deepEqual(sheetKeyAction('3', { options: 2 }), { type: 'ignore' }, 'no third option')
  assert.deepEqual(sheetKeyAction('1', { options: 0 }), { type: 'ignore' }, 'a settled item has nothing to press')
  assert.deepEqual(sheetKeyAction('ctrl-1', { options: 3 }), { type: 'ignore' }, 'a chord on 1 is not 1')
  assert.deepEqual(sheetKeyAction('a', { options: 3 }), { type: 'ignore' })
  assert.deepEqual(sheetKeyAction('escape', { held: true }), { type: 'ignore' })
})

test('sheetHint: only the keys that work', () => {
  assert.equal(sheetHint({ options: 3, paged: true }), '1-3 choose · ← → page · esc closes')
  assert.equal(sheetHint({ options: 1 }), '1 choose · esc closes')
  assert.equal(sheetHint({}), 'esc closes')
})

test('sheetSize: the window is measured in the px the app scales by the zoom', () => {
  assert.deepEqual(
    sheetSize({ width: 1280, height: 820 }, 1.2),
    { w: 726, h: 423, narrow: true, meta: true },
    '726 px draw as 871 of the 1280',
  )
  assert.equal(sheetSize({ width: 760, height: 460 }, 1.2).w, SHEET_MIN_W, '760 / 1.2 - 340 is under the minimum')
  assert.deepEqual(sheetSize({ width: 1280, height: 820 }, 1), sheetSize({ width: 1280, height: 820 }), 'zoom 1 changes nothing')
  assert.equal(sheetSize({ width: 1280, height: 820 }, 0.5).w, SHEET_W, 'zoomed out, it stops at its largest')
  assert.deepEqual(sheetSize({ width: 1280, height: 820 }, undefined), sheetSize({ width: 1280, height: 820 }), 'no zoom known')
  assert.deepEqual(sheetSize({ width: 1280, height: 820 }, 0), sheetSize({ width: 1280, height: 820 }), 'a zero zoom is ignored')
  assert.deepEqual(sheetSize(null, 1.2), sheetSize(null), 'no window size: the full size')
})

test('sheetSize: 470 px at most and shorter in a short window, so the strip and prompt stay visible; narrower in a narrow one', () => {
  assert.deepEqual(sheetSize({ width: 1800, height: 1000 }), { w: SHEET_W, h: SHEET_MAX_H, narrow: false, meta: true })
  assert.equal(sheetSize({ width: 1800, height: 600 }).h, 600 - 260, 'a 600 px window leaves 260 px under the top of the terminal')
  assert.equal(sheetSize({ width: 1800, height: 460 }).h, SHEET_MIN_H, 'options stay in reach, over the strip and prompt if it must')
  assert.equal(
    sheetSize({ width: 1800, height: 300 }).h,
    300 - 182,
    'a very short window: only what the main block has, or the app cuts it off',
  )
  assert.equal(sheetSize({ width: 1800, height: 200 }).h, 100, 'never smaller than it can be read')
  assert.equal(sheetSize({ width: 760, height: 460 }, 1.2).h, Math.floor(460 / 1.2 - 182), 'its room is measured at the zoom')
  assert.equal(sheetSize({ width: 760, height: 460 }, 1.2).meta, false, 'no meta where it pushes esc out of the frame')
  assert.equal(sheetSize({ width: 900, height: 1000 }).w, 560)
  assert.equal(sheetSize({ width: 900, height: 1000 }).narrow, true)
  assert.equal(sheetSize({ width: 200, height: 1000 }).w, 300)
  assert.deepEqual(sheetSize(null), { w: SHEET_W, h: SHEET_MAX_H, narrow: false, meta: true })
})

test('the pin bar goes slim at the same row while the sheet is open, and says how many are new; no flash starts', () => {
  const b = board()
  b.needs = b.needs.filter(n => n.kind === 'know').slice(0, 2)
  const list = pins(b)
  assert.equal(slimLine(list), '2 pins · nothing new · last: Index added')
  assert.equal(slimLine(list, true), '2 pins · 2 new · last: Index added')
  const open = deriveBar(newBarState(), b, { now: 1, slim: true })
  assert.equal(open.view.mode, 'slim')
  assert.equal(open.flashStart, null)
  assert.equal(open.view.slim, '2 pins · 2 new · last: Index added')
  const closed = deriveBar(open.state, b, { now: 2 })
  assert.equal(closed.view.mode, 'full', 'closing the sheet brings the full row back')
  assert.notEqual(closed.flashStart, null, 'the unread pin still flashes once, when it is shown')
  assert.equal(deriveBar(newBarState(), { ...b, needs: [] }, { slim: true }).view.mode, 'empty', 'no pins: still the quiet empty row')
})

test('clearStaleSheet forgets a sheet left open by the last run, and only that', () => {
  const store = { 'hrd.sheet': { session: 's', key: 'D7' }, 'hrd.open': { session: 's', key: 'D7' } }
  const get = k => store[k]
  const set = (k, v) => (store[k] = v)
  assert.equal(clearStaleSheet(get, set), true)
  assert.equal(store['hrd.sheet'], null)
  assert.notEqual(store['hrd.open'], null)
  assert.equal(clearStaleSheet(get, set), false)
})

test('sheetView: the source line names no word for an item with only text', () => {
  const b = { session: 's', needs: [{ key: 'K', kind: 'know', isOpen: true, from: 'w-api', text: 'hello' }] }
  assert.equal(sheetView(b, 'K', { now: 1 }).source, 'w-api')
})

test('sheetDoneLine: says sent or sending only for what went out; a closed item just says closed', () => {
  assert.equal(sheetDoneLine({ verb: 'closed', detail: '', sent: true }), 'closed')
  assert.equal(sheetDoneLine({ verb: 'answer', detail: 'Cursor', sent: true }), 'answer · Cursor · sent')
  assert.equal(sheetDoneLine({ verb: 'done', detail: '', sent: false }), 'done · sending')
})

test('sheetKeyAction: a number right after a move is ignored, so a repeated 2 cannot open a link', () => {
  assert.deepEqual(sheetKeyAction('2', { options: 3, settling: true }), { type: 'ignore' })
  assert.deepEqual(sheetKeyAction('right', { settling: true }), { type: 'next' })
})
