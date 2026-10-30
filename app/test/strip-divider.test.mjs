import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findId } from './fake-gpui.mjs'

const { strip } = await import('../mods/herdr-agents/strip.js')

test('the strip puts a gap and a divider between the scrolling tabs and the right-hand group', () => {
  const root = strip({ session: 's', coordinator: { terminal: 't2' }, workers: [], questions: [], pins: [] })
  const right = findId(root, 'strip-right')
  assert.ok(right, 'the right-hand group has an id')
  assert.equal(right.node.calls.flex_none.length, 0)
  assert.deepEqual(right.node.calls.pl, [12])
  assert.ok(findId(right, 'strip-divider'), 'the divider leads the group')
  assert.equal(right.node.kids[0], findId(right, 'strip-divider'))
})
