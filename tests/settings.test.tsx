import { expect } from 'claude-code/testing'
import { BAND, command, start, test } from './harness'

// /hrd-config: the settings listed on the band, saved to the user's or the folder's file.

test('the settings on the band save to the chosen file and refuse bad values', async ($, on) => {
  const { clock, files } = await start($, on)
  expect((await command($, 'hrd-config')).text).toMatch(/Settings are above the prompt: alt\+d/)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const user = () => JSON.parse(files['/home/t/.claude/herdr-agents.json']!)

  // A row per setting, its value on the right, as /config reads.
  expect((await ui.find({ key: 'cfg-target' }))?.text).toMatch(/^  Workers to keep busy +4 \(default\)$/)
  expect((await ui.find({ type: 'Text', text: /Builder/ }))?.text).toMatch(/^  Builder +always on/)
  expect(await ui.find({ key: 'cfg-off-builder' })).toBeUndefined()

  // Enter on a text row opens a field in its place; Enter there saves to all folders by default,
  // and the user file keeps its other keys.
  const edit = async (key: string, text: string) => {
    await ui.press({ key })
    await ui.input({ key: 'cfg-edit', text })
  }
  await edit('cfg-target', '2')
  expect(user()).toEqual({ repos: { web: 'acme/website' }, target: 2 })
  expect((await ui.find({ type: 'Text', text: /Saved target/ }))?.text).toBe('  Saved target = 2 in /home/t/.claude/herdr-agents.json.')
  expect((await ui.find({ key: 'cfg-target' }))?.text).toMatch(/Workers to keep busy +2$/)

  await edit('cfg-target', 'lots')
  expect((await ui.find({ type: 'Text', text: /whole number/ }))?.text).toBe('  target must be a whole number of at least 1.')
  expect(user().target).toBe(2)

  // Enter on the scope row switches to this folder's file; a switch there goes to it, and back on drops it.
  await ui.press({ key: 'cfg-scope' })
  expect((await ui.find({ key: 'cfg-scope' }))?.text).toMatch(/Edit settings for +this folder ›$/)
  // The hint line names the file the changes go to.
  expect((await ui.find({ type: 'Text', text: /herdr-agents.json/ }))?.text).toBe('  /repo/.claude/herdr-agents.json')
  await ui.press({ key: 'cfg-off-reviewer' })
  expect(JSON.parse(files['/repo/.claude/herdr-agents.json']!)).toEqual({ disable: ['reviewer'] })
  expect((await ui.find({ key: 'cfg-off-reviewer' }))?.text).toMatch(/Reviewer +off/)
  await ui.press({ key: 'cfg-off-reviewer' })
  expect(JSON.parse(files['/repo/.claude/herdr-agents.json']!)).toEqual({})
  // Small tasks steps from nobody through the profiles that are on.
  await ui.press({ key: 'cfg-smallTasks' })
  expect(JSON.parse(files['/repo/.claude/herdr-agents.json']!)).toEqual({ smallTasks: 'planner' })

  // An empty field drops the key from the file it edits.
  await ui.press({ key: 'cfg-scope' })
  await edit('cfg-target', '')
  expect(user()).toEqual({ repos: { web: 'acme/website' } })

  // A file that is not valid JSON is left alone.
  files['/home/t/.claude/herdr-agents.json'] = '{ broken'
  await edit('cfg-resetAt', '150000')
  expect(files['/home/t/.claude/herdr-agents.json']).toBe('{ broken')
  expect((await ui.find({ type: 'Text', text: /not valid JSON/ }))?.text).toMatch(/fix it by hand first/)

  // The mobile app draws no fields: its band stays the engine's.
  const phone = await $.ui.mount({ ...BAND, surface: 'mobile' })
  expect((await phone.find({ type: 'Text', text: /engine band/ }))?.text).toBe('engine band')
  await phone.unmount()

  // Done gives the band back.
  await ui.press({ key: 'cfg-done' })
  expect(await ui.find({ key: 'cfg-target' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /engine band/ }))?.text).toBe('engine band')
  await ui.unmount()
  await clock.advance(3000)
})
