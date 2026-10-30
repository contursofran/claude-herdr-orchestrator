import { expect, test } from 'claude-code/testing'
import { BATCH_MS } from '../hooks/defaults'
import { command, settled, spawn, start, stopAll } from './harness'

// Starting workers: the rules spawn applies, from the built-in profiles in effect. A report
// reaches the coordinator once its batch goes out (see outbox.ts), BATCH_MS after it.

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
  await settled()
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
  await settled()
  // hc's events snapshot says at once that the worker is already done: the mod sees that before the report is written.
  await clock.settle()
  const dir = '/repo/wt/.herdr-agents/w-done'
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${dir}/RESULT.md`] = `<!-- report ${token} -->\nStopped.\nDECISION: [Edit scope] May I edit CI scripts? | Yes (recommended) | No`
  await finish('w-done')
  await clock.advance(BATCH_MS)
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
  await settled()
  await clock.settle()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-none/RESULT.md'] =
    `<!-- report ${token} -->\nOpened PR #4.\nDECISION: none. No owner decision is needed for this PR.\n**decision:** None\nDECISION: [Port] Which port? | 5173 (recommended) | 8080`
  await finish('w-none')
  await clock.advance(BATCH_MS)
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
  await settled()
  await clock.settle()
  expect(typed).toHaveLength(2)
  expect(typed[1]).toBe(typed[0])
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-late/RESULT.md'] = `<!-- report ${token} -->\nDone.`
  await finish('w-late')
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/<herdr-agent name="w-late" profile="builder" status="done">\nDone\./)

  // Every try stalls: reported blocked at once, not idle five minutes later.
  stalls['w-lost'] = 3
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-lost', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it.' })
  await settled()
  expect(typed).toHaveLength(5)
  await clock.advance(10_000)
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/status="blocked">\nThe worker stopped \(its prompt was not delivered: no work started after 3 tries\)/)
})

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
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-one"'))
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toContain('Reviewed: approve.')
  await clock.advance(30_000)
  expect(reports()).toHaveLength(1)

  // The other worker is still reachable.
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-two', text: 'Also check the docs.' })
  expect(typed.at(-1)).toMatch(/Your coordinator sent an extra message while you work/)
  await stopAll($, clock, ['w-two'])
})

// The argv of a worker's watch: one `hc events` child, for its turn's end or its next turn's start.
const EVENTS = (name: string) => ['hc', 'events', '--terminal', name, '--json']
const watches = (calls: string[][], name: string) => calls.filter(c => c.join(' ') === EVENTS(name).join(' ')).length

