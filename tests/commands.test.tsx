import { expect } from 'claude-code/testing'
import { command, start, test } from './harness'

// The slash commands: their prefix and the guide.

test('commands share the hrd- prefix', async ($, on) => {
  const { clock } = await start($, on)
  expect((await command($, 'hrd-wrap-up')).text).toMatch(/\/hrd-wrap-up off ends it/)
  await clock.advance(3000)
  // The guide answers to help and h, and lists the commands with the prefix and the built-in profiles.
  const guide = (await command($, 'hrd-h')).text
  expect(guide).toBe((await command($, 'hrd-help')).text)
  expect(guide).toMatch(/\/hrd-orchestrate <goal>/)
  expect(guide).toMatch(/  Built in\n    planner .*\n    builder .*\n    reviewer .*\n    debugger .*\n  Small tasks go to nobody/)
})

test('a configured commandPrefix names the commands', async ($, on) => {
  await start($, on, { commandPrefix: 'crew-' })
  expect((await command($, 'crew-help')).text).toMatch(/\/crew-orchestrate <goal>/)
})

test('learning notes are off by default', async ($, on) => {
  const { clock } = await start($, on)
  expect((await command($, 'hrd-notes')).text).toMatch(/Learning notes are off/)
  await clock.advance(3000)
})

test('with learningNotes on, /hrd-notes asks for stubs in the vault folder and never the explanation', async ($, on) => {
  const { submitted, clock } = await start($, on, { learningNotes: { enabled: true, vault: '/vault', folder: 'Concepts' } })
  expect((await command($, 'hrd-notes')).text).toBe('Leaving learning notes in /vault/Concepts.')
  await clock.advance(10000)
  const rules = submitted.at(-1) ?? ''
  expect(rules).toMatch(/in \/vault\/Concepts/)
  expect(rules).toMatch(/## My explanation` with nothing under it/)
  expect(rules).toMatch(/Never write the explanation/)
  expect(rules).toMatch(/Never change, reword or fill in anything else in an existing note/)
})
