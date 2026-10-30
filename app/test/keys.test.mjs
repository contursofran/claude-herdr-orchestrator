import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeKeys } from '../keys.mjs'

test('missing keys and sections are added', () => {
  const r = mergeKeys(
    { global: { 'cmd-q': 'app.quit' } },
    { global: { 'cmd-j': 'herdr-agents.sheet' }, terminal: { 'alt-1': 'herdr-agents.pick1' } },
  )
  assert.deepEqual(r.keys, { global: { 'cmd-q': 'app.quit', 'cmd-j': 'herdr-agents.sheet' }, terminal: { 'alt-1': 'herdr-agents.pick1' } })
  assert.deepEqual(r.added, ['global cmd-j', 'terminal alt-1'])
  assert.deepEqual(r.skipped, [])
})

test('a key already bound to something else is never replaced, and is reported', () => {
  const existing = { global: { 'cmd-j': 'app.palette' } }
  const r = mergeKeys(existing, { global: { 'cmd-j': 'herdr-agents.sheet' } })
  assert.equal(r.keys.global['cmd-j'], 'app.palette')
  assert.deepEqual(r.skipped, ['global cmd-j'])
  assert.deepEqual(r.added, [])
})

test('a key already bound to the same action is left alone without a report; the input is not changed', () => {
  const existing = { global: { 'cmd-j': 'herdr-agents.sheet' } }
  const r = mergeKeys(existing, { global: { 'cmd-j': 'herdr-agents.sheet' } })
  assert.deepEqual([r.added, r.skipped], [[], []])
  mergeKeys(existing, { global: { 'cmd-k': 'x' } })
  assert.deepEqual(existing, { global: { 'cmd-j': 'herdr-agents.sheet' } })
})
