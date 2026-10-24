import { expect, test } from 'claude-code/testing'
import { command, spawn, start, stopAll } from './harness'

// Starting workers: the rules spawn applies, from the built-in profiles in effect.

test('a turned-off built-in cannot start, and the rules name what replaces it', async ($, on) => {
  const { clock } = await start($, on, {
    disable: ['reviewer', 'debugger', 'builder'],
    profiles: { builder: { kind: 'claude', args: ['--model', 'sonnet'] } },
  })
  const denied = await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'w-rev',
    profile: 'reviewer',
    cwd: '/repo/wt',
    task: 'x',
  })
  expect(JSON.stringify(denied)).toMatch(/reviewer is turned off/)
  // The builder cannot be turned off; a second writer in its worktree waits until the first is stopped.
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'x' })
  const again = await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'w-two',
    profile: 'builder',
    cwd: '/repo/wt',
    task: 'y',
  })
  expect(JSON.stringify(again)).toMatch(/stop it first/)
  expect(JSON.stringify(again)).toMatch(/After two failed fix rounds, ask the owner with ask_owner instead/)

  // A changed built-in stays built in, marked customized.
  const guide = (await command($, 'hrd-help')).text
  expect(guide).toMatch(/    builder .* · customized\n/)
  expect(guide).toMatch(/    reviewer .* · off\n/)
  await stopAll($, clock, ['w-busy'])
})

test('a message after a report with DECISION lines reaches the worker as new text, not TASK.md again', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-done', profile: 'builder', cwd: '/repo/wt', task: 'Fix the nits.' })
  // herdr's wait answers at once for a worker that is already done: the mod sees that before the report is written.
  await clock.settle()
  const dir = '/repo/wt/.herdr-agents/w-done'
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${dir}/RESULT.md`] = `<!-- report ${token} -->\nStopped.\nDECISION: [Edit scope] May I edit CI scripts? | Yes (recommended) | No`
  await finish('w-done')
  expect(submitted.at(-1)).toMatch(/Pinned for the owner as D1/)

  // An empty message is refused and types nothing.
  const before = typed.length
  const empty = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: '  \n ' })
  expect(JSON.stringify(empty)).toMatch(/the message is empty/)
  expect(typed.length).toBe(before)

  const answer = 'D1 = yes, edit the CI scripts.\nKeep "head -n 1" and its `$1` as they are.'
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: `\n${answer}\n` })
  // The brief stays as it was; the answer is typed in and kept in a file of its own.
  expect(files[`${dir}/TASK.md`]).toBe('Fix the nits.')
  const sent = typed.at(-1) ?? ''
  expect(sent).toContain(answer)
  expect(sent).not.toContain('TASK.md')
  const saved = sent.match(/also saved in (\S+\/MESSAGE-\d+-\w+\.md)/)?.[1]
  expect(saved && files[saved]).toBe(answer)

  // A long message is only pointed to, in a file the worker has not read yet.
  files[`${dir}/RESULT.md`] = `<!-- report ${typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]} -->\nDone.`
  await finish('w-done')
  const long = 'x'.repeat(5000)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: long })
  const pointer = typed.at(-1)?.match(/New message from your coordinator in (\S+\/MESSAGE-\d+-\w+\.md), a file you have not read yet/)?.[1]
  expect(pointer && files[pointer]).toBe(long)
  expect(typed.at(-1)).not.toContain(long)
  await stopAll($, clock, ['w-done'])
})

test('a DECISION line that says none is not pinned for the owner', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-none', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await clock.settle()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-none/RESULT.md'] =
    `<!-- report ${token} -->\nOpened PR #4.\nDECISION: none. No owner decision is needed for this PR.\n**decision:** None\nDECISION: [Port] Which port? | 5173 (recommended) | 8080`
  await finish('w-none')
  const report = submitted.at(-1) ?? ''
  expect(report).toMatch(/Pinned for the owner as D1/)
  expect(report).not.toMatch(/D2/)
  await stopAll($, clock, ['w-none'])
})

