import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { app, findId, textOf } from './fake-gpui.mjs'
import {
  POPUP_W,
  boardSpace,
  agedTimes,
  isBoardCommand,
  mergedText,
  overlayPlan,
  popupKeyAction,
  popupRefocus,
  projectName,
  popupHeight,
  popupSpot,
  rowAction,
  stageIcon,
  touchesBoard,
  workRows,
  wrapUpAction,
  wrapUpButton,
} from '../mods/herdr-agents/model.js'

const board = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))

test('workRows: one row per task of the one board', () => {
  const b = board()
  assert.deepEqual(
    workRows(b).map(r => r.key),
    ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'],
  )
  assert.equal(workRows(null).length, 0)
})

test('workRows: stages become icon names, in the five columns', () => {
  const rows = workRows(board())
  assert.deepEqual(rows[0].stages, ['done', 'done', 'decide', null, null])
  assert.deepEqual(rows[1].stages, ['done', 'working', 'decide', null, null])
  assert.deepEqual(rows[2].stages, ['done', 'done', 'do', null, null])
  assert.deepEqual(rows[4].stages, ['done', 'blocked', null, null, null])
  assert.deepEqual(rows[5].stages, ['done', 'done', 'done', 'waiting', null])
  assert.equal(stageIcon('nonsense'), null)
  assert.deepEqual(workRows({ tasks: [{ key: 'a', stages: ['run'] }] })[0].stages, ['working', null, null, null, null])
})

test('workRows keeps who, item and tab for the click', () => {
  const r = workRows(board())[0]
  assert.deepEqual(r.who, { text: 'you', kind: 'you' })
  assert.equal(r.item, 'D7')
  assert.equal(r.tab, 'w-api')
})

test('rowAction: a worker with a live tab is focused, a row with no agent opens its item, otherwise nothing', () => {
  const terminals = [{ address: 't9', name: 'w-api', state: 'live' }]
  const rows = workRows(board())
  assert.deepEqual(rowAction(rows[0], terminals), { type: 'focus', terminal: 't9' })
  assert.deepEqual(rowAction(rows[3], terminals), { type: 'card', item: 'T13' }) // no tab, an item
  assert.deepEqual(rowAction(rows[2], terminals), { type: 'card', item: 'T12' }) // a tab nobody runs, an item
  assert.deepEqual(rowAction(rows[0], [{ address: 't9', name: 'w-api', state: 'exited' }]), { type: 'card', item: 'D7' })
  assert.equal(rowAction(rows[5], terminals), null) // a tab, no terminal, no item
  assert.equal(rowAction(null, terminals), null)
})

test('wrap up: the button offers the opposite, and the action file is the one the plugin takes', () => {
  assert.deepEqual(wrapUpAction(true), { action: 'wrapUp', on: true })
  const b = board()
  assert.deepEqual(wrapUpButton(b), { text: 'wrap up', action: { action: 'wrapUp', on: true } })
  b.summary.wrapUp = true
  assert.deepEqual(wrapUpButton(b), { text: 'keep going', action: { action: 'wrapUp', on: false } })
  assert.equal(wrapUpButton(null).action.on, true)
})

test('the pop-up has a fixed size: height grows with rows up to a cap, never 0', () => {
  assert.ok(popupHeight(0) > 0)
  assert.equal(popupHeight(1), popupHeight(0))
  assert.equal(popupHeight(7) - popupHeight(6), 26)
  assert.equal(popupHeight(40), popupHeight(12))
})

test('popupSpot is right aligned and sits above the status bar and the strip', () => {
  assert.deepEqual(popupSpot(1400, 900, 200), { x: 1400 - POPUP_W - 8, y: 900 - 28 - 34 - 200 - 4 })
  assert.deepEqual(popupSpot(300, 100, 400), { x: 0, y: 0 })
})

test('isBoardCommand matches the board command only', () => {
  assert.ok(isBoardCommand('herdr-agents.board'))
  assert.ok(!isBoardCommand('herdr-agents.pick1'))
  assert.ok(!isBoardCommand('herdr-agents.dashboard'))
})

test('rowAction: a worker with the same name in another project is not focused', () => {
  const terminals = [
    { address: 't1', name: 'w-api', state: 'live', labels: { 'herdr.space': 'sp-other' } },
    { address: 't2', name: 'w-api', state: 'live', labels: { 'herdr.space': 'sp-shop' } },
  ]
  const r = workRows(board())[0]
  assert.deepEqual(rowAction(r, terminals, 'sp-shop'), { type: 'focus', terminal: 't2' })
  assert.deepEqual(rowAction(r, terminals.slice(0, 1), 'sp-shop'), { type: 'card', item: 'D7' })
})

