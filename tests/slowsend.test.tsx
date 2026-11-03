import { expect } from 'claude-code/testing'
import { BATCH_MS, LOST_REPORT_MS, MESSAGE_WAIT_MS, PROMPT_CHECK_MS, PROMPT_WAIT_MS, SEND_DEADLINE_MS, SWEEP_MS } from '../hooks/defaults'
import { jobOf } from './workerkit'
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

// Holds a send until its worker lists as errored, and lets the send end with work started: the list is under a sweep old.
const errorListedDuringSend = async ($: Parameters<typeof start>[0], on: Parameters<typeof start>[1]) => {
  const started = await start($, on)
  const { clock, holds, status } = started
  holds.add('w-a')
  await spawnAt($, 'w-a')
  status['w-a'] = 'error'
  await clock.advance(SWEEP_MS)
  holds.delete('w-a')
  status['w-a'] = 'working'
  await clock.advance(PROMPT_CHECK_MS)
  return started
}

test('a list under a sweep old, taken before a send ended, does not report an error', async ($, on) => {
  const { clock, submitted } = await errorListedDuringSend($, on)
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('status="error"'))).toEqual([])
  await stopAll($, clock, ['w-a'])
})

test('a list taken after the send still reports a real error', async ($, on) => {
  const { clock, submitted, status } = await errorListedDuringSend($, on)
  status['w-a'] = 'error'
  await clock.advance(SWEEP_MS)
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-a"') && t.includes('status="error"'))).toHaveLength(1)
  await stopAll($, clock, ['w-a'])
})

test('a message typed in while the list was out keeps that list from judging the worker', async ($, on) => {
  const { clock, submitted, status, gate } = await start($, on)
  await spawnAt($, 'w-a')
  status['w-a'] = 'working'
  const release = gate(argv => argv[0] === 'hc' && argv[1] === 'ls')
  await clock.advance(SWEEP_MS)
  await clock.advance(PROMPT_CHECK_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'One more thing.' })
  // The fake answers a held call when it is released, so this is what the list saw before the message.
  status['w-a'] = 'error'
  release()
  await settled()
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('status="error"'))).toEqual([])
  status['w-a'] = 'working'
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

// A worker that reported and now gets a message: the message goes in as a new prompt, which a slow worker takes minutes to start on.
const reportedWorker = async (started: Awaited<ReturnType<typeof start>>, $: Parameters<typeof start>[0], worker: string) => {
  const { clock, typed, files, finish } = started
  await spawnAt($, worker)
  const token = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  files[`/repo-${worker}/.herdr-agents/${worker}/RESULT.md`] = `<!-- report ${token} -->\nDone.`
  await finish(worker)
  await clock.advance(BATCH_MS)
}

test('a message to a worker whose send is slow returns promptly, and is still delivered', async ($, on) => {
  const started = await start($, on)
  const { clock, holds, typed, status, submitted } = started
  await reportedWorker(started, $, 'w-a')
  holds.add('w-a')
  const called = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'Also check the docs.' })
  await clock.advance(MESSAGE_WAIT_MS)
  expect(JSON.stringify(await called)).toContain('Queued')
  // The call is over, and the send is still waiting for the worker to start.
  holds.delete('w-a')
  status['w-a'] = 'working'
  await clock.advance(PROMPT_WAIT_MS)
  expect(typed.some(t => t.includes('Also check the docs.'))).toBe(true)
  expect(submitted.filter(t => t.includes('not sent'))).toEqual([])
  await stopAll($, clock, ['w-a'])
})

test('a message after a queued one waits behind it instead of overtaking it', async ($, on) => {
  const started = await start($, on)
  const { clock, holds, typed, status } = started
  await reportedWorker(started, $, 'w-a')
  holds.add('w-a')
  const first = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'First.' })
  await clock.advance(MESSAGE_WAIT_MS)
  await first
  const second = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'Second.' })
  await clock.advance(MESSAGE_WAIT_MS)
  await second
  // The first has not gone in, so the second is not typed yet.
  expect(typed.some(t => t.includes('extra message while you work'))).toBe(false)
  holds.delete('w-a')
  status['w-a'] = 'working'
  await clock.advance(PROMPT_WAIT_MS)
  await clock.advance(PROMPT_WAIT_MS)
  // The first goes in as a prompt with its text; the second, typed to the working worker, names its file.
  const at1 = typed.findIndex(t => t.includes('First.'))
  const at2 = typed.findIndex(t => t.includes('extra message while you work'))
  expect(at1).toBeGreaterThan(-1)
  expect(at2).toBeGreaterThan(at1)
  await stopAll($, clock, ['w-a'])
})

