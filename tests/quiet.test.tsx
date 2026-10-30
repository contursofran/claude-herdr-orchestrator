import { expect } from 'claude-code/testing'
import { BATCH_MS } from '../hooks/defaults'
import { spawn, start, stopAll, test } from './harness'

// The quiet-screen rule: a worker that stops without a report. These run an hour of simulated ticks, so they get a file of their own.

// It runs an hour of refreshes, which a busy CI runner can take most of the default 5 s over.
test(
  'a worker that stops without a report is reported once its screen sits still; background work of its own buys it an hour',
  { timeoutMs: 20_000 },
  async ($, on) => {
    const { clock, submitted, screens } = await start($, on)
    const box = '────\n❯ \n────\n  aerolab · wt · Haiku 5.5 (xhigh)'
    // Its messages say "1 shell" and "still running", and every footer shows "← 1 agent".
    screens['w-done'] =
      `⏺ Ran 1 shell command\n  The east shot is still running.\n${box}\n  ⏵⏵ auto mode on (shift+tab to cycle) · PR #12 · ← 1 agent`
    screens['w-shell'] = `⏺ Waiting for the dev server.\n${box}\n  ⏵⏵ auto mode on · 1 shell · ← 1 agent`
    screens['w-sub'] = `⏺ Waiting on the review.\n${box}\n  ⏵⏵ auto mode on\n  ⏺ main\n  ◯ general-purpose  Review the diff`
    await spawn($, ['w-done', 'w-shell', 'w-sub'])
    const reports = (name: string) => submitted.filter(t => t.includes(`<herdr-agent name="${name}"`))

    await clock.advance(7 * 60_000)
    expect(reports('w-done')[0]).toMatch(/stopped \(done, screen unchanged for 5 min\) without writing RESULT\.md/)
    expect(reports('w-shell')).toEqual([])
    expect(reports('w-sub')).toEqual([])

    await clock.advance(55 * 60_000)
    expect(reports('w-shell')[0]).toMatch(/screen unchanged for 60 min/)
    expect(reports('w-sub')).toHaveLength(1)
  },
)

// It runs 15 minutes or more of sweeps, which a busy CI runner can take most of the default 5 s over.
test('a failed pane read starts no quiet clock', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock, submitted, screens, fail } = await start($, on)
  screens['w-quiet'] = '⏺ Done.\n────\n❯ \n────\n  aerolab · wt · Haiku 5.5 (xhigh)'
  await spawn($, ['w-quiet'])
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-quiet"'))
  // Every screen read fails for ten minutes: an error is not a screen that sits still.
  fail.pane = 100
  await clock.advance(10 * 60_000)
  expect(reports()).toEqual([])
  fail.pane = 0
  // The first good read, at minute 11, starts the clock; five quiet minutes reports it.
  await clock.advance(4 * 60_000)
  expect(reports()).toEqual([])
  await clock.advance(2 * 60_000)
  await clock.advance(BATCH_MS)
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toMatch(/stopped \(idle, screen unchanged for 5 min\)/)
  await stopAll($, clock, ['w-quiet'])
})