test('a prompt that starts no work is typed again, and a worker it never reaches is reported blocked', async ($, on) => {
  const { clock, submitted, typed, files, stalls, finish } = await start($, on)
  // The first try stalls; the second starts work, so the worker runs on and reports.
  stalls['w-late'] = 1
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-late', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await clock.settle()
  expect(typed).toHaveLength(2)
  expect(typed[1]).toBe(typed[0])
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-late/RESULT.md'] = `<!-- report ${token} -->\nDone.`
  await finish('w-late')
  expect(submitted.at(-1)).toMatch(/<herdr-agent name="w-late" profile="builder" status="done">\nDone\./)

  // Every try stalls: reported blocked at once, not idle five minutes later.
  stalls['w-lost'] = 3
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-lost', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it.' })
  expect(typed).toHaveLength(5)
  await clock.advance(10_000)
  expect(submitted.at(-1)).toMatch(/status="blocked">\nThe worker stopped \(its prompt was not delivered: no work started after 3 tries\)/)
})

test("a reported worker's tab closes once it has sat idle, unless its question is still open", async ($, on) => {
  const { clock, typed, closed, files } = await start($, on)
  const report = async (worker: string, text: string) => {
    await spawn($, [worker])
    await clock.settle()
    const token = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
    files[`/repo-${worker}/.herdr-agents/${worker}/RESULT.md`] = `<!-- report ${token} -->\n${text}`
  }
  await report('w-done', 'Reviewed: approve.')
  await report('w-ask', 'DECISION: Ship it today? | Yes | No')
  // herdr shows this one still working after its report.
  await report('w-busy', 'Reviewed: two blockers.')
  // The first sweep reports all three: w-busy stays working, so its wait is not finished.
  await clock.advance(60_000)

  await clock.advance(29 * 60_000)
  expect(closed).toEqual([])
  await clock.advance(2 * 60_000)
  expect(closed).toEqual(['t-w-done'])
  const late = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: 'One more thing.' })
  expect(JSON.stringify(late)).toMatch(/tab is closed\. Spawn a fresh worker in \/repo-w-done/)

  // Once its question is settled, the worker that asked it goes too.
  await $.tool.call({ tool: 'mcp__herdr-agents__decided', ids: ['D1'], answer: 'Yes', by: 'owner' })
  await clock.advance(60_000)
  expect(closed).toEqual(['t-w-done', 't-w-ask'])
  await stopAll($, clock, ['w-busy'])
})

// It runs an hour of refreshes, which a busy CI runner can take most of the default 5 s over.
test(
  'a worker that stops without a report is reported once its screen sits still; background work of its own buys it an hour',
  { timeoutMs: 20_000 },
  async ($, on) => {
    const { clock, submitted, screens } = await start($, on)
    const box = '────\n❯ \n────\n  aerolab · wt · Haiku 5.5 (xhigh)'
    // Its messages say "1 shell" and "still running", and every footer shows "← 1 agent".
    screens['p-w-done'] =
      `⏺ Ran 1 shell command\n  The east shot is still running.\n${box}\n  ⏵⏵ auto mode on (shift+tab to cycle) · PR #12 · ← 1 agent`
    screens['p-w-shell'] = `⏺ Waiting for the dev server.\n${box}\n  ⏵⏵ auto mode on · 1 shell · ← 1 agent`
    screens['p-w-sub'] = `⏺ Waiting on the review.\n${box}\n  ⏵⏵ auto mode on\n  ⏺ main\n  ◯ general-purpose  Review the diff`
    await spawn($, ['w-done', 'w-shell', 'w-sub'])
    const reports = (name: string) => submitted.filter(t => t.startsWith(`<herdr-agent name="${name}"`))

    await clock.advance(7 * 60_000)
    expect(reports('w-done')[0]).toMatch(/stopped \(done, screen unchanged for 5 min\) without writing RESULT\.md/)
    expect(reports('w-shell')).toEqual([])
    expect(reports('w-sub')).toEqual([])

    await clock.advance(55 * 60_000)
    expect(reports('w-shell')[0]).toMatch(/screen unchanged for 60 min/)
    expect(reports('w-sub')).toHaveLength(1)
  },
)

