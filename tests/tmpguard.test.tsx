import { expect } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { sharedTmp } from '../hooks/tmpguard'
import { W } from './workerkit'
import { settled, start, test } from './harness'

const LIVE = `${W}/LIVE.json`
const IN_WORKER = { HERDR_AGENTS_ROLE: 'worker', HERDR_AGENTS_LIVE: LIVE }

// Write and Edit in a worker can't target a temp folder every session shares (#157).
const write = async (...[$, on, env, tool, file]: [...Parameters<TestBody>, Record<string, string>, 'Write' | 'Edit', string]) => {
  const reached: string[] = []
  on('tool.call', { tool }, (_, e) => {
    reached.push((e as unknown as { file_path: string }).file_path)
    return { result: {} } as never
  })
  await start($, on, {}, {}, env)
  const out = await $.tool.call({ tool, file_path: file } as never)
  await settled()
  return { reached, out: JSON.stringify(out ?? null) }
}

test('worker Write to /tmp/pr.md is denied and names the job tmp', async ($, on) => {
  const { reached, out } = await write($, on, IN_WORKER, 'Write', '/tmp/pr.md')
  expect(reached).toEqual([])
  expect(out).toContain(`/tmp/pr.md is in a shared temp folder`)
  expect(out).toContain(`Write it in ${W}/tmp instead`)
})

test('worker Write to /private/tmp/claude-501/x is denied', async ($, on) => {
  expect((await write($, on, IN_WORKER, 'Write', '/private/tmp/claude-501/x')).reached).toEqual([])
})

test('worker Write to <job>/tmp/pr.md goes through', async ($, on) => {
  expect((await write($, on, IN_WORKER, 'Write', `${W}/tmp/pr.md`)).reached).toEqual([`${W}/tmp/pr.md`])
})

test('worker Write to /tmp/../repo/x goes through', async ($, on) => {
  expect((await write($, on, IN_WORKER, 'Write', '/tmp/../repo/x')).reached).toEqual(['/tmp/../repo/x'])
})

test('coordinator Write to /tmp/x goes through', async ($, on) => {
  expect((await write($, on, {}, 'Write', '/tmp/x')).reached).toEqual(['/tmp/x'])
})

test('Edit to /tmp/x in a worker is denied', async ($, on) => {
  const { reached, out } = await write($, on, IN_WORKER, 'Edit', '/tmp/x')
  expect(reached).toEqual([])
  expect(out).toContain('shared temp folder')
})

test('sharedTmp knows the shared prefixes and ignores relative paths', () => {
  expect(['/var/tmp/a', '/private/var/tmp/a', '/tmp/a/../b'].map(sharedTmp)).toEqual([true, true, true])
  expect(['tmp/a', '/tmpx/a', '/tmp/../a'].map(sharedTmp)).toEqual([false, false, false])
})
