import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  POPUP_W,
  isBoardCommand,
  popupHeight,
  popupSpot,
  rowAction,
  stageIcon,
  workRows,
  wrapUpAction,
  wrapUpButton,
} from '../mods/herdr-agents/model.js'

const board = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))

test('workRows: one row per slot of the one board, joined slots left out', () => {
  const b = board()
  b.tasks.push({ key: 'k7', label: '#607', joined: 'k6' })
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
