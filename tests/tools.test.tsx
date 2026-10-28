import { expect, test } from 'claude-code/testing'
import { BAND, command, start } from './harness'

// The spawn tool's description lists the profiles in the config; it is rebuilt when they change.

const CONFIG = '/home/t/.claude/herdr-agents.json'
const spawnCalls = (toolCalls: string[]) => toolCalls.filter(n => n === 'spawn').length

test('the spawn description lists the profiles in the config at the next turn', async ($, on) => {
  const { clock, files, tools } = await start($, on, { profiles: { builder: { kind: 'claude', args: [], note: 'Sonnet 5.5 medium' } } })
  expect(tools.spawn?.description).toMatch(/builder = Sonnet 5\.5 medium/)
  files[CONFIG] = JSON.stringify({ profiles: { builder: { kind: 'claude', args: [], note: 'Haiku 5.5 xhigh' } } })
  await $.turn.start({ text: 'Go.', turnId: 't1' })
  await clock.settle()
  expect(tools.spawn?.description).toMatch(/builder = Haiku 5\.5 xhigh/)
})

test('an unchanged config does not register spawn again', async ($, on) => {
  const { clock, toolCalls } = await start($, on)
  expect(spawnCalls(toolCalls)).toBe(1)
  await $.turn.start({ text: 'One.', turnId: 't1' })
  await clock.settle()
  await $.turn.start({ text: 'Two.', turnId: 't2' })
  await clock.settle()
  expect(spawnCalls(toolCalls)).toBe(1)
})

test('a profile turned off in /hrd-config leaves the spawn description at once', async ($, on) => {
  const { clock, tools, toolCalls } = await start($, on)
  expect(tools.spawn?.description).toMatch(/reviewer = /)
  await command($, 'hrd-config')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'cfg-off-reviewer' })
  await clock.settle()
  expect(tools.spawn?.description).not.toMatch(/reviewer = /)
  expect(spawnCalls(toolCalls)).toBe(2)
})