test('a report is delivered the moment hc sees the worker finish, and only once', async ($, on) => {
  const { clock, submitted, calls, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  expect(calls).toContainEqual(EVENTS('w-busy'))
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  // No clock advance before the finish: hc's status event is what delivers the report.
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done">\nReviewed: approve\./)
  await clock.advance(3 * 60_000)
  expect(reports()).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test("a report that lands while its worker still works is delivered within two ticks, and its turn's end adds nothing", async ($, on) => {
  const { clock, submitted, typed, closed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  // hc still shows the worker working: its wait has not ended, and its turn goes on after the report.
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(2 * 3000 + BATCH_MS)
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done">\nReviewed: approve\./)
  // The report prompts nothing in the worker and closes nothing.
  expect(typed).toHaveLength(1)
  expect(closed).toEqual([])
  // Its turn ends: the wait it still holds settles on a job already reported, so nothing more goes out.
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(reports()).toHaveLength(1)
  expect(typed).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test("a RESULT.md with another prompt's token is not delivered; this prompt's is, within two ticks", async ($, on) => {
  const { clock, submitted, typed, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = '<!-- report 0ld0ld00 -->\nReviewed: approve.'
  await clock.advance(30_000)
  expect(reports()).toEqual([])
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toContain('Reviewed: approve.')
  await stopAll($, clock, ['w-busy'])
})

test('an early report written in two parts is delivered whole, once', async ($, on) => {
  const { clock, submitted, typed, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  const file = '/repo/wt/.herdr-agents/w-busy/RESULT.md'
  files[file] = `<!-- report ${token} -->\nHeader only.`
  await clock.advance(3000)
  expect(reports()).toEqual([])
  files[file] += '\nThe appended line.'
  await clock.advance(3000)
  expect(reports()).toEqual([])
  await clock.advance(3000 + BATCH_MS)
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toContain('The appended line.')
  expect(files[`/repo/wt/.herdr-agents/w-busy/RESULT-${token}.md`]).toContain('The appended line.')
  await stopAll($, clock, ['w-busy'])
})

test('a report found at turn end is delivered at once, without waiting a tick', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test('a report that lands while a non-Claude worker has messages held waits for its turn to end', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on, { profiles: { x: { kind: 'codex', args: [] } } })
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'x', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  // Held: a codex worker takes no typed input mid-task, so the message goes out once it reports.
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(3000)
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  expect(reports()).toEqual([])
  expect(typed).toHaveLength(1)
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(reports()).toHaveLength(1)
  expect(typed.at(-1)).toMatch(/Messages from your coordinator, sent while you worked, are in/)
  await stopAll($, clock, ['w-busy'])
})

test(
  "a worker's tab stays open while hc shows it working after its early report, and closes once it has sat idle",
  { timeoutMs: 20_000 },
  async ($, on) => {
    const { clock, submitted, typed, closed, files, emit } = await start($, on, { closeIdleMinutes: 1 })
    await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
    await settled()
    const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
    files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
    await clock.advance(2 * 3000 + BATCH_MS)
    expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
    // Ten minutes past its report, hc still shows it working: the tab stays.
    await clock.advance(10 * 60_000)
    expect(closed).toEqual([])
    // Its turn ends: the sweep closes the tab once it has sat idle.
    await emit('w-busy', 'done')
    await clock.advance(60_000)
    expect(closed).toEqual(['w-busy'])
  },
)

test("a worker's own session delivers its report within two ticks, with no hc call", async ($, on) => {
  const { clock, submitted, typed, files, calls } = await start($, on, {}, {}, { HERDR_AGENTS_ROLE: 'worker' })
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  calls.length = 0
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  expect(calls).toEqual([])
  await stopAll($, clock, ['w-busy'])
})

test('a worker hc shows blocked is reported blocked at once', async ($, on) => {
  const { clock, submitted } = await start($, on)
  await spawn($, ['w-stuck'])
  // The first line of the events stream is the snapshot, which already says blocked: the report needs no clock advance, only its batch's wait.
  await clock.settle()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(
    /^<herdr-agent name="w-stuck" profile="reviewer" status="blocked">\nThe worker is waiting at an approval/,
  )
  await stopAll($, clock, ['w-stuck'])
})

test('a worker that ends its turn without a report is woken by its next turn, not polled', async ($, on) => {
  const { clock, submitted, calls, typed, files, emit, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  // The turn ends with no report: the watch ends, and the next one waits for the next turn to start.
  await emit('w-busy', 'idle')
  expect(submitted.filter(t => t.includes('<herdr-agent'))).toEqual([])
  // The turn ended with no report, so a second watch waits for the next turn to start.
  expect(watches(calls, 'w-busy')).toBe(2)
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test('a wait child that dies does not hold up its report: the report check delivers it within two ticks', async ($, on) => {
  const { clock, submitted, typed, files, kill } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  // The worker's terminal finishes under the watch: the child is gone, and nothing reports for it.
  await kill('w-busy')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(reports()).toHaveLength(1)
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
  await clock.advance(10_000)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-lost"'))).toEqual([])
  await stopAll($, clock, ['w-lost'])
})

// The mod loads in a worker's own Claude session too, with HERDR_AGENTS_ROLE=worker from its tab.
test("a worker's own session with no running job makes no hc call, opens no sidebar and writes no board", async ($, on) => {
  const { clock, calls, panes, files } = await start($, on, { view: 'side' }, {}, { HERDR_AGENTS_ROLE: 'worker' })
  await clock.advance(10 * 60_000)
  expect(calls).toEqual([])
  expect(panes).toEqual([])
  expect(Object.keys(files).filter(f => f.startsWith('/home/t/.herdr-agents/board/'))).toEqual([])
})

test("a worker's own session sweeps the workers it started while they run, and delivers each report within two ticks", async ($, on) => {
  const { clock, submitted, typed, files, calls, kill, status } = await start($, on, {}, {}, { HERDR_AGENTS_ROLE: 'worker' })
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  // The worker's terminal finishes under the watch: the child is gone, and nothing reports for it.
  await kill('w-busy')
  calls.length = 0
  await clock.advance(60_000)
  expect(calls.map(c => c.join(' '))).toContain('hc ls --json --label herdr-agents.role=worker')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  // Reported while its turn went on, it is still watched; its turn ends, and from then on the session makes no hc call.
  status['w-busy'] = 'idle'
  await clock.advance(60_000)
  calls.length = 0
  await clock.advance(10 * 60_000)
  expect(calls).toEqual([])
  await stopAll($, clock, ['w-busy'])
})

test("a worker's own session sweeps its restored running jobs at start-up, not a minute later", async ($, on) => {
  const job = {
    name: 'w-busy',
    profile: 'builder',
    cwd: '/repo/wt',
    dir: '/repo/wt/.herdr-agents/w-busy',
    startedAt: 900_000,
    status: 'running',
    token: 'tok-busy',
  }
  const kept = { 'jobs:session-1234': { at: 990_000, jobs: { 'w-busy': job } } }
  const { clock, calls } = await start($, on, {}, kept, { HERDR_AGENTS_ROLE: 'worker' })
  // No clock advance: the start-up sweep lists hc as soon as the session starts.
  await clock.settle()
  expect(calls.map(c => c.join(' '))).toContain('hc ls --json --label herdr-agents.role=worker')
  await stopAll($, clock, ['w-busy'])
})

test("a worker's own session whose jobs are all reported makes no hc call, at start-up or after", async ($, on) => {
  const job = {
    name: 'w-done',
    profile: 'builder',
    cwd: '/repo/wt',
    dir: '/repo/wt/.herdr-agents/w-done',
    startedAt: 900_000,
    endedAt: 950_000,
    status: 'reported',
    closed: true,
    token: 'tok-done',
  }
  const kept = { 'jobs:session-1234': { at: 990_000, jobs: { 'w-done': job } } }
  const { clock, calls } = await start($, on, {}, kept, { HERDR_AGENTS_ROLE: 'worker' })
  await clock.advance(10 * 60_000)
  expect(calls).toEqual([])
})

const reportedJob = {
  name: 'w-done',
  profile: 'builder',
  cwd: '/repo/wt',
  dir: '/repo/wt/.herdr-agents/w-done',
  startedAt: 900_000,
  endedAt: 950_000,
  status: 'reported',
  token: 'tok-done',
}

test("a worker's own session closes a nested tab once it has sat idle after its report, then makes no hc call", async ($, on) => {
  const kept = { 'jobs:session-1234': { at: 990_000, jobs: { 'w-done': reportedJob } } }
  const { clock, calls, closed } = await start($, on, { closeIdleMinutes: 1 }, kept, { HERDR_AGENTS_ROLE: 'worker' })
  await clock.settle()
  expect(calls).toEqual([])
  await clock.advance(2 * 60_000)
  expect(closed).toContain('w-done')
  calls.length = 0
  await clock.advance(10 * 60_000)
  expect(calls).toEqual([])
})

test('a reported job whose terminal finished has it removed once it has sat for closeIdleMinutes, and is marked closed', async ($, on) => {
  const kept = { 'jobs:session-1234': { at: 990_000, jobs: { 'w-done': reportedJob } } }
  const { clock, calls, closed, removed, terms, addTerm, store } = await start($, on, { closeIdleMinutes: 1 }, kept)
  addTerm('w-done', '/repo/wt', { 'herdr-agents.role': 'worker' })
  terms.get('w-done')!.finished = true
  await clock.advance(2 * 60_000)
  expect(calls.map(c => c.join(' '))).toContain('hc rm --json w-done')
  expect(calls.some(c => c[1] === 'kill')).toBe(false)
  expect(removed).toEqual(['w-done'])
  expect(closed).toEqual([])
  expect(jobOf(store, 'w-done')).toMatchObject({ status: 'reported', closed: true })
})

test('a finished terminal that cannot be removed leaves its job marked closed all the same', async ($, on) => {
  const kept = { 'jobs:session-1234': { at: 990_000, jobs: { 'w-done': reportedJob } } }
  const { clock, calls, runs, removed, terms, addTerm, store } = await start($, on, { closeIdleMinutes: 1 }, kept)
  addTerm('w-done', '/repo/wt', { 'herdr-agents.role': 'worker' })
  terms.get('w-done')!.finished = true
  runs.set('hc rm --json w-done', [{ exitCode: 1, stderr: 'boom' }])
  await clock.advance(2 * 60_000)
  expect(calls.map(c => c.join(' '))).toContain('hc rm --json w-done')
  expect(removed).toEqual([])
  expect(jobOf(store, 'w-done')).toMatchObject({ status: 'reported', closed: true })
})

test('with closeIdleMinutes 0 a worker session with only reported jobs makes no hc call', async ($, on) => {
  const kept = { 'jobs:session-1234': { at: 990_000, jobs: { 'w-done': reportedJob } } }
  const { clock, calls, closed } = await start($, on, { closeIdleMinutes: 0 }, kept, { HERDR_AGENTS_ROLE: 'worker' })
  await clock.advance(10 * 60_000)
  expect(calls).toEqual([])
  expect(closed).toEqual([])
})

test("spawn runs the worker through the login shell, with HERDR_AGENTS_ROLE=worker after the profile's env", async ($, on) => {
  const { clock, calls } = await start($, on, { profiles: { x: { kind: 'claude', args: ['--model', 'm'], env: { A: '1' } } } })
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-env', profile: 'x', cwd: '/repo/wt', task: 'x' })
  await settled()
  expect(calls.find(c => c[1] === 'run')).toEqual([
    'hc',
    'run',
    '--json',
    '--bg',
    '--no-parent',
    '--name',
    'w-env',
    '--cwd',
    '/repo/wt',
    '--label',
    'herdr-agents.role=worker',
    '--label',
    'herdr.space=sp1',
    '--label',
    'herdr.tab=hrd-w-env',
    '--',
    '/bin/zsh',
    '-ilc',
    'exec "$@"',
    'zsh',
    '/usr/bin/env',
    'A=1',
    'HERDR_AGENTS_ROLE=worker',
    'claude',
    '--model',
    'm',
  ])
  await stopAll($, clock, ['w-env'])
})

const spawnX = async ($: Parameters<typeof start>[0]) => {
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-env', profile: 'x', cwd: '/repo/wt', task: 'x' })
  await settled()
}
const claudeX = { profiles: { x: { kind: 'claude', args: [] } } }

test('a fish login shell runs the worker with exec $argv', async ($, on) => {
  const { clock, calls } = await start($, on, claudeX, {}, { SHELL: '/usr/bin/fish' })
  await spawnX($)
  expect(calls.find(c => c[1] === 'run')?.slice(16)).toEqual([
    '/usr/bin/fish',
    '-ilc',
    'exec $argv',
    '/usr/bin/env',
    'HERDR_AGENTS_ROLE=worker',
    'claude',
  ])
  await stopAll($, clock, ['w-env'])
})

test('a shell the mod does not know runs the worker directly', async ($, on) => {
  const { clock, calls } = await start($, on, claudeX, {}, { SHELL: '/bin/nu' })
  await spawnX($)
  expect(calls.find(c => c[1] === 'run')?.slice(16)).toEqual(['/usr/bin/env', 'HERDR_AGENTS_ROLE=worker', 'claude'])
  await stopAll($, clock, ['w-env'])
})

test('a codex worker gets --no-daemon', async ($, on) => {
  const { clock, calls } = await start($, on, { profiles: { x: { kind: 'codex', args: ['--model', 'm'] } } })
  await spawnX($)
  const argv = calls.find(c => c[1] === 'run') ?? []
  expect(argv.slice(argv.indexOf('codex'))).toEqual(['codex', '--no-daemon', '--model', 'm'])
  await stopAll($, clock, ['w-env'])
})

test('a codex profile that already has --no-daemon gets it once', async ($, on) => {
  const { clock, calls } = await start($, on, { profiles: { x: { kind: 'codex', args: ['--no-daemon'] } } })
  await spawnX($)
  const argv = calls.find(c => c[1] === 'run') ?? []
  expect(argv.slice(argv.indexOf('codex'))).toEqual(['codex', '--no-daemon'])
  await stopAll($, clock, ['w-env'])
})

// A report's header (report.ts) is what the coordinator reads first: its summary, its question, the
// questions pinned from its DECISION lines, and the file's path.
test('a report with a header reaches the coordinator as its summary, pinned questions and the file path', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  const body = [
    '```report',
    'status: blocked',
    'pr: 42',
    'summary: Opened PR #42; the checks pass.',
    'The reviewer has not run yet.',
    'ask: Base or develop?',
    '```',
    ...Array.from({ length: 10 }, (_, i) => `Body line ${i + 1}.`),
    'DECISION: [Edit scope] May I edit CI? | Yes (recommended) | No',
  ]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\n${body.join('\n')}`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  const report = submitted.at(-1) ?? ''
  expect(report).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done" result="blocked" pr="42">\n/)
  expect(report).toContain(
    'Opened PR #42; the checks pass.\nThe reviewer has not run yet.\nAsk: Base or develop?\nD1 [Edit scope] May I edit CI? | Yes (recommended) | No\n' +
      `[Full report, 18 lines: /repo/wt/.herdr-agents/w-busy/RESULT-${token}.md. Read it only when this summary is not enough.]`,
  )
  expect(report).toContain('[Pinned for the owner as D1. The owner is pinged')
  expect(report).not.toContain('Body line 5.')
  await stopAll($, clock, ['w-busy'])
})

test('a header report pins its questions inline, in report order, with the title of each that has one', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = [
    `<!-- report ${token} -->`,
    '```report',
    'status: done',
    'summary: Two questions for you.',
    '```',
    'DECISION: [Port] Which port? | 5173 (recommended) | 8080',
    'DECISION: Ship it today? | Yes | No',
  ].join('\n')
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(
    /\nTwo questions for you\.\nD1 \[Port\] Which port\? \| 5173 \(recommended\) \| 8080\nD2 Ship it today\? \| Yes \| No\n\[Full report, 6 lines: .+\]\n\n\[Pinned for the owner as D1, D2\./,
  )
  await stopAll($, clock, ['w-busy'])
})

test('a header with nothing after it has no pointer to the file, and an unknown status is no result attribute', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] =
    `<!-- report ${token} -->\n\`\`\`report\nstatus: Maybe\nsummary: Nothing to add.\n\`\`\``
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done">\nNothing to add\.\n/)
  expect(submitted.at(-1)).not.toContain('Full report')
  await stopAll($, clock, ['w-busy'])
})

test('a header names the PRs a report opens, on the prompt tag; a report without a header is delivered with no pr', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] =
    `<!-- report ${token} -->\n\`\`\`report\nstatus: done\npr: #12, 13\nsummary: Two PRs.\n\`\`\``
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done" result="done" pr="12,13">\n/)

  await spawn($, ['w-link'])
  const linkToken = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-link/.herdr-agents/w-link/RESULT.md'] =
    `<!-- report ${linkToken} -->\nReviewed: approve.\nhttps://github.com/acme/app/pull/77`
  await finish('w-link')
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/^<herdr-agent name="w-link" profile="reviewer" status="done">\nReviewed: approve\.\n/)
  await stopAll($, clock, ['w-busy', 'w-link'])
})

test('a report without a header is delivered as before: a long one as a pointer to its file, a short one inline', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const longToken = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-short', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it.' })
  await settled()
  const shortToken = typed[1]?.match(/<!-- report (\S+) -->/)?.[1]
  const lines = Array.from({ length: 9 }, (_, i) => `Line ${i + 2}.`)
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${longToken} -->\nReviewed the change.\n${lines.join('\n')}`
  // Each report goes out in a batch of its own, so the batch's first element is the one a test reads:
  // the short one's file is written once the long one's batch has gone out.
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  files['/repo/wt2/.herdr-agents/w-short/RESULT.md'] = `<!-- report ${shortToken} -->\nReviewed the small change.\nAll green.`
  await finish('w-short')
  await clock.advance(BATCH_MS)
  const long = submitted.find(t => t.includes('<herdr-agent name="w-busy"')) ?? ''
  expect(long).toMatch(
    /^<herdr-agent name="w-busy" profile="builder" status="done">\nReviewed the change\.\n\[Full report, 10 lines: \/repo\/wt\/\.herdr-agents\/w-busy\/RESULT-\w+\.md\. Read it before acting on it\.\]/,
  )
  expect(long).not.toContain('Line 5.')
  const short = submitted.find(t => t.includes('<herdr-agent name="w-short"')) ?? ''
  expect(short).toMatch(/^<herdr-agent name="w-short" profile="builder" status="done">\nReviewed the small change\.\nAll green\.\n/)
  expect(short).not.toContain('Full report')
  await stopAll($, clock, ['w-busy', 'w-short'])
})

test('the full report rule goes in the first prompt only; follow-ups and wake-ups get a one-line reminder', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const firstToken = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  expect(typed[0]).toContain('Right below that line, put this header')
  expect(files['/repo/wt/.herdr-agents/w-busy/REPORTING.md']).toContain('<!-- report TOKEN -->')
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${firstToken} -->\nReviewed: approve.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)

  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'One more thing.' })
  const secondToken = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  expect(secondToken).not.toBe(firstToken)
  expect(typed.at(-1)).toContain(`<!-- report ${secondToken} -->`)
  expect(typed.at(-1)).toContain('report as before')
  expect(typed.at(-1)).not.toContain('Right below that line')

  // A WAIT.json check that times out wakes the worker with the reminder, not the full rule.
  files['/repo/wt/.herdr-agents/w-busy/WAIT.json'] = '{"for":"ci","check":"false","every":1,"max":5}'
  await clock.advance(8 * 60_000)
  expect(typed.at(-1)).toContain('Your wait is over')
  expect(typed.at(-1)).toContain('report as before')
  expect(typed.at(-1)).not.toContain('Right below that line')
  expect(typed.filter(t => t.includes('Right below that line'))).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test('a worker spawned again with the same name in the same folder gets the full rule in its first prompt', async ($, on) => {
  const { clock, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const firstToken = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${firstToken} -->\nDone.`
  await finish('w-busy')
  // The job folder outlives the job: the same name spawned again finds the old REPORTING.md there.
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it again.' })
  await settled()
  const again = typed.at(-1) ?? ''
  expect(again).toContain('Your task is in /repo/wt/.herdr-agents/w-busy/TASK.md')
  expect(again).toContain('Right below that line, put this header')
  expect(again).not.toContain('report as before')
  await stopAll($, clock, ['w-busy'])
})

test('the report rule says to write RESULT.md in one write, as the last step, in the full rule and the reminder', async ($, on) => {
  const { clock, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  expect(typed[0]).toContain('write your final report to /repo/wt/.herdr-agents/w-busy/RESULT.md in one write, as your last step')
  expect(files['/repo/wt/.herdr-agents/w-busy/REPORTING.md']).toContain('in one write, as your last step')
  const firstToken = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${firstToken} -->\nDone.`
  await finish('w-busy')
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'One more thing.' })
  expect(typed.at(-1)).toContain('in one write, as your last step')
  await stopAll($, clock, ['w-busy'])
})

// Job writes patch the latest job: a stop or a message that lands while a check, a read or a
// prompt is awaited must survive it (#20, S1).

const W = '/repo/wt/.herdr-agents/w-busy'
const check = (argv: string[]) => argv[0] === '/bin/bash' && argv[2] === 'ci'
const codex = { profiles: { x: { kind: 'codex', args: [] } } }
const spawnBusy = async ($: Parameters<typeof start>[0], profile: string) => {
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile, cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
}
const jobOf = (store: Map<string, unknown>, name: string) =>
  (store.get('jobs:session-1234') as { jobs: Record<string, Record<string, unknown>> }).jobs[name]!

test('a stop while a WAIT.json check runs stays stopped', async ($, on) => {
  const { clock, typed, files, store, gate } = await start($, on)
  await spawnBusy($, 'builder')
  files[`${W}/WAIT.json`] = '{"for":"ci","check":"ci","every":1,"max":60}'
  const release = gate(check)
  await clock.advance(60_000)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  const before = typed.length
  release()
  await clock.settle()
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', closed: true })
  expect(typed.length).toBe(before)
})

test('a message held while a WAIT.json check runs is not lost', async ($, on) => {
  const { clock, typed, files, finish, gate, runs } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/WAIT.json`] = '{"for":"ci","check":"ci","every":1,"max":60}'
  runs.set('/bin/bash -c ci', [{ exitCode: 1 }])
  const release = gate(check)
  await clock.advance(60_000)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  release()
  await clock.settle()
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(typed.at(-1)).toMatch(/Messages from your coordinator, sent while you worked, are in .*MESSAGE-/)
})

test('a wait that passes after its worker was stopped prompts nothing', async ($, on) => {
  const { clock, typed, files, gate, runs } = await start($, on)
  await spawnBusy($, 'builder')
  files[`${W}/WAIT.json`] = '{"for":"ci","check":"ci","every":1,"max":60}'
  runs.set('/bin/bash -c ci', [{ exitCode: 0 }])
  const release = gate(check)
  await clock.advance(60_000)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  const before = typed.length
  release()
  await clock.settle()
  expect(typed.length).toBe(before)
  expect(`${W}/WAIT.json` in files).toBe(true)
})

test('a message held while a report is being delivered is listed, not lost', async ($, on) => {
  const { clock, submitted, gone, kill, gate } = await start($, on, codex)
  await spawnBusy($, 'x')
  // No RESULT.md and the terminal gone: deliver awaits `hc read` for the screen.
  const release = gate(argv => argv.join(' ').startsWith('hc read w-busy --lines 40'))
  gone.add('w-busy')
  await kill('w-busy')
  await clock.advance(60_000)
  const second = clock.advance(60_000)
  // The second sweep is now held at `hc read`, inside deliver.
  await clock.settle()
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Too late.' })
  release()
  await second
  await clock.advance(BATCH_MS)
  const report = submitted.find(t => t.includes('<herdr-agent name="w-busy"')) ?? ''
  expect(report).toMatch(/1 message\(s\) held for it were not sent, as it did not finish \(gone\): .*MESSAGE-/)
})

test('a message that lands between a report and its queued prompt is held, not typed', async ($, on) => {
  const { clock, typed, files, store, gate, finish } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'First.' })
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone.`
  // The queued prompt's first call removes RESULT.md.
  const release = gate(argv => argv.join(' ') === `rm -f ${W}/RESULT.md`)
  await finish('w-busy')
  const before = typed.length
  const sent = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Second.' })
  await clock.settle()
  release()
  const out = JSON.stringify(await sent)
  expect(out).toMatch(/held/)
  await clock.settle()
  expect(typed.length).toBe(before + 1)
  expect(typed.at(-1)).toMatch(/Messages from your coordinator/)
  expect(jobOf(store, 'w-busy').queued).toHaveLength(1)
})

test('a message to a worker reported meanwhile does not bring back running', async ($, on) => {
  const { clock, submitted, typed, files, store, gate, finish } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  const release = gate(argv => argv[0] === 'fs.write' && argv[1]!.includes('/MESSAGE-'))
  const sent = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Late one.' })
  await clock.settle()
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  release()
  await sent
  await clock.advance(3 * 60_000)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  // The message went out as its own prompt, with a new token.
  expect(typed.at(-1)).toContain('Late one.')
  expect(jobOf(store, 'w-busy').token).not.toBe(token)
})

test("a delivered report and a stopped worker's screen are copied to the reports archive", async ($, on) => {
  const { clock, typed, files, finish, screens } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  const dir = '/home/t/.herdr-agents/reports/repo/wt/.herdr-agents/w-busy'
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nDone, all green.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(files[`/repo/wt/.herdr-agents/w-busy/RESULT-${token}.md`]).toContain('Done, all green.')
  expect(files[`${dir}/RESULT-${token}.md`]).toBe(files[`/repo/wt/.herdr-agents/w-busy/RESULT-${token}.md`])

  screens['w-quiet'] = '⏺ Done.\n────\n❯ \n────\n  aerolab · wt · Haiku 5.5 (xhigh)'
  await spawn($, ['w-quiet'])
  await clock.advance(7 * 60_000)
  await clock.advance(BATCH_MS)
  const copies = Object.keys(files).filter(f => f.startsWith('/home/t/.herdr-agents/reports/repo-w-quiet/.herdr-agents/w-quiet/SCREEN-'))
  expect(copies).toHaveLength(1)
  const own = Object.keys(files).find(f => f.startsWith('/repo-w-quiet/.herdr-agents/w-quiet/SCREEN-'))!
  expect(files[copies[0]!]).toBe(files[own])
  await stopAll($, clock, ['w-busy', 'w-quiet'])
})

// The jobs map does not grow for good: reported jobs leave it a week after they ended.
test('reported jobs older than 7 days are dropped from the state and the store; newer and running ones stay', async ($, on) => {
  const day = 24 * 60 * 60_000
  const job = (name: string, over: object) => ({
    name,
    profile: 'builder',
    cwd: '/repo/wt',
    dir: `/repo/wt/.herdr-agents/${name}`,
    startedAt: 900_000,
    token: `tok-${name}`,
    ...over,
  })
  const jobs = {
    'w-old': job('w-old', { status: 'reported', endedAt: 1_000_000 - 8 * day }),
    'w-new': job('w-new', { status: 'reported', endedAt: 1_000_000 - 6 * day }),
    'w-run': job('w-run', { status: 'running', startedAt: 1_000_000 - 30 * day }),
  }
  const { clock, store } = await start($, on, {}, { 'jobs:session-1234': { at: 990_000, jobs } })
  await clock.settle()
  const kept = store.get('jobs:session-1234') as { jobs: Record<string, unknown> }
  expect(Object.keys(kept.jobs).sort()).toEqual(['w-new', 'w-run'])
  await stopAll($, clock, ['w-run'])
})

test('prune runs git rev-parse once per folder', async ($, on) => {
  const job = (name: string) => ({
    name,
    profile: 'builder',
    cwd: '/repo/wt',
    dir: `/repo/wt/.herdr-agents/${name}`,
    startedAt: 900_000,
    endedAt: 950_000,
    status: 'reported',
    token: `tok-${name}`,
  })
  const jobs = { 'w-a': job('w-a'), 'w-b': job('w-b'), 'w-c': job('w-c') }
  const { clock, shell, files } = await start($, on, {}, { 'jobs:session-1234': { at: 990_000, jobs } })
  files['/repo/wt/x'] = ''
  await clock.settle()
  await command($, 'hrd-prune')
  expect(shell.filter(c => c.includes('rev-parse') && c.includes('--git-common-dir'))).toHaveLength(1)
})

// A reported job stays watched until its turn ends (Job.tail).
const reportsOf = (submitted: string[]) => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))

test('a non-Claude worker reported early gets messages held until its turn ends', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  expect(reportsOf(submitted)).toHaveLength(1)
  const before = typed.length
  const held = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  expect(JSON.stringify(held)).toMatch(/still finishing its turn after its report/)
  expect(typed.length).toBe(before)
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(typed.at(-1)).toMatch(/Messages from your coordinator, sent while you worked, are in .*MESSAGE-/)
  // Sent as a prompt: no further report.
  expect(reportsOf(submitted)).toHaveLength(1)
})

test('a Claude worker reported early still gets its message typed in', async ($, on) => {
  const { clock, typed, files } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  const before = typed.length
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  expect(typed.length).toBe(before + 1)
  expect(typed.at(-1)).toMatch(/Also check the docs\./)
})

test('a worker that blocks after its early report is reported blocked once', async ($, on) => {
  const { clock, submitted, typed, files, toasts, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', tail: 'early' })
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  const reports = reportsOf(submitted)
  expect(reports).toHaveLength(2)
  expect(reports[1]).toMatch(/status="blocked">\nAfter its report/)
  expect(toasts.filter(t => t.includes('w-busy is blocked'))).toHaveLength(1)
  expect(jobOf(store, 'w-busy')).toMatchObject({ tail: 'blocked', reportStatus: 'done' })
  await clock.advance(3 * 60_000)
  expect(reportsOf(submitted)).toHaveLength(2)
})

test('a worker blocked without a report is collected once the owner answers in its tab', async ($, on) => {
  const { clock, submitted, typed, files, emit, finish, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)[0]).toMatch(/status="blocked">\nThe worker is waiting at an approval/)
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', tail: 'blocked' })
  await emit('w-busy', 'working')
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nAnswered, and done.`
  // The report check finds it while the worker still works; its turn's end then closes the watch.
  await clock.advance(6000 + BATCH_MS)
  const reports = reportsOf(submitted)
  expect(reports).toHaveLength(2)
  expect(reports[1]).toMatch(/status="done">\nAnswered, and done\./)
  expect(jobOf(store, 'w-busy').tail).toBe('early')
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)).toHaveLength(2)
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
})

