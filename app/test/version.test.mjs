import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app, textOf } from './fake-gpui.mjs'

const { readVersion, versionLabel, versionView } = await import('../mods/herdr-agents/version.js')
const FILE = '/app-home/mods/herdr-agents/version.json'

test('the label has the version and the commit', () => {
  assert.equal(versionLabel('{"version":"0.18.0","commit":"f623480"}'), 'herdr-agents 0.18.0 · f623480')
})

test('without a usable commit the label has only the version', () => {
  for (const text of ['{"version":"0.18.0"}', '{"version":"0.18.0","commit":""}', '{"version":"0.18.0","commit":7}']) {
    assert.equal(versionLabel(text), 'herdr-agents 0.18.0', text)
  }
})

test('a bad file gives no label and does not throw', () => {
  for (const text of [null, '', 'not json', 'null', '[]', '7', '{}', '{"version":""}', '{"version":1}', '{"commit":"f623480"}']) {
    assert.equal(versionLabel(text), null, String(text))
  }
})

test('the file is read from the installed mod; missing or unreadable gives null', async () => {
  app.files = { [FILE]: '{"version":"1.2.3"}' }
  assert.equal(await readVersion(), 'herdr-agents 1.2.3')
  app.files = {}
  assert.equal(await readVersion(), null)
  app.files = { [FILE]: new Error('no access') }
  assert.equal(await readVersion(), null)
})

test("the view draws the label in the bar's colours, with no interaction", () => {
  const { calls } = versionView('herdr-agents 1.2.3').node
  assert.deepEqual(textOf(versionView('herdr-agents 1.2.3')), ['herdr-agents 1.2.3'])
  assert.deepEqual([calls.bg[0], calls.border_color[0], calls.text_color[0]], ['#101010', '#202020', '#303030'])
  assert.equal(calls.id, undefined)
  assert.equal(calls.on_click, undefined)
})

test('with no label the view has no child at all: .child(null) throws in the app', () => {
  for (const label of [null, undefined, '']) assert.deepEqual(versionView(label).node.kids, [])
})
