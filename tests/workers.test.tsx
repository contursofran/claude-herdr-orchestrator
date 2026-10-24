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
  const { clock, submitted, typed, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-done', profile: 'builder', cwd: '/repo/wt', task: 'Fix the nits.' })
  const dir = '/repo/wt/.herdr-agents/w-done'
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${dir}/RESULT.md`] = `<!-- report ${token} -->\nStopped.\nDECISION: [Edit scope] May I edit CI scripts? | Yes (recommended) | No`
  await clock.advance(10_000)
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
  await clock.advance(10_000)
  const long = 'x'.repeat(5000)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-done', text: long })
  const pointer = typed.at(-1)?.match(/New message from your coordinator in (\S+\/MESSAGE-\d+-\w+\.md), a file you have not read yet/)?.[1]
  expect(pointer && files[pointer]).toBe(long)
  expect(typed.at(-1)).not.toContain(long)
  await stopAll($, clock, ['w-done'])
})

test('a DECISION line that says none is not pinned for the owner', async ($, on) => {
  const { clock, submitted, typed, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-none', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-none/RESULT.md'] =
    `<!-- report ${token} -->\nOpened PR #4.\nDECISION: none. No owner decision is needed for this PR.\n**decision:** None\nDECISION: [Port] Which port? | 5173 (recommended) | 8080`
  await clock.advance(10_000)
  const report = submitted.at(-1) ?? ''
  expect(report).toMatch(/Pinned for the owner as D1/)
  expect(report).not.toMatch(/D2/)
  await stopAll($, clock, ['w-none'])
})

test('a prompt that starts no work is typed again, and a worker it never reaches is reported blocked', async ($, on) => {
  const { clock, submitted, typed, files, stalls } = await start($, on)
  // The first try stalls; the second starts work, so the worker runs on and reports.
  stalls['w-late'] = 1
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-late', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  expect(typed).toHaveLength(2)
  expect(typed[1]).toBe(typed[0])
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-late/RESULT.md'] = `<!-- report ${token} -->\nDone.`
  await clock.advance(10_000)
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
    const token = typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
    files[`/repo-${worker}/.herdr-agents/${worker}/RESULT.md`] = `<!-- report ${token} -->\n${text}`
  }
  await report('w-done', 'Reviewed: approve.')
  await report('w-ask', 'DECISION: Ship it today? | Yes | No')
  // herdr shows this one still working after its report.
  await report('w-busy', 'Reviewed: two blockers.')
  await clock.advance(10_000)

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

test('a worker that stops without a report is reported once its screen sits still; background work of its own buys it an hour', async ($, on) => {
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
})

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
