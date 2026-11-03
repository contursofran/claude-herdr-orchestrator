import { expect } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { pinTmp } from '../hooks/tmpguard'
import { W } from './workerkit'
import { settled, start, test, until } from './harness'

// A worker's Bash runs with TMPDIR in its job folder, because the sandbox's own /tmp/claude-<uid> is shared (#161).

const LIVE = `${W}/LIVE.json`
const IN_WORKER = { HERDR_AGENTS_ROLE: 'worker', HERDR_AGENTS_LIVE: LIVE }

const run = async (...[$, on, env]: [...Parameters<TestBody>, Record<string, string>]) => {
  const seen: string[] = []
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    seen.push((e as unknown as { command: string }).command)
    return { result: { stdout: '' } } as never
  })
  await start($, on, {}, {}, env)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await settled()
  return seen
}

test('worker Bash command gets TMPDIR pinned', async ($, on) => {
  expect(await run($, on, IN_WORKER)).toEqual([`export TMPDIR='${W}/tmp'; ls`])
})

test('coordinator Bash is left alone', async ($, on) => {
  expect(await run($, on, {})).toEqual(['ls'])
})

test('worker without HERDR_AGENTS_LIVE is left alone', async ($, on) => {
  expect(await run($, on, { HERDR_AGENTS_ROLE: 'worker' })).toEqual(['ls'])
})

test("the live line still names the model's command, not the prefix", async ($, on) => {
  let finish = () => {}
  on('tool.call', { tool: 'Bash' }, () => new Promise(resolve => (finish = () => resolve({ result: { stdout: '' } } as never))) as never)
  const { clock, files } = await start($, on, {}, {}, IN_WORKER)
  const live = () => JSON.parse(files[LIVE] ?? '{}')
  await $.turn.start({ text: 'Go.', turnId: 't1' })
  const call = $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await until(clock, () => live().command === 'ls')
  expect(live().command).toBe('ls')
  finish()
  await call
  await settled()
})

test('pinTmp quotes a path with a quote and a space', () => {
  expect(pinTmp('ls', "/a b/it's/tmp")).toBe(`export TMPDIR='/a b/it'\\''s/tmp'; ls`)
})

test('pinTmp does not prefix twice', () => {
  const once = pinTmp('ls', '/j/tmp')
  expect(pinTmp(once, '/j/tmp')).toBe(once)
})
