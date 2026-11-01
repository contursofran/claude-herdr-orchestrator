import { expect } from 'claude-code/testing'
import { start, test } from './harness'

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
