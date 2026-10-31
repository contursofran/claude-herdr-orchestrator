import { expect } from 'claude-code/testing'
import { BATCH_MS } from '../hooks/defaults'
import { settled, start, stopAll, test } from './harness'
import { kindOf, labelOf } from '../hooks/timecomment'
import { PROFILES } from '../hooks/config'
import { jobOf, spawnBusy, W } from './workerkit'

// The time a worker took, posted on its PR or issue when it reports done (#252).

const CONFIG = { timeComments: { repos: ['acme/app-client'], for: 'owner' } }
const comments = (shell: string[]) => shell.filter(c => c.startsWith('gh issue comment'))
const macOs = (s: Awaited<ReturnType<typeof start>>) => s.runs.set('uname -s', [{ exitCode: 0, stdout: 'Darwin\n' }])

// Spawns a builder (a fix, in /repo/wt), lets `work` ms pass, and has it report `text`.
async function report(
  $: Parameters<typeof start>[0],
  s: Awaited<ReturnType<typeof start>>,
  text: string,
  work = 7 * 60_000,
  profile = 'builder',
) {
  await spawnBusy($, profile)
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await s.clock.advance(work)
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\n${text}`
  await s.finish('w-busy')
  await s.clock.advance(BATCH_MS)
  await settled()
  return token
}

const done = '```report\nstatus: done\npr: 7\nsummary: built it\n```\n'

test('a done report posts the working time on its PR', async ($, on) => {
  const s = await start($, on, CONFIG)
  macOs(s)
  await report($, s, done)
  expect(comments(s.shell)).toEqual([
    'gh issue comment 7 -R acme/app-client --body [agent for @owner · Sonnet medium · mac] fix: 7 min working (w-busy).',
  ])
  await stopAll($, s.clock, ['w-busy'])
})

test('parked time is kept apart from working time', async ($, on) => {
  const s = await start($, on, CONFIG)
  macOs(s)
  await spawnBusy($, 'builder')
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await s.clock.advance(3 * 60_000)
  s.files[`${W}/WAIT.json`] = '{"for":"ci","check":"ci","every":1,"max":600}'
  s.runs.set('/bin/bash -c ci', [{ exitCode: 1 }])
  await s.finish('w-busy')
  await s.clock.advance(5 * 60_000)
  s.runs.set('/bin/bash -c ci', [{ exitCode: 0 }])
  await s.clock.advance(2 * 60_000)
  expect(s.typed.at(-1)).toContain('Your wait is over')
  s.files[`${W}/RESULT.md`] = `<!-- report ${s.typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1] ?? token} -->\n${done}`
  await s.finish('w-busy')
  await s.clock.advance(BATCH_MS)
  await settled()
  const [c] = comments(s.shell)
  expect(c).toMatch(/fix: [34] min working, [56] min parked \(w-busy\)\.$/)
  await stopAll($, s.clock, ['w-busy'])
})

test('a reviewer reports a review, with its model and effort', async ($, on) => {
  const s = await start($, on, CONFIG)
  macOs(s)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'reviewer', cwd: '/repo/wt', task: 'Review PR #7.' })
  await settled()
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await s.clock.advance(5 * 60_000)
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\n${done}`
  await s.finish('w-busy')
  await s.clock.advance(BATCH_MS)
  await settled()
  expect(comments(s.shell)[0]).toContain('[agent for @owner · Opus high · mac] review: 5 min working')
  await stopAll($, s.clock, ['w-busy'])
})

test("a report with no PR posts on the brief's issue", async ($, on) => {
  const s = await start($, on, CONFIG)
  macOs(s)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Do #12.' })
  await settled()
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nstatus: done\nsummary: nothing to open`
  await s.finish('w-busy')
  await s.clock.advance(BATCH_MS)
  await settled()
  expect(comments(s.shell)[0]).toContain('gh issue comment 12 -R acme/app-client')
  await stopAll($, s.clock, ['w-busy'])
})

test('nothing is posted unless the repo opted in', async ($, on) => {
  const s = await start($, on, { timeComments: { repos: ['acme/other'] } })
  await report($, s, done)
  expect(comments(s.shell)).toEqual([])
  expect(jobOf(s.store, 'w-busy')).toMatchObject({ status: 'reported' })
  await stopAll($, s.clock, ['w-busy'])
})

for (const status of ['blocked', 'failed']) {
  test(`a ${status} report posts nothing`, async ($, on) => {
    const s = await start($, on, CONFIG)
    await report($, s, `\`\`\`report\nstatus: ${status}\npr: 7\nsummary: stuck\n\`\`\`\n`)
    expect(comments(s.shell)).toEqual([])
    await stopAll($, s.clock, ['w-busy'])
  })
}

test('the kind comes from the profile, and for a builder from how it was spawned', () => {
  const job = { name: 'w', cwd: '/x', dir: '/x/w', startedAt: 0, status: 'reported' as const }
  expect(kindOf({ ...job, profile: 'reviewer' })).toBe('review')
  expect(kindOf({ ...job, profile: 'planner' })).toBe('plan')
  expect(kindOf({ ...job, profile: 'debugger' })).toBe('debug')
  expect(kindOf({ ...job, profile: 'builder', kind: 'feature' })).toBe('feature')
  expect(kindOf({ ...job, profile: 'builder', kind: 'fix' })).toBe('fix')
})

test("the label is the profile's own, else its model and effort", () => {
  expect(labelOf('builder', PROFILES.builder)).toBe('Sonnet medium')
  expect(labelOf('debugger', PROFILES.debugger)).toBe('Opus medium')
  expect(labelOf('x', { kind: 'codex', args: [] })).toBe('x')
  expect(labelOf('builder', { ...PROFILES.builder!, label: 'Sonnet 5.5 medium' })).toBe('Sonnet 5.5 medium')
})

test('one report posts once, even when its file is rewritten', async ($, on) => {
  const s = await start($, on, CONFIG)
  macOs(s)
  const token = await report($, s, done)
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\n${done}More detail.`
  await s.clock.advance(BATCH_MS * 3)
  await settled()
  expect(comments(s.shell)).toHaveLength(1)
  await stopAll($, s.clock, ['w-busy'])
})

test('a failed post never fails the report; it is logged in the worker folder', async ($, on) => {
  const s = await start($, on, CONFIG)
  macOs(s)
  s.runs.set('gh issue comment 7 -R acme/app-client --body [agent for @owner · Sonnet medium · mac] fix: 7 min working (w-busy).', [
    { exitCode: 1, stderr: 'HTTP 403\nrate limited' },
  ])
  await report($, s, done)
  expect(jobOf(s.store, 'w-busy')).toMatchObject({ status: 'reported', reportStatus: 'done' })
  expect(s.files[`${W}/TIME-COMMENT.log`]).toContain('HTTP 403')
  await stopAll($, s.clock, ['w-busy'])
})

test('a report after a follow-up message posts only the time since that message', async ($, on) => {
  const s = await start($, on, CONFIG)
  macOs(s)
  await report($, s, done)
  await s.clock.advance(4 * 60_000)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'One more fix.' })
  await settled()
  const token = s.typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  await s.clock.advance(2 * 60_000)
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\n${done}`
  await s.finish('w-busy')
  await s.clock.advance(BATCH_MS)
  await settled()
  expect(comments(s.shell)).toHaveLength(2)
  expect(comments(s.shell)[1]).toMatch(/fix: 2 min working \(w-busy\)\.$/)
  await stopAll($, s.clock, ['w-busy'])
})
