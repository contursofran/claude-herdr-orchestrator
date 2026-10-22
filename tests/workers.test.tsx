import { expect, test } from 'claude-code/testing'
import { command, start, stopAll } from './harness'

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
