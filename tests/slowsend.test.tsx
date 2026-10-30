import { expect } from 'claude-code/testing'
import { BATCH_MS, PROMPT_WAIT_MS, SWEEP_MS } from '../hooks/defaults'
import { settled, start, stopAll, test } from './harness'

// One worker's long send (a prompt that has not started work) must hold up only that worker's own steps.

const spawnAt = async ($: Parameters<typeof start>[0], worker: string) => {
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker, profile: 'builder', cwd: `/repo-${worker}`, task: 'Fix it.' })
  await settled()
}

test("a worker's long send does not delay the sweep's checks of the next worker", async ($, on) => {
  const { clock, submitted, holds, status } = await start($, on)
  holds.add('w-a')
  await spawnAt($, 'w-a')
  await spawnAt($, 'w-b')
  status['w-b'] = 'blocked'
  // w-a comes first in the sweep, and its send lasts minutes.
  await clock.advance(SWEEP_MS)
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-b"') && t.includes('status="blocked"'))).toHaveLength(1)
  holds.delete('w-a')
  status['w-a'] = 'working'
  await clock.advance(PROMPT_WAIT_MS)
  await stopAll($, clock, ['w-a', 'w-b'])
})

test('a sweep step that waited behind a send does not judge the worker on its old list', async ($, on) => {
  const { clock, submitted, holds, status } = await start($, on)
  holds.add('w-a')
  await spawnAt($, 'w-a')
  // The sweep lists it as errored and its step waits behind the send; by the time the send ends it works.
  status['w-a'] = 'error'
  await clock.advance(SWEEP_MS)
  status['w-a'] = 'idle'
  await clock.advance(SWEEP_MS)
  holds.delete('w-a')
  status['w-a'] = 'working'
  await clock.advance(PROMPT_WAIT_MS)
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('status="error"'))).toEqual([])
  await stopAll($, clock, ['w-a'])
})

test("the sweep's close step does not wait for a worker's long send", { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, closed, holds, typed, files, finish, status } = await start($, on)
  await spawnAt($, 'w-old')
  const token = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-old/.herdr-agents/w-old/RESULT.md'] = `<!-- report ${token} -->\nDone.`
  await finish('w-old')
  await clock.advance(BATCH_MS)
  await clock.advance(29 * 60_000)
  holds.add('w-a')
  await spawnAt($, 'w-a')
  await clock.advance(2 * 60_000)
  expect(closed).toEqual(['w-old'])
  holds.delete('w-a')
  status['w-a'] = 'working'
  await clock.advance(PROMPT_WAIT_MS)
  await stopAll($, clock, ['w-a'])
})