test('a worker whose CLI errored is reported at once, and a report it writes after recovering is delivered too', async ($, on) => {
  const { clock, submitted, typed, files, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await emit('w-busy', 'error')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)[0]).toMatch(/status="error">\nThe worker stopped \(its CLI reported an error\)/)
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', tail: 'blocked' })
  await emit('w-busy', 'working')
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nRecovered, and done.`
  await clock.advance(6000 + BATCH_MS)
  const reports = reportsOf(submitted)
  expect(reports).toHaveLength(2)
  expect(reports[1]).toMatch(/status="done">\nRecovered, and done\./)
})

test('a worker blocked after its early report that ends its turn without a new report sends nothing more', async ($, on) => {
  const { clock, submitted, typed, files, emit, finish, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)).toHaveLength(2)
  await finish('w-busy')
  await clock.advance(3 * 60_000)
  expect(reportsOf(submitted)).toHaveLength(2)
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
})

test('a tail job whose wait child died is flushed by the sweep', async ($, on) => {
  const { clock, typed, files, kill, status, store } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  const before = typed.length
  await kill('w-busy')
  status['w-busy'] = 'idle'
  await clock.advance(60_000)
  expect(typed.length).toBe(before + 1)
  expect(typed.at(-1)).toMatch(/Messages from your coordinator/)
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
})

test('stop clears the tail: a later block is not reported', async ($, on) => {
  const { clock, submitted, typed, files, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS + 3 * 60_000)
  expect(reportsOf(submitted)).toHaveLength(1)
})

test('a held message to a tail job whose tab is gone is not typed', async ($, on) => {
  const { clock, typed, files, gone, store } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  const before = typed.length
  gone.add('w-busy')
  await clock.advance(3 * 60_000)
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
  expect(typed.length).toBe(before)
})

test('held messages of a tail job whose tab is gone are reported, and queued is cleared', async ($, on) => {
  const { clock, submitted, typed, files, gone, store } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  expect(jobOf(store, 'w-busy').queued).toHaveLength(1)
  gone.add('w-busy')
  await clock.advance(3 * 60_000)
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
  expect(jobOf(store, 'w-busy').queued ?? []).toEqual([])
  const notice = reportsOf(submitted).at(-1) ?? ''
  expect(notice).toMatch(/1 message\(s\) held for it were not sent, as its tab is gone: .*MESSAGE-/)
})

test('the prune of old jobs and the idle close both leave a watched job alone', async ($, on) => {
  const day = 24 * 60 * 60_000
  const job = {
    name: 'w-tail',
    profile: 'builder',
    cwd: '/repo/wt',
    dir: '/repo/wt/.herdr-agents/w-tail',
    startedAt: 1_000_000 - 30 * day,
    endedAt: 1_000_000 - 8 * day,
    status: 'reported',
    token: 'tok',
    tail: 'early',
  }
  const { clock, store } = await start($, on, {}, { 'jobs:session-1234': { at: 990_000, jobs: { 'w-tail': job } } })
  await clock.settle()
  expect(Object.keys((store.get('jobs:session-1234') as { jobs: object }).jobs)).toEqual(['w-tail'])
})

// Non-blocking spawn (#21, S2): spawn saves a 'starting' job and returns; the terminal, the CLI and the
// first prompt follow in the background.
const hcRun = (argv: string[]) => argv[0] === 'hc' && argv[1] === 'run'
const spawnArgs = { tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' } as const

test('spawn returns starting at once, before the terminal is made', async ($, on) => {
  const { clock, typed, gate, store } = await start($, on)
  const release = gate(hcRun)
  const res = await $.tool.call(spawnArgs)
  expect(JSON.stringify(res)).toMatch(/\\"status\\":\\"starting\\"/)
  await clock.settle()
  expect(typed).toEqual([])
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'starting' })
  release()
  await clock.settle()
  expect(typed[0]).toContain('Your task is in /repo/wt/.herdr-agents/w-busy/TASK.md')
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'running', address: expect.stringMatching(/^t\d+$/) })
  await stopAll($, clock, ['w-busy'])
})

test('a start failure reaches the coordinator as a failed report and its terminal is closed', async ($, on) => {
  const { clock, submitted, closed, removed, waitReplies, store, files, screens } = await start($, on)
  // The CLI dies while it boots, leaving its last screen.
  waitReplies['w-busy'] = [{ ended: true, reason: 'exit', status: null, exit_code: 127 }]
  screens['w-busy'] = 'shell: command not found'
  await $.tool.call(spawnArgs)
  await clock.settle()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/status="failed">\nThe worker did not start: the CLI exited \(code 127\)/)
  expect(closed).toContain('w-busy')
  expect(removed).toContain('w-busy')
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', closed: true, reportStatus: 'failed' })
  const screen = Object.keys(files).find(f => f.includes('/w-busy/SCREEN-start-'))
  expect(screen).toBeDefined()
  expect(submitted.at(-1)).toContain(screen!)
})

test('a stop while the worker starts closes its tab and sends no prompt', async ($, on) => {
  const { clock, typed, submitted, closed, gate, store } = await start($, on)
  const release = gate(hcRun)
  await $.tool.call(spawnArgs)
  await clock.settle()
  const stopped = await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  expect(JSON.stringify(stopped)).toContain('Stopped w-busy while it was starting.')
  release()
  await clock.settle()
  await clock.advance(BATCH_MS)
  expect(typed).toEqual([])
  expect(closed).toContain('w-busy')
  expect(submitted).toEqual([])
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', reportStatus: 'stopped', closed: true })
})

test('a message to a starting worker goes in with its task', async ($, on) => {
  const { clock, typed, gate, store } = await start($, on)
  const release = gate(hcRun)
  await $.tool.call(spawnArgs)
  await clock.settle()
  const sent = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  expect(JSON.stringify(sent)).toContain('w-busy is still starting; the message is handed to it with its task.')
  release()
  await clock.settle()
  expect(typed[0]).toMatch(/Your coordinator also sent 1 message\(s\) after the task: \S+MESSAGE-\S+\.md\. Read them after TASK\.md\./)
  expect(jobOf(store, 'w-busy').queued).toEqual([])
  await stopAll($, clock, ['w-busy'])
})

test('a message held for a worker that fails to start is listed in the failed report', async ($, on) => {
  const { clock, submitted, gate, fail } = await start($, on)
  fail.start = 1
  const release = gate(hcRun)
  await $.tool.call(spawnArgs)
  await clock.settle()
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  release()
  await clock.settle()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/1 message\(s\) held for it were not sent: \S+MESSAGE-/)
})

test('a starting job is not swept as gone and an old RESULT.md in its folder is not delivered', async ($, on) => {
  const { clock, submitted, files, gate } = await start($, on)
  files[`${W}/RESULT.md`] = 'Old report.'
  const release = gate(hcRun)
  await $.tool.call(spawnArgs)
  await clock.advance(200_000)
  expect(submitted).toEqual([])
  release()
  await clock.settle()
  await stopAll($, clock, ['w-busy'])
})

test('a starting worker counts toward the target and holds its name', async ($, on) => {
  const { clock, gate } = await start($, on)
  await spawn($, ['w-a'], '/repo-a', clock)
  const release = gate(hcRun)
  await $.tool.call({ ...spawnArgs, worker: 'w-b', cwd: '/repo-b' })
  const stopped = await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-a' })
  expect(JSON.stringify(stopped)).toMatch(/1 of \d+ workers working/)
  // A second spawn under the same name is denied while the first still starts.
  const again = await $.tool.call({ ...spawnArgs, worker: 'w-b', profile: 'reviewer', cwd: '/repo-b' })
  expect(JSON.stringify(again)).toContain('worker w-b is still running')
  release()
  await clock.settle()
  await stopAll($, clock, ['w-b'])
})

test('a reload during start reports it failed and closes its terminal', async ($, on) => {
  const job = {
    name: 'w',
    profile: 'builder',
    cwd: '/repo/wt',
    dir: '/repo/wt/.herdr-agents/w',
    startedAt: 1,
    status: 'starting',
    address: 't12',
  }
  const { clock, submitted, closed, store } = await start($, on, {}, { 'jobs:session-1234': { at: 1, jobs: { w: job } } })
  await clock.settle()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(
    /name="w" profile="builder" status="failed">\nThe worker did not start: the mod reloaded while it started/,
  )
  expect(closed).toContain('w')
  expect(jobOf(store, 'w')).toMatchObject({ status: 'reported', reportStatus: 'failed', closed: true })
})

test('an error in the first prompt after the job is running is toasted, not lost', async ($, on) => {
  const { runs, toasts } = await start($, on)
  runs.set('rm -f /repo/wt/.herdr-agents/w-late/RESULT.md', [{ exitCode: 0, reject: 'cannot run rm' }])
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-late', profile: 'builder', cwd: '/repo/wt', task: 'x' })
  await settled()
  expect(toasts.join('\n')).toMatch(/w-late: its first prompt failed/)
})

// Spawn with a branch: the mod makes the worktree. Git answers come from `runs`.
const git = (cmd: string, stdout = '', exitCode = 0, stderr = '') => ['git ' + cmd, [{ exitCode, stdout, stderr }]] as const
const answerGit = (runs: Map<string, { exitCode: number; stdout?: string; stderr?: string }[]>, ...list: (readonly [string, any])[]) => {
  for (const b of ['fix-x', 'feat/a', 'dev', 'main']) runs.set(`git check-ref-format --branch ${b}`, [{ exitCode: 0 }])
  for (const [k, v] of list) runs.set(k, v)
}
const spawnBranch = ($: any, extra: Record<string, unknown> = {}, worker = 'w-tree') =>
  $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker, profile: 'builder', task: 'Build it.', branch: 'fix-x', ...extra })

test('spawn with a branch fetches, creates the worktree next to the repo and starts there', async ($, on) => {
  const { runs, shell, calls, files } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo symbolic-ref --short refs/remotes/origin/HEAD', 'origin/main\n'),
    git('-C /repo fetch origin main'),
    git('-C /repo worktree add -b fix-x /repo-wt/fix-x origin/main'),
  )
  const r = await spawnBranch($)
  expect(r.result).toMatch(/^\{"worker":"w-tree","cwd":"\/repo-wt\/fix-x","status":"starting","branch":"fix-x"\}\n/)
  await settled()
  const fetch = shell.indexOf('git -C /repo fetch origin main')
  expect(fetch).toBeGreaterThan(-1)
  expect(shell.indexOf('git -C /repo worktree add -b fix-x /repo-wt/fix-x origin/main')).toBeGreaterThan(fetch)
  expect(calls.some(c => c.join(' ').startsWith('hc run --json --bg --no-parent --name w-tree --cwd /repo-wt/fix-x'))).toBe(true)
  expect(files['/repo-wt/fix-x/.herdr-agents/w-tree/TASK.md']).toBe('Build it.')
})

test('a branch with a slash gets a folder with a dash, and an existing local branch is used', async ($, on) => {
  const { runs, shell } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo fetch origin dev', '', 0),
    git('-C /repo rev-parse --verify --quiet refs/heads/feat/a', 'abc\n'),
    git('-C /repo worktree add /repo-wt/feat-a feat/a'),
  )
  const r = await spawnBranch($, { branch: 'feat/a', base: 'dev' })
  expect(r.result).toContain('"cwd":"/repo-wt/feat-a"')
  await settled()
  expect(shell).toContain('git -C /repo worktree add /repo-wt/feat-a feat/a')
})

test("a branch only on origin is checked out from origin's copy", async ($, on) => {
  const { runs, shell } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo fetch origin main'),
    git('-C /repo rev-parse --verify --quiet refs/heads/fix-x', '', 1),
    git('-C /repo rev-parse --verify --quiet refs/remotes/origin/fix-x', 'abc\n'),
    git('-C /repo worktree add -b fix-x /repo-wt/fix-x origin/fix-x'),
  )
  await spawnBranch($)
  await settled()
  expect(shell).toContain('git -C /repo worktree add -b fix-x /repo-wt/fix-x origin/fix-x')
})

test('the branch is fetched too, and a failed fetch of it is ignored', async ($, on) => {
  const { runs, shell } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo fetch origin main'),
    git('-C /repo fetch origin fix-x', '', 128, "fatal: couldn't find remote ref fix-x"),
    git('-C /repo worktree add -b fix-x /repo-wt/fix-x origin/main'),
  )
  await spawnBranch($)
  await settled()
  expect(shell.indexOf('git -C /repo fetch origin fix-x')).toBeGreaterThan(shell.indexOf('git -C /repo fetch origin main'))
  expect(shell).toContain('git -C /repo worktree add -b fix-x /repo-wt/fix-x origin/main')
})

test('a repo with no origin remote fetches nothing and branches off the local base', async ($, on) => {
  const { runs, shell } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo symbolic-ref --short refs/remotes/origin/HEAD', '', 128, 'fatal: not a symbolic ref'),
    git('-C /repo branch --show-current', 'trunk\n'),
    git('check-ref-format --branch trunk'),
    git('-C /repo remote get-url origin', '', 2, "error: No such remote 'origin'"),
    git('-C /repo rev-parse --verify --quiet refs/heads/fix-x', '', 1),
    git('-C /repo worktree add -b fix-x /repo-wt/fix-x refs/heads/trunk'),
  )
  const r = await spawnBranch($)
  expect(r.result).toContain('"cwd":"/repo-wt/fix-x"')
  await settled()
  expect(shell.some(c => c.includes(' fetch '))).toBe(false)
  expect(shell).toContain('git -C /repo worktree add -b fix-x /repo-wt/fix-x refs/heads/trunk')
})

test('a repo with no origin remote reuses an existing local branch', async ($, on) => {
  const { runs, shell } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo remote get-url origin', '', 2),
    git('-C /repo rev-parse --verify --quiet refs/heads/fix-x', 'abc\n'),
    git('-C /repo worktree add /repo-wt/fix-x fix-x'),
  )
  await spawnBranch($)
  await settled()
  expect(shell.some(c => c.includes(' fetch '))).toBe(false)
  expect(shell).toContain('git -C /repo worktree add /repo-wt/fix-x fix-x')
})

test('a repo with an origin whose fetch fails still fails with the fetch error', async ($, on) => {
  const { runs, shell, submitted, clock } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo remote get-url origin', 'git@example.com:x/y.git\n'),
    git('-C /repo fetch origin main', '', 128, 'fatal: unable to access'),
  )
  await spawnBranch($)
  await settled()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/status="failed">\nThe worker did not start: .*git fetch origin main failed: fatal: unable to access/)
  expect(shell.some(c => c.includes('worktree add'))).toBe(false)
})

test('a repo with an origin but no origin/HEAD keeps main, not the checked-out branch', async ($, on) => {
  const { runs, shell } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo symbolic-ref --short refs/remotes/origin/HEAD', '', 128, 'fatal: not a symbolic ref'),
    git('-C /repo branch --show-current', 'trunk\n'),
    git('-C /repo remote get-url origin', 'git@example.com:x/y.git\n'),
    git('-C /repo fetch origin main'),
    git('-C /repo worktree add -b fix-x /repo-wt/fix-x origin/main'),
  )
  await spawnBranch($)
  await settled()
  expect(shell).toContain('git -C /repo fetch origin main')
  expect(shell).toContain('git -C /repo worktree add -b fix-x /repo-wt/fix-x origin/main')
})

test('a repo with no origin remote and a detached HEAD falls back to main', async ($, on) => {
  const { runs, shell } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo symbolic-ref --short refs/remotes/origin/HEAD', '', 128, 'fatal: not a symbolic ref'),
    git('-C /repo remote get-url origin', '', 2),
    git('-C /repo branch --show-current', ''),
    git('-C /repo rev-parse --verify --quiet refs/heads/fix-x', '', 1),
    git('-C /repo worktree add -b fix-x /repo-wt/fix-x refs/heads/main'),
  )
  await spawnBranch($)
  await settled()
  expect(shell).toContain('git -C /repo worktree add -b fix-x /repo-wt/fix-x refs/heads/main')
})

test('a base that is not a valid branch name is denied before any git call that could take it as an option', async ($, on) => {
  const { runs, shell } = await start($, on)
  answerGit(runs, git('-C /repo rev-parse --show-toplevel', '/repo\n'), git('check-ref-format --branch --upload-pack=x', '', 1))
  const r = await spawnBranch($, { base: '--upload-pack=x' })
  expect(r.deny).toMatch(/--upload-pack=x is not a valid base branch name/)
  expect(shell.some(c => c.includes('fetch'))).toBe(false)
})

test('an existing worktree on the same branch is reused with no fetch', async ($, on) => {
  const { runs, shell, files } = await start($, on)
  files['/repo-wt/fix-x/package.json'] = '{}'
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo rev-parse --path-format=absolute --git-common-dir', '/repo/.git\n'),
    git('-C /repo-wt/fix-x rev-parse --path-format=absolute --git-common-dir', '/repo/.git\n'),
    git('-C /repo-wt/fix-x branch --show-current', 'fix-x\n'),
  )
  const r = await spawnBranch($)
  expect(r.result).toContain('"cwd":"/repo-wt/fix-x"')
  await settled()
  expect(shell.some(c => c.includes(' fetch ') || c.includes('worktree add'))).toBe(false)
  expect(files['/repo-wt/fix-x/.herdr-agents/w-tree/TASK.md']).toBe('Build it.')
})

test('a folder that exists on another branch is denied at once', async ($, on) => {
  const { runs, files } = await start($, on)
  files['/repo-wt/fix-x/package.json'] = '{}'
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo rev-parse --path-format=absolute --git-common-dir', '/repo/.git\n'),
    git('-C /repo-wt/fix-x rev-parse --path-format=absolute --git-common-dir', '/repo/.git\n'),
    git('-C /repo-wt/fix-x branch --show-current', 'other\n'),
  )
  const r = await spawnBranch($)
  expect(r.deny).toMatch(/\/repo-wt\/fix-x exists and is not a worktree of \/repo on fix-x; pass cwd to use it, or pick another branch/)
})

test('a branch checked out in another worktree is denied with that folder', async ($, on) => {
  const { runs } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo worktree list --porcelain', 'worktree /repo\nbranch refs/heads/main\n\nworktree /elsewhere\nbranch refs/heads/fix-x\n'),
  )
  const r = await spawnBranch($)
  expect(r.deny).toMatch(/fix-x is already checked out in \/elsewhere; pass cwd=\/elsewhere/)
})

test('a bad branch name, or a folder that is no checkout, is denied', async ($, on) => {
  const { runs } = await start($, on)
  answerGit(runs, git('-C /repo rev-parse --show-toplevel', '/repo\n'), git('check-ref-format --branch bad..name', '', 1))
  expect((await spawnBranch($, { branch: 'bad..name' })).deny).toMatch(/not a valid branch name/)
  runs.set('git -C /nowhere rev-parse --show-toplevel', [{ exitCode: 128 }])
  expect((await spawnBranch($, { repo: '/nowhere' })).deny).toMatch(/\/nowhere is not a git checkout/)
})

test("a failed worktree add is a failed report with git's error, and no folder is created", async ($, on) => {
  const { runs, submitted, clock, files } = await start($, on)
  answerGit(
    runs,
    git('-C /repo rev-parse --show-toplevel', '/repo\n'),
    git('-C /repo fetch origin main'),
    git('-C /repo worktree add -b fix-x /repo-wt/fix-x origin/main', '', 128, 'fatal: bad object'),
  )
  await spawnBranch($)
  await settled()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(/status="failed">\nThe worker did not start: .*fatal: bad object/)
  expect(Object.keys(files).filter(f => f.startsWith('/repo-wt'))).toEqual([])
})

test('cwd alone works as before, without git worktree calls', async ($, on) => {
  const { shell } = await start($, on)
  const r = await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-cwd', profile: 'builder', cwd: '/repo/wt', task: 'x' })
  expect(r.result).toContain('"cwd":"/repo/wt"')
  expect(r.result).not.toContain('"branch"')
  await settled()
  expect(shell.some(c => c.includes('fetch') || c.includes('worktree'))).toBe(false)
})

test('cwd and branch together, neither, or repo/base without a branch are denied', async ($, on) => {
  await start($, on)
  const call = (extra: Record<string, unknown>) =>
    $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-bad', profile: 'builder', task: 'x', ...extra })
  expect((await call({ cwd: '/repo/wt', branch: 'b' })).deny).toMatch(/exactly one of cwd/)
  expect((await call({})).deny).toMatch(/exactly one of cwd/)
  expect((await call({ cwd: '/repo/wt', base: 'dev' })).deny).toMatch(/repo and base go with branch/)
})

test('the spawn tool offers branch, repo and base, and only worker, profile and task are required', async ($, on) => {
  const { tools } = await start($, on)
  const spec = tools.spawn as any
  expect(Object.keys(spec.inputSchema.properties)).toEqual(expect.arrayContaining(['branch', 'repo', 'base']))
  expect(spec.inputSchema.required).toEqual(['worker', 'profile', 'task'])
})

test('a header verdict reaches the coordinator on the prompt tag', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'reviewer', cwd: '/repo/wt', task: 'Review it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] =
    `<!-- report ${token} -->\n\`\`\`report\nstatus: done\npr: 12\nverdict: approve\nhead: abc1234\nsummary: Fine.\n\`\`\``
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(
    /^<herdr-agent name="w-busy" profile="reviewer" status="done" result="done" pr="12" verdict="approve">\n/,
  )
  await stopAll($, clock, ['w-busy'])
})
