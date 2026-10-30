import { expect } from 'claude-code/testing'
import { BATCH_MS, PROMPT_CHECK_MS } from '../hooks/defaults'
import { settled, spawn, start, stopAll, test } from './harness'
import { watches } from './workerkit'

// The sweep: what one hc list per minute decides, tabs that close, and tabs that are gone. See tests/quiet.test.tsx for the quiet-screen rule.

// It runs 15 minutes or more of sweeps, which a busy CI runner can take most of the default 5 s over.
test("a reported worker's tab closes once it has sat idle, unless its question is still open", { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, typed, closed, files } = await start($, on)
  const report = async (worker: string, text: string) => {
    await spawn($, [worker])
    await clock.settle()
    const token = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
    files[`/repo-${worker}/.herdr-agents/${worker}/RESULT.md`] = `<!-- report ${token} -->\n${text}`
  }
  await report('w-done', 'Reviewed: approve.')
  await report('w-ask', 'DECISION: Ship it today? | Yes | No')
  // hc shows this one still working after its report.
  await report('w-busy', 'Reviewed: two blockers.')
  // The first sweep reports all three: w-busy stays working, so its wait is not finished.
  await clock.advance(60_000)

  await clock.advance(29 * 60_000)
  expect(closed).toEqual([])
  await clock.advance(2 * 60_000)
  expect(closed).toEqual(['w-done'])
  const late = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: 'One more thing.' })
  expect(JSON.stringify(late)).toMatch(/tab is closed\. Spawn a fresh worker in \/repo-w-done/)

  // Once its question is settled, the worker that asked it goes too.
  await $.tool.call({ tool: 'mcp__herdr-agents__decided', ids: ['D1'], answer: 'Yes', by: 'owner' })
  await clock.advance(60_000)
  expect(closed).toEqual(['w-done', 'w-ask'])
  await stopAll($, clock, ['w-busy'])
})

test('one failed hc call does not end a job; a tab missing from two sweeps does', async ($, on) => {
  const { clock, submitted, typed, fail, gone, kill } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  // The sweep's list and the board's get both fail once: the job stays as it is.
  fail.get = 1
  fail.list = 1
  await clock.advance(60_000)
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  expect(reports()).toHaveLength(0)
  const sent = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  expect(JSON.stringify(sent)).toMatch(/while it works/)
  expect(typed.at(-1)).toMatch(/while you work/)

  // The tab is gone: the first sweep that misses it counts one, the second reports it.
  gone.add('w-busy')
  await kill('w-busy')
  await clock.advance(60_000)
  expect(reports()).toHaveLength(0)
  await clock.advance(60_000)
  await clock.advance(BATCH_MS)
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toMatch(/status="gone">\nThe worker stopped \(its tab is gone\)/)
})

test('a sweep reads hc once for all workers', async ($, on) => {
  const { clock, calls, emit } = await start($, on)
  const names = ['w-a', 'w-b', 'w-c']
  await spawn($, names)
  for (const name of names) await emit(name, 'working')
  calls.length = 0
  await clock.advance(5 * 60_000)
  // One list per sweep, however many workers run, and no other hc call: the 3 s ticks read files only.
  expect(calls.map(c => c.join(' '))).toEqual(Array(5).fill('hc ls --json --label herdr-agents.role=worker'))
  await stopAll($, clock, names)
})

// It runs 15 minutes or more of sweeps, which a busy CI runner can take most of the default 5 s over.
test('a failed sweep does not mark a reported tab closed', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, typed, closed, files, fail } = await start($, on)
  await spawn($, ['w-done'])
  await clock.settle()
  const token = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-done/.herdr-agents/w-done/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(60_000)
  await clock.advance(29 * 60_000)
  expect(closed).toEqual([])
  // The sweep at minute 31 cannot list hc, so it closes nothing and marks nothing.
  fail.list = 1
  await clock.advance(60_000)
  expect(closed).toEqual([])
  await clock.advance(60_000)
  expect(closed).toEqual(['w-done'])
  const late = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: 'One more thing.' })
  expect(JSON.stringify(late)).toMatch(/tab is closed/)
})

test('a sweep arms a new wait for a worker whose wait child died while it still works', async ($, on) => {
  const { clock, submitted, calls, typed, files, kill, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const armedFinish = () => watches(calls, 'w-busy')
  expect(armedFinish()).toBe(1)
  await kill('w-busy')
  // No report yet, and hc still shows it working: the sweep arms its watch again.
  await clock.advance(60_000)
  expect(submitted.filter(t => t.includes('<herdr-agent'))).toEqual([])
  expect(armedFinish()).toBe(2)
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

// It runs 15 minutes or more of sweeps, which a busy CI runner can take most of the default 5 s over.
test('a reported worker hc no longer lists is marked closed, with no kill to make', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, closed, typed, files, gone } = await start($, on)
  await spawn($, ['w-done'])
  await clock.settle()
  const token = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-done/.herdr-agents/w-done/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(60_000)
  // hc drops the terminal: the sweep's list leaves it out, and no kill is made.
  gone.add('w-done')
  await clock.advance(30 * 60_000)
  expect(closed).toEqual([])
  const late = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: 'One more thing.' })
  expect(JSON.stringify(late)).toMatch(/tab is closed/)
})

test('a prompt that never arrived is not reported over a newer prompt to the same worker', async ($, on) => {
  const { clock, submitted, stalls } = await start($, on)
  stalls['w-lost'] = 3
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-lost', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it.' })
  await settled()
  // Stopped and spawned again before the lost report is due: the new prompt is the one running.
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-lost' })
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-lost', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it again.' })
  await settled()
  await clock.advance(PROMPT_CHECK_MS)
  await clock.advance(10_000)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-lost"'))).toEqual([])
  await stopAll($, clock, ['w-lost'])
})
