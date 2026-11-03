import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pins, settleSent } from '../mods/herdr-agents/model.js'

const know = (key, extra = {}) => ({ key, kind: 'know', isOpen: true, text: `${key} text`, ...extra })
const board = needs => ({ session: 's', needs })

test('pins carry the full text, for the drop panel', () => {
  const [p] = pins(board([know('K1', { text: '  First line\nsecond line  ' })]))
  assert.equal(p.text, 'First line\nsecond line')
})

test('settleSent: a refused Done on an item the board shows closed is no failure; an open item or an answer still is', () => {
  const refused = { id: 'a1', ok: false, message: 'K1 is not an open to-do' }
  const done = { id: 'a1', session: 's', key: 'K1', action: { action: 'done', key: 'K1' } }
  const closed = [{ session: 's', needs: [], actions: [refused] }]
  assert.deepEqual(settleSent([done], closed), { sent: [], failed: [] })
  const openBoard = [{ session: 's', needs: [know('K1')], actions: [refused] }]
  assert.deepEqual(settleSent([done], openBoard).failed, [{ id: 'a1', message: 'K1 is not an open to-do' }])
  const answer = { ...done, action: { action: 'answer', key: 'K1', answer: 'yes' } }
  assert.deepEqual(settleSent([answer], closed).failed, [{ id: 'a1', message: 'K1 is not an open to-do' }])
})