test('a reload while a queued message was being sent names it to the coordinator', async ($, on) => {
  const job = {
    name: 'w',
    profile: 'builder',
    cwd: '/repo/wt',
    dir: '/repo/wt/.herdr-agents/w',
    startedAt: 1,
    status: 'running',
    token: 'tok1',
    address: 't12',
    sending: ['/repo/wt/.herdr-agents/w/MESSAGE-1-abcd.md'],
  }
  const { clock, submitted, store } = await start($, on, {}, { 'jobs:session-1234': { at: 1, jobs: { w: job } } })
  await clock.settle()
  await clock.advance(BATCH_MS)
  expect(submitted.join('\n')).toContain('MESSAGE-1-abcd.md')
  expect(jobOf(store, 'w').sending).toBeUndefined()
})

test('a stop while a message is queued drops it: it is named as not sent and never typed', async ($, on) => {
  const started = await start($, on)
  const { clock, holds, typed, status, submitted, store } = started
  await reportedWorker(started, $, 'w-a')
  holds.add('w-a')
  // The first is already being typed in (held); the second waits behind it.
  const first = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'First.' })
  await clock.advance(MESSAGE_WAIT_MS)
  await first
  const second = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'Second.' })
  await clock.advance(MESSAGE_WAIT_MS)
  expect(JSON.stringify(await second)).toContain('Queued')
  const stopped = JSON.stringify(await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-a' }))
  expect(stopped).toContain('queued message(s) were still being sent and will not be sent')
  expect(stopped).toContain('MESSAGE-')
  expect(stopped).toContain('2 queued message(s)')
  const before = typed.length
  holds.delete('w-a')
  status['w-a'] = 'working'
  await clock.advance(PROMPT_WAIT_MS)
  await clock.advance(BATCH_MS)
  // Nothing went into the stopped worker, and no second notice came for the same message.
  expect(typed.slice(before).some(t => t.includes('Second.'))).toBe(false)
  expect(submitted.filter(t => t.includes('was not sent'))).toEqual([])
  // The stopped job is not brought back to running by the dropped send.
  expect(jobOf(store, 'w-a').status).toBe('reported')
})

test('a queued message whose send times out is not reported as failed, and is not typed again', async ($, on) => {
  const started = await start($, on)
  const { clock, slowSend, submitted, typed } = started
  await reportedWorker(started, $, 'w-a')
  slowSend.add('w-a')
  const called = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'Also check the docs.' })
  await clock.advance(MESSAGE_WAIT_MS)
  await called
  // The worker never starts: the coordinator is told the message may still arrive, not that it failed.
  await clock.advance(SEND_DEADLINE_MS + LOST_REPORT_MS)
  await clock.advance(BATCH_MS)
  expect(typed.filter(t => t.includes('Also check the docs.'))).toHaveLength(1)
  expect(submitted.filter(t => t.includes('was not sent') || t.includes('could not type'))).toEqual([])
  expect(submitted.filter(t => t.includes('its prompt may still arrive'))).toHaveLength(1)
  await stopAll($, clock, ['w-a'])
})

test('a queued message that cannot be typed in is reported to the coordinator once it fails', async ($, on) => {
  const started = await start($, on)
  const { clock, holds, status, submitted, gate } = started
  await reportedWorker(started, $, 'w-a')
  holds.add('w-a')
  const first = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'First.' })
  await clock.advance(MESSAGE_WAIT_MS)
  await first
  const second = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-a', text: 'Second.' })
  await clock.advance(MESSAGE_WAIT_MS)
  expect(JSON.stringify(await second)).toContain('Queued')
  // The first goes in; the second is typed to a worker that now waits at a prompt, and fails.
  const release = gate(argv => argv[0] === 'hc' && argv[1] === 'send' && argv.join(' ').includes('extra message'))
  holds.delete('w-a')
  status['w-a'] = 'working'
  await clock.advance(PROMPT_WAIT_MS)
  status['w-a'] = 'blocked'
  release()
  await settled()
  await clock.advance(BATCH_MS)
  const notice = submitted.filter(t => t.includes('The message you queued for it was not sent'))
  expect(notice).toHaveLength(1)
  expect(notice[0]).toContain('could not type the message into w-a')
  expect(notice[0]).toContain('MESSAGE-')
  status['w-a'] = 'working'
  await stopAll($, clock, ['w-a'])
})