test('a session whose $.state lost its jobs gets them back from the store; a report written meanwhile is delivered once', async ($, on) => {
  // What #11 saw: after /reload-plugins $.state had no jobs, though the workers ran on.
  const job = (name: string) => ({
    name,
    profile: 'reviewer',
    cwd: `/repo-${name}`,
    dir: `/repo-${name}/.herdr-agents/${name}`,
    startedAt: 900_000,
    status: 'running',
    token: `tok-${name}`,
  })
  const kept = {
    'jobs:session-1234': { at: 990_000, jobs: { 'w-one': job('w-one'), 'w-two': job('w-two') } },
    'jobs:old': { at: 0, jobs: {} },
  }
  const { clock, submitted, typed, files } = await start($, on, {}, kept)
  files['/repo-w-one/.herdr-agents/w-one/RESULT.md'] = '<!-- report tok-w-one -->\nReviewed: approve.'

  await clock.advance(10_000)
  const reports = () => submitted.filter(t => t.startsWith('<herdr-agent name="w-one"'))
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toContain('Reviewed: approve.')
  await clock.advance(30_000)
  expect(reports()).toHaveLength(1)

  // The other worker is still reachable.
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-two', text: 'Also check the docs.' })
  expect(typed.at(-1)).toMatch(/Your coordinator sent an extra message while you work/)
  await stopAll($, clock, ['w-two'])
})

// The argv of a worker's two herdr waits: its turn's end, and its next turn's start.
const FINISH = (name: string) => ['herdr', 'agent', 'wait', name, '--until', 'done', '--until', 'idle', '--until', 'blocked']
const RESUME = (name: string) => ['herdr', 'agent', 'wait', name, '--until', 'working', '--until', 'blocked']

