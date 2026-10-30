import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('app/keys.json: the strip keys sit in layout:coordinator, ctrl-cmd-1..6, cmd-j opens the sheet, and merge into the app keys', () => {
  const wanted = JSON.parse(readFileSync(new URL('../keys.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(wanted), ['layout:coordinator'])
  assert.deepEqual(Object.entries(wanted['layout:coordinator']), [
    ...[1, 2, 3, 4, 5, 6].map(n => [`ctrl-cmd-${n}`, `herdr-agents.pick${n}`]),
    ['ctrl-cmd-[', 'herdr-agents.prevpin'],
    ['ctrl-cmd-]', 'herdr-agents.nextpin'],
    ['ctrl-cmd-b', 'herdr-agents.board'],
    ['cmd-j', 'herdr-agents.sheet'],
  ])
  const r = mergeKeys({ global: { 'cmd-1': 'tab.select:1' } }, wanted)
  assert.equal(r.keys['layout:coordinator']['ctrl-cmd-3'], 'herdr-agents.pick3')
  assert.equal(r.added.length, 10)
  // Run again over the result: nothing more to add, nothing skipped.
  const again = mergeKeys(r.keys, wanted)
  assert.deepEqual([again.added, again.skipped], [[], []])
  // A key the person already bound there is kept.
  const kept = mergeKeys({ 'layout:coordinator': { 'ctrl-cmd-1': 'tab.next' } }, wanted)
  assert.equal(kept.keys['layout:coordinator']['ctrl-cmd-1'], 'tab.next')
  assert.deepEqual(kept.skipped, ['layout:coordinator ctrl-cmd-1'])
})