test('boardSpace: the space label of the coordinator terminal; projectName: its folder', () => {
  const b = board()
  assert.equal(boardSpace(b, [{ address: 't4', labels: { 'herdr.space': 'sp-shop' } }]), 'sp-shop')
  assert.equal(boardSpace(b, []), null)
  assert.equal(projectName(b), 'shop')
  assert.equal(projectName(null), '')
})

test('overlayPlan: one overlay at a time; the card or sheet hands the keyboard back when another replaces it', () => {
  const none = { closePopup: false, closeCard: false, closePins: false, closeSheet: false, refocus: false }
  assert.deepEqual(overlayPlan('card', { popup: true, card: false }), { ...none, closePopup: true })
  assert.deepEqual(overlayPlan('card', { popup: false, card: false }).closePopup, false)
  assert.deepEqual(overlayPlan('card', { pins: true }), { ...none, closePins: true })
  assert.deepEqual(overlayPlan('popup', { popup: false, card: true }), { ...none, closeCard: true, refocus: true })
  assert.deepEqual(overlayPlan('popup', { popup: true, card: false }), { ...none, closePopup: true })
  assert.deepEqual(overlayPlan('popup', { pins: true }), { ...none, closePins: true })
  assert.deepEqual(overlayPlan('pins', { popup: true }), { ...none, closePopup: true })
  assert.deepEqual(overlayPlan('pins', { card: true }), { ...none, closeCard: true, refocus: true })
  assert.deepEqual(overlayPlan('pins', { pins: true }), { ...none, closePins: true }, 'a second open replaces the first')
  assert.deepEqual(overlayPlan('pins', {}), none)
  // The sheet (S9): opening it closes the others; opening any of them closes the sheet.
  assert.deepEqual(overlayPlan('sheet', { popup: true, card: true }), { ...none, closePopup: true, closeCard: true, refocus: true })
  assert.deepEqual(overlayPlan('sheet', { pins: true }), { ...none, closePins: true })
  assert.deepEqual(overlayPlan('sheet', {}), none)
  assert.deepEqual(overlayPlan('card', { sheet: true }), { ...none, closeSheet: true, refocus: true })
  assert.deepEqual(overlayPlan('popup', { sheet: true }), { ...none, closeSheet: true, refocus: true })
  assert.deepEqual(overlayPlan('pins', { sheet: true }), { ...none, closeSheet: true, refocus: true })
})

test("touchesBoard: only the pop-up's own board file counts, under either spelling of the folder", () => {
  assert.equal(touchesBoard('s1', ['/tmp/h/board/s1.json']), true)
  assert.equal(touchesBoard('s1', ['/private/tmp/h/board/other.json', '/private/tmp/h/board/s1.json']), true)
  assert.equal(touchesBoard('s1', ['/tmp/h/board/s2.json']), false)
  assert.equal(touchesBoard('s1', ['/tmp/h/board/s1.json.tmp', '/tmp/h/board/s1.actions/s1.json.x']), false)
  assert.equal(touchesBoard('s1', ['/tmp/h/board/xs1.json']), false)
  assert.equal(touchesBoard('s1', []), false)
  assert.equal(touchesBoard('s1', undefined), false)
})

const source = name => readFileSync(new URL(`../mods/herdr-agents/${name}`, import.meta.url), 'utf8')

test('popupKeyAction: Esc closes; a held key and every other key do nothing', () => {
  assert.equal(popupKeyAction('escape'), 'close')
  assert.equal(popupKeyAction('Escape'), 'close')
  assert.equal(popupKeyAction('escape', true), 'ignore')
  assert.equal(popupKeyAction('a'), 'ignore')
  assert.equal(popupKeyAction(undefined), 'ignore')
})