test('a report is delivered the moment herdr sees the worker finish, and only once', async ($, on) => {
  const { clock, submitted, calls, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  expect(calls).toContainEqual(FINISH('w-busy'))
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  // No clock advance: herdr's answer to the wait is what delivers the report.
  await finish('w-busy')
  const reports = () => submitted.filter(t => t.startsWith('<herdr-agent name="w-busy"'))
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done">\nReviewed: approve\./)
  await clock.advance(3 * 60_000)
  expect(reports()).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test('a worker herdr shows blocked is reported blocked at once', async ($, on) => {
  const { clock, submitted } = await start($, on)
  await spawn($, ['w-stuck'])
  // herdr's wait answers blocked straight away: the report needs no clock advance.
  await clock.settle()
  expect(submitted.at(-1)).toMatch(
    /^<herdr-agent name="w-stuck" profile="reviewer" status="blocked">\nThe worker is waiting at an approval/,
  )
  await stopAll($, clock, ['w-stuck'])
})

test('a worker that ends its turn without a report is woken by its next turn, not polled', async ($, on) => {
  const { clock, submitted, calls, typed, files, emit, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  // The turn ends with no report: the wait ends, and the next one waits for the next turn to start.
  await emit('w-busy', 'idle')
  expect(submitted.filter(t => t.startsWith('<herdr-agent'))).toEqual([])
  expect(calls).toContainEqual(RESUME('w-busy'))
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await finish('w-busy')
  expect(submitted.filter(t => t.startsWith('<herdr-agent name="w-busy"'))).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test('a wait child that dies leaves the report to the sweep, which arms a new one', async ($, on) => {
  const { clock, submitted, typed, files, kill } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  // herdr ends the wait with an error: the child is gone, and nothing reports for it.
  await kill('w-busy')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  const reports = () => submitted.filter(t => t.startsWith('<herdr-agent name="w-busy"'))
  await clock.advance(59_000)
  expect(reports()).toHaveLength(0)
  await clock.advance(1_000)
  expect(reports()).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test('one failed herdr call does not end a job; a tab missing from two sweeps does', async ($, on) => {
  const { clock, submitted, typed, fail, gone, kill } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  // The sweep's list and the board's get both fail once: the job stays as it is.
  fail.get = 1
  fail.list = 1
  await clock.advance(60_000)
  const reports = () => submitted.filter(t => t.startsWith('<herdr-agent name="w-busy"'))
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
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toMatch(/status="gone">\nThe worker stopped \(its tab is gone\)/)
})

test('a sweep reads herdr once for all workers', async ($, on) => {
  const { clock, calls, emit } = await start($, on)
  const names = ['w-a', 'w-b', 'w-c']
  await spawn($, names)
  for (const name of names) await emit(name, 'working')
  calls.length = 0
  await clock.advance(5 * 60_000)
  // One list per sweep, however many workers run; the board's own reads are not counted here.
  expect(calls.filter(c => c.join(' ') === 'herdr agent list')).toHaveLength(5)
  await stopAll($, clock, names)
})

test('a failed sweep does not mark a reported tab closed', async ($, on) => {
  const { clock, typed, closed, files, fail } = await start($, on)
  await spawn($, ['w-done'])
  await clock.settle()
  const token = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-done/.herdr-agents/w-done/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(60_000)
  await clock.advance(29 * 60_000)
  expect(closed).toEqual([])
  // The sweep at minute 31 cannot list herdr, so it closes nothing and marks nothing.
  fail.list = 1
  await clock.advance(60_000)
  expect(closed).toEqual([])
  await clock.advance(60_000)
  expect(closed).toEqual(['t-w-done'])
  const late = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: 'One more thing.' })
  expect(JSON.stringify(late)).toMatch(/tab is closed/)
})

test('a failed pane read starts no quiet clock', async ($, on) => {
  const { clock, submitted, screens, fail } = await start($, on)
  screens['p-w-quiet'] = '⏺ Done.\n────\n❯ \n────\n  aerolab · wt · Haiku 5.5 (xhigh)'
  await spawn($, ['w-quiet'])
  const reports = () => submitted.filter(t => t.startsWith('<herdr-agent name="w-quiet"'))
  // Every screen read fails for ten minutes: an error is not a screen that sits still.
  fail.pane = 100
  await clock.advance(10 * 60_000)
  expect(reports()).toEqual([])
  fail.pane = 0
  // The first good read, at minute 11, starts the clock; five quiet minutes reports it.
  await clock.advance(4 * 60_000)
  expect(reports()).toEqual([])
  await clock.advance(2 * 60_000)
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toMatch(/stopped \(idle, screen unchanged for 5 min\)/)
  await stopAll($, clock, ['w-quiet'])
})

test('a sweep arms a new wait for a worker whose wait child died while it still works', async ($, on) => {
  const { clock, submitted, calls, typed, files, kill, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  const armedFinish = () => calls.filter(c => c.join(' ') === FINISH('w-busy').join(' ')).length
  expect(armedFinish()).toBe(1)
  await kill('w-busy')
  // No report yet, and herdr still shows it working: the sweep arms its wait again.
  await clock.advance(60_000)
  expect(submitted.filter(t => t.startsWith('<herdr-agent'))).toEqual([])
  expect(armedFinish()).toBe(2)
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await finish('w-busy')
  expect(submitted.filter(t => t.startsWith('<herdr-agent name="w-busy"'))).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test('a reported worker herdr no longer lists is marked closed, with no tab close to make', async ($, on) => {
  const { clock, closed, typed, files, gone } = await start($, on)
  await spawn($, ['w-done'])
  await clock.settle()
  const token = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-done/.herdr-agents/w-done/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(60_000)
  // herdr drops the tab: the sweep's list leaves it out, and its close is not called.
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
  // Stopped and spawned again before the lost report is due: the new prompt is the one running.
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-lost' })
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-lost', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it again.' })
  await clock.advance(10_000)
  expect(submitted.filter(t => t.startsWith('<herdr-agent name="w-lost"'))).toEqual([])
  await stopAll($, clock, ['w-lost'])
})
