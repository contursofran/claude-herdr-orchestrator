import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { app, findId, textOf } from './fake-gpui.mjs'

const model = await import('../mods/herdr-agents/settingsmodel.js')
const { SettingsState, settingsView, openSettings } = await import('../mods/herdr-agents/settingsview.js')
const { TEXT_SETTINGS, applyPress, applyText, fileText, isSettingsCommand, parseFile, parseText, settingRows, smallTaskChoices } = model

const pane = (user = {}, folder, scope = 'user') => ({ scope, user, folder })
const row = (p, key) => settingRows(p).find(r => r.key === key)
const press = (c, key, p) => (applyPress(c, key, p), c)

test('the defaults and limits match the plugin', () => {
  const defaults = readFileSync(new URL('../../hooks/defaults.ts', import.meta.url), 'utf8')
  const value = name => new RegExp(`export const ${name} = (.+)`).exec(defaults)[1].replace(/_/g, '').replace(/'/g, '').trim()
  const initial = Object.fromEntries(TEXT_SETTINGS.map(s => [s.key, String(s.initial)]))
  assert.equal(initial.target, value('TARGET'))
  assert.equal(initial.resetAt, value('RESET_AT'))
  assert.equal(initial.commandPrefix, value('PREFIX'))
  assert.equal(initial.pruneMinutes, value('PRUNE_MINUTES'))
  assert.equal(initial.closeIdleMinutes, value('CLOSE_IDLE_MINUTES'))
  const tsx = readFileSync(new URL('../../hooks/settings.tsx', import.meta.url), 'utf8')
  for (const s of TEXT_SETTINGS) {
    assert.match(tsx, new RegExp(`\\['${s.key}', '${s.label}'|'${s.key}',\\s+'${s.label}'`), s.key)
    if (s.min !== undefined) assert.match(tsx, new RegExp(`\\b${s.key}: ${s.min === 10000 ? '10_000' : s.min}\\b`), s.key)
  }
})

test('text rows: the file value, or what is in effect and where from', () => {
  assert.equal(row(pane(), 'target').raw, '')
  assert.equal(row(pane(), 'target').inEffect, '4 (default)')
  assert.equal(row(pane({ target: 3 }), 'target').raw, '3')
  assert.equal(row(pane({ target: 3 }), 'target').inEffect, null)
  assert.equal(row(pane({ target: 3 }, {}, 'folder'), 'target').inEffect, '3 (all folders)')
  assert.equal(row(pane({ target: 3 }, { target: 2 }, 'folder'), 'target').raw, '2')
})

test('typed values: numbers are checked, empty removes the key', () => {
  assert.equal(parseText('target', '3'), 3)
  assert.deepEqual(parseText('target', '0').error.includes('at least 1'), true)
  assert.equal(parseText('pruneMinutes', '0'), 0)
  assert.ok(parseText('resetAt', '9999').error)
  assert.ok(parseText('target', '2.5').error)
  assert.ok(parseText('commandPrefix', 'No Way').error)
  assert.equal(parseText('statePath', ' notes.md '), 'notes.md')
  const c = { target: 3 }
  assert.equal(applyText(c, 'target', ' '), null)
  assert.deepEqual(c, {})
  const refused = { target: 3 }
  assert.ok(applyText(refused, 'target', 'x').error)
  assert.deepEqual(refused, { target: 3 })
})

test('presses edit the file as /hrd-config does', () => {
  assert.deepEqual(press({}, 'wrapUp', pane()), { wrapUp: true })
  assert.deepEqual(press({ wrapUp: true }, 'wrapUp', pane()), {})
  assert.deepEqual(press({}, 'off:reviewer', pane()), { disable: ['reviewer'] })
  assert.deepEqual(press({ disable: ['reviewer'] }, 'off:reviewer', pane({ disable: ['reviewer'] })), {})
  // A folder starts from the all-folders list, and an empty list overrides it.
  assert.deepEqual(press({}, 'off:planner', pane({ disable: ['reviewer'] }, {}, 'folder')), { disable: ['reviewer', 'planner'] })
  assert.deepEqual(press({}, 'off:reviewer', pane({ disable: ['reviewer'] }, {}, 'folder')), { disable: [] })
})

test('small tasks step through nobody and each profile that is on', () => {
  const p = pane({ profiles: { luna: {} }, disable: ['reviewer'] })
  assert.deepEqual(smallTaskChoices(p), ['nobody', 'planner', 'builder', 'debugger', 'luna'])
  assert.deepEqual(press({}, 'smallTasks', p), { smallTasks: 'planner' })
  assert.deepEqual(press({ smallTasks: 'luna' }, 'smallTasks', pane({ profiles: { luna: {} }, smallTasks: 'luna' })), {})
  // A folder writes null to override the file for all folders.
  const folder = pane({ profiles: { luna: {} }, smallTasks: 'luna' }, {}, 'folder')
  assert.deepEqual(press({}, 'smallTasks', folder), { smallTasks: null })
  assert.equal(row(pane({ smallTasks: 'luna' }, { smallTasks: null }, 'folder'), 'smallTasks').value, 'nobody')
})

test('other settings in the file survive an edit', () => {
  const c = { profiles: { luna: { kind: 'codex' } }, playbook: 'x', target: 4 }
  applyText(c, 'target', '2')
  applyPress(c, 'wrapUp', pane(c))
  assert.deepEqual(JSON.parse(fileText(c)), { profiles: { luna: { kind: 'codex' } }, playbook: 'x', target: 2, wrapUp: true })
})

test('a broken file is reported, not read as empty', () => {
  assert.deepEqual(parseFile(null), {})
  assert.deepEqual(parseFile('{"target":2}'), { target: 2 })
  assert.ok(parseFile('{"target":').error)
  assert.ok(parseFile('[1]').error)
})

test('the command name', () => {
  assert.equal(isSettingsCommand('herdr-agents.settings'), true)
  assert.equal(isSettingsCommand('herdr-agents.sheet'), false)
})

// The dialog against a fake file system: writes check `expected` as the real writeTextFile does.
const USER = '/home/.claude/herdr-agents.json'
const FOLDER = '/repo/.claude/herdr-agents.json'
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const cx = { notify() {}, spawn: f => f(cx) }

async function open(files = {}, folder = '/repo') {
  app.files = files
  app.props = { role: 'settings', folder, overlay: 'o1' }
  const state = new SettingsState(cx)
  await tick()
  return state
}

beforeEach(() => {
  app.store = {}
  app.opened = []
  app.closed = []
  app.writes = []
})

test('opening passes the folder of the coordinator shown', () => {
  openSettings('/repo')
  assert.equal(app.opened.at(-1).kind, 'dialog')
  assert.deepEqual(app.opened.at(-1).props, { role: 'settings', folder: '/repo' })
})

test('opening again replaces the open dialog, even if it was closed behind our back', () => {
  openSettings('/repo')
  const first = app.store['hrd.settings']
  openSettings('/repo')
  assert.deepEqual(app.closed, [first])
  assert.equal(app.store['hrd.settings'], `o${app.opened.length}`)
  app.closeThrows = true
  openSettings('/repo')
  app.closeThrows = false
  assert.equal(app.store['hrd.settings'], `o${app.opened.length}`)
})

test('the dialog shows the file and saves a press to it, keeping the rest', async () => {
  const state = await open({ [USER]: '{"target":3,"playbook":"x"}' })
  assert.equal(state.inputs.target.value(), '3')
  state.press('wrapUp', cx)
  await tick()
  assert.deepEqual(JSON.parse(app.files[USER]), { target: 3, playbook: 'x', wrapUp: true })
  assert.match(state.note, /Saved/)
  const root = settingsView(state, cx)
  assert.ok(textOf(findId(root, 'settings-status')).join('').includes(USER))
})

test('a typed value saves on commit; a refused one writes nothing and says why', async () => {
  const state = await open({ [USER]: '{}' })
  state.inputs.target.type('2')
  state.inputs.target.fire('blur', cx)
  await tick()
  assert.deepEqual(JSON.parse(app.files[USER]), { target: 2 })
  const before = app.files[USER]
  state.inputs.target.type('nope')
  state.inputs.target.fire('submit', cx)
  await tick()
  assert.equal(app.files[USER], before)
  assert.match(state.error, /whole number/)
})

test('an unchanged field writes nothing when it loses focus', async () => {
  const state = await open({ [USER]: '{"target":3}' })
  state.inputs.target.fire('blur', cx)
  await tick()
  assert.equal(app.files[USER], '{"target":3}')
  assert.equal(state.note, null)
})

test('a broken file is left alone', async () => {
  const state = await open({ [USER]: '{"target":' })
  assert.match(state.error, /not valid JSON/)
  state.press('wrapUp', cx)
  await tick()
  assert.equal(app.files[USER], '{"target":')
  assert.match(state.error, /not valid JSON/)
})

test('a file changed while saving is not overwritten', async () => {
  const state = await open({ [USER]: '{"target":3}' })
  app.staleWrite = true
  state.press('wrapUp', cx)
  await tick()
  app.staleWrite = false
  assert.equal(app.files[USER], '{"target":3}')
  assert.match(state.error, /Not saved/)
})

test('this folder edits its own file and creates it when absent', async () => {
  const state = await open({ [USER]: '{"target":3}' })
  state.setScope('folder', cx)
  await tick()
  assert.equal(state.inputs.target.value(), '')
  state.press('off:reviewer', cx)
  await tick()
  assert.deepEqual(JSON.parse(app.files[FOLDER]), { disable: ['reviewer'] })
  assert.equal(app.files[USER], '{"target":3}')
})

test('with no coordinator shown there is only the file for all folders', async () => {
  const state = await open({}, null)
  state.setScope('folder', cx)
  assert.equal(state.pane.scope, 'user')
  const root = settingsView(state, cx)
  assert.equal(findId(root, 'set-scope-folder'), null)
  assert.ok(findId(root, 'set-scope-user'))
})

test('a field mid-edit keeps its text when another save reloads the file', async () => {
  const state = await open({ [USER]: '{"target":3}' })
  state.inputs.resetAt.type('20000')
  state.press('wrapUp', cx)
  await tick()
  assert.equal(state.inputs.resetAt.value(), '20000')
})