test('the pop-up takes the keyboard when it opens and closes on Esc', () => {
  const src = source('popup.js')
  assert.match(src, /const h = cx\.focus_handle\(\)/)
  assert.match(src, /makePopupState = cx => \(\{ h: takeKeyboard\(cx\)/)
  assert.match(src, /await cx\.sleep\(60\)\s*h\.focus\(\)/)
  assert.match(src, /\.track_focus\(ctl\.h\)/)
  assert.match(
    src,
    /\.on_key_down\(e => \{\s*if \(popupKeyAction\(e\.keystroke \?\? e\.key, e\.is_held\) !== 'close'\) return\s*try \{\s*closeOverlay\(props\(\)\.overlay\)/,
  )
  assert.match(source('main.js'), /this\.popup = makePopupState\(cx\)/)
})

test('popupRefocus: the keyboard goes back to the terminal that had it', () => {
  const from = { back: 't1', space: 'a' }
  assert.equal(popupRefocus(from, { terminal: 't1', space: 'a' }), 't1')
  assert.equal(popupRefocus(from, { terminal: null, space: 'a' }), 't1', 'nothing holds it: Esc or a click on no terminal')
  assert.equal(popupRefocus(from, { terminal: 't1', space: 'a' }, true), null, 'a row chose where it goes')
  assert.equal(popupRefocus(from, { terminal: 't2', space: 'a' }), null, 'the click outside picked another terminal')
  assert.equal(popupRefocus(from, { terminal: 't1', space: 'b' }), null, 'the owner moved to another space')
  assert.equal(popupRefocus({ back: null, space: 'a' }, { terminal: null, space: 'a' }), null)
})

test('every way of closing hands the keyboard back, and a row keeps its own target', () => {
  assert.match(source('main.js'), /async close\(\) \{\s*if \(this\.popup\) releasePopup\(this\.popup\)/)
  const src = source('popup.js')
  assert.match(src, /run\('pane\.focus', \{ terminal \}\)/)
  assert.match(src, /ctl\.leaving = true\s*(\/\/.*\s*)?closeOverlay/)
  const strip = source('strip.js')
  assert.match(strip, /const back = shared\('hrd\.open'\)\?\.back \?\? gone\?\.back \?\? focused\(\)\?\.terminal \?\? null/)
  assert.match(strip, /props: \{ role: 'board', session: board\.session, height, board, back, space \}/)
})

// --- PR links and merge ages (#218) ---

const prTask = (over = {}) => ({
  key: 'k',
  label: '#212',
  title: 'a title',
  pr: 212,
  url: 'https://github.com/o/n/pull/212',
  stages: [],
  isMerged: false,
  ...over,
})

test('workRows: the PR link needs a PR and a web address; the label that reads #<pr> is the link itself', () => {
  const [a, b, c, d, e] = workRows({
    tasks: [
      prTask(),
      prTask({ label: '#12' }),
      prTask({ pr: null, url: 'https://github.com/o/n/issues/12' }),
      prTask({ url: null }),
      prTask({ url: 'javascript:alert(1)' }),
    ],
  })
  assert.deepEqual(a.link, { text: '#212', url: 'https://github.com/o/n/pull/212', onLabel: true })
  assert.deepEqual(b.link, { text: '#212', url: 'https://github.com/o/n/pull/212', onLabel: false })
  assert.equal(c.link, null, 'an issue link without a PR keeps the row as it was')
  assert.equal(d.link, null)
  assert.equal(e.link, null, 'only http(s) opens')
})

test('mergedText: merged and how long ago; just merged when the board has no time', () => {
  const T = 1_000_000_000
  const row = at => workRows({ tasks: [prTask({ isMerged: true, mergedAt: at })] })[0]
  assert.equal(mergedText(row(T), T + 2 * 3600_000), 'merged 2h')
  assert.equal(mergedText(row(T), T + 5 * 60_000), 'merged 5m')
  assert.equal(mergedText(row(undefined), T), 'merged', 'an old board without mergedAt')
  assert.equal(mergedText(row(null), T), 'merged')
  assert.equal(mergedText(workRows({ tasks: [prTask()] })[0], T), '', 'an open PR says nothing')
})

test('agedTimes: the pop-up ages are the merge times of the merged rows of its board', () => {
  const boards = [
    {
      session: 's',
      tasks: [prTask({ isMerged: true, mergedAt: 7 }), prTask({ key: 'x', isMerged: true }), prTask({ key: 'y', mergedAt: 9 })],
    },
  ]
  assert.deepEqual(agedTimes('board', { boards, session: 's' }), [7])
  assert.deepEqual(agedTimes('board', { boards, session: 'other' }), [])
})

const { popupView } = await import('../mods/herdr-agents/popup.js')

const draw = (tasks, now = 1_000_000_000 + 2 * 3600_000) => {
  app.props = { role: 'board', session: 's', overlay: 'o9', height: 300 }
  app.execs = []
  app.closed = []
  const realNow = Date.now
  Date.now = () => now
  try {
    return popupView({ session: 's', stageNames: [], tasks }, { h: {}, leaving: false })
  } finally {
    Date.now = realNow
  }
}
const click = (el, ctx = { stop_propagation() {} }) => el.node.calls.on_mouse_down[1]({}, ctx)

beforeEach(() => {
  app.execs = []
  app.ran = []
})

test('the pop-up row: the PR number opens the PR, and the press stops there', () => {
  const root = draw([prTask({ key: 'a' })])
  let stopped = 0
  click(findId(root, 'work-pr-a'), { stop_propagation: () => stopped++ })
  assert.deepEqual(app.execs, [['open', 'https://github.com/o/n/pull/212']])
  assert.equal(stopped, 1, 'the row below does not also take the press')
  assert.deepEqual(app.closed, [], 'the pop-up stays')
  assert.ok(findId(root, 'work-pr-a').node.calls.cursor_pointer)
  assert.equal(textOf(root).filter(x => x === '#212').length, 1, 'the label is the link: no second #212 beside the title')
})

test('the pop-up row: a label that is not the PR number gets a separate link', () => {
  const root = draw([prTask({ key: 'a', label: '#12' })])
  assert.deepEqual(textOf(findId(root, 'work-pr-a')), ['#212'])
  click(findId(root, 'work-pr-a'))
  assert.deepEqual(app.execs, [['open', 'https://github.com/o/n/pull/212']])
})

test('the pop-up row: no link without a PR or an address', () => {
  const root = draw([prTask({ key: 'a', pr: null }), prTask({ key: 'b', url: null })])
  assert.equal(findId(root, 'work-pr-a'), null)
  assert.equal(findId(root, 'work-pr-b'), null)
})

test('the pop-up row: a merged PR says how long ago, an old board just merged, an open PR nothing', () => {
  const T = 1_000_000_000
  const root = draw([
    prTask({ key: 'a', isMerged: true, mergedAt: T, who: { text: 'merged', kind: 'dim' } }),
    prTask({ key: 'b', isMerged: true, who: { text: 'merged', kind: 'dim' } }),
    prTask({ key: 'c', who: { text: 'you', kind: 'you' } }),
  ])
  const all = id => textOf(findId(root, id))
  assert.ok(textOf(findId(root, 'work-rows')).includes('merged 2h'))
  assert.ok(textOf(findId(root, 'work-rows')).includes('merged'))
  assert.equal(all('work-a').filter(x => x === 'merged').length, 0, 'the who column does not say it twice')
  assert.equal(all('work-c').filter(x => /merged/.test(x)).length, 0)
})

test('the pop-up row: narrow, the title is what truncates; the link and the age keep their size', () => {
  const root = draw([prTask({ key: 'a', label: '#12', isMerged: true, mergedAt: 1_000_000_000 })])
  const kids = findId(root, 'work-a').node.kids
  const title = kids.find(k => textOf(k).includes('a title'))
  assert.ok(title.node.calls.truncate && title.node.calls.min_w_0 && title.node.calls.flex_1)
  for (const text of ['#212', 'merged 2h']) {
    const k = kids.find(x => textOf(x).includes(text))
    assert.ok(k.node.calls.flex_none, text)
    assert.ok(!k.node.calls.truncate, text)
  }
})

// --- a card opened from the pop-up lines up with its item's tab (#93) ---

test('the pop-up row: the card opens at the place of its item in the strip, else the first tab', async () => {
  const { stripItems } = await import('../mods/herdr-agents/model.js')
  const full = { ...board(), session: 's' }
  const items = stripItems(full)
  assert.ok(items.length >= 3)
  app.focused = { terminal: 't1', space: 'a' }
  app.props = { role: 'board', session: 's', overlay: 'o9', height: 300 }
  app.store = {}
  for (const [item, at] of [
    [items[2].key, 2],
    ['not-in-the-strip', 0],
  ]) {
    full.tasks = [prTask({ key: 'r', item })]
    app.store['hrd.open'] = null
    click(findId(popupView(full, { h: {}, leaving: false }), 'work-r'))
    assert.equal(app.store['hrd.open'].key, item)
    assert.equal(app.store['hrd.open'].at, at)
  }
})
