import { expect } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { pinTmp, sharedTmp } from '../hooks/tmpguard'
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
