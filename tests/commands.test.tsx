import { expect, test } from 'claude-code/testing'
import { command, start } from './harness'

// The slash commands: their prefix and the guide.

test('commands share the hrd- prefix', async ($, on) => {
  const { clock } = await start($, on)
  expect((await command($, 'hrd-workers')).text).toBe('No herdr workers in this session.')
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
  expect((await command($, 'crew-decisions')).text).toBe('Nothing waiting for you.')
})
