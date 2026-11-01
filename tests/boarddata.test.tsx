import { expect } from 'claude-code/testing'
import { briefRefs, groupTasks } from '../hooks/tasks'
import type { Job } from '../types'
import { settled, start, stopAll, test, until } from './harness'

// The board's work rows: workers grouped by issue or PR, and the PR's checks while the app mod draws the boards.

const BOARD = '/home/t/.herdr-agents/board/session-1234.json'
const INBOX = '/home/t/.herdr-agents/board/session-1234.actions'
const HEARTBEAT = '/home/t/.herdr-agents/app-mod.json'

type Row = { key: string; label: string; title: string; stages: string[]; who: { text: string }; item: string | null; isMerged: boolean }
const rowsIn = (files: Record<string, string>) => (JSON.parse(files[BOARD] ?? '{}').tasks ?? []) as Row[]
const beat = (at: number) => JSON.stringify({ at, terminals: ['t1'] })

test('workers on one issue share a row, which names the question that waits on the person', async ($, on) => {
  const { clock, files } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'p-640',
    profile: 'planner',
    cwd: '/repo',
    task: '# Plan acme/app-client issue #640 (Sort bags)\n\nRead the issue.',
  })
  await settled()
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'w-busy',
    profile: 'builder',
    cwd: '/repo/wt',
    task: 'Build #640: sort by type',
  })
  await settled()
  await $.tool.call({
    tool: 'mcp__herdr-agents__ask_owner',
    question: 'Sort bags by type or by weight?',
    title: 'Bag sort order',
    options: ['By weight', 'By type'],
    recommended: 1,
    from: 'w-busy',
  })
  await clock.advance(3000)

  // plan and build run, CI has not started, the question is the person's.
  const [row, ...others] = rowsIn(files)
  expect(others).toEqual([])
  expect(row).toMatchObject({ key: 'acme/app-client#640', label: '#640', title: 'Sort bags', item: 'D1' })
  expect(row?.stages).toEqual(['run', 'run', 'none', 'none', 'ask'])
  await stopAll($, clock, ['p-640', 'w-busy'])
})

test("a reviewer joins the row of the PR its builder linked, with the PR's checks; clear done removes it until a new worker", async ($, on) => {
  const { clock, typed, files, prs, finish } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'w-done',
    profile: 'builder',
    cwd: '/repo/wt',
    task: '# Build #12: hotbar keys',
  })
  await settled()
  await clock.settle()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-done/RESULT.md'] =
    `<!-- report ${token} -->\nOpened https://github.com/acme/app-client/pull/15. Tests pass.`
  await finish('w-done')
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'r-15',
    profile: 'reviewer',
    cwd: '/repo',
    task: 'Review acme/app-client PR #15 (hotbar keys)',
  })
  await settled()
  prs['acme/app-client#15'] = { state: 'OPEN', statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }] }
  // The 2-minute tick polls while the app mod's heartbeat is fresh.
  const twoMinutes = async () => {
    for (let i = 0; i < 5; i++) {
      files[HEARTBEAT] = beat(clock.now())
      await clock.advance(30_000)
    }
  }
  await twoMinutes()
  const row12 = () => rowsIn(files).find(r => r.key === 'acme/app-client#12')
  await until(clock, async () => row12()?.stages[3] === 'run')
  // No planner, the build reported, the review runs and so do the PR's checks.
  expect(row12()?.stages).toEqual(['none', 'done', 'run', 'run', 'none'])
  expect(rowsIn(files).some(r => r.key === 'acme/app-client#15')).toBe(false)

  // Once the review is in and the PR merged, the row is done until clear done removes it.
  await stopAll($, clock, ['r-15'])
  prs['acme/app-client#15'] = {
    state: 'MERGED',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  }
  await twoMinutes()
  await until(clock, async () => row12()?.isMerged === true)
  expect(row12()?.stages).toEqual(['none', 'done', 'done', 'done', 'none'])
  files[`${INBOX}/1.json`] = JSON.stringify({ action: 'clearDone', what: 'tasks' })
  await until(clock, async () => row12() === undefined)

  // A new worker on it brings the row back.
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'f-12', profile: 'builder', cwd: '/repo/wt2', task: 'Fix round for #12' })
  await settled()
  await clock.advance(3000)
  expect(row12()?.stages[1]).toBe('run')
  await stopAll($, clock, ['f-12'])
})

test('one number in two repos is two rows, and a review row joins its builder once the report names the PR', async ($, on) => {
  const { clock, typed, files } = await start($, on)
  const spawn = async (worker: string, profile: string, cwd: string, task: string) => {
    await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker, profile, cwd, task })
    await clock.settle()
  }
  await spawn('c-640', 'builder', '/repo', 'Build #640: sort bags')
  await spawn('s-640', 'builder', '/srv', 'Build #640: bag weights')
  await spawn('w-12', 'builder', '/repo/wt', 'Build #12: hotbar keys')
  await spawn('r-15', 'reviewer', '/repo', 'Review PR #15 (hotbar keys)')
  await clock.advance(3000)

  const row = (key: string) => rowsIn(files).find(r => r.key === key)
  expect(row('acme/app-client#640')?.title).toBe('sort bags')
  expect(row('acme/app-server#640')?.title).toBe('bag weights')
  // The review runs before the builder's report says which PR it opened: a row of its own.
  expect(row('acme/app-client#15')?.stages.slice(0, 3)).toEqual(['none', 'none', 'run'])

  const token = typed.find(t => t.includes('w-12'))?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-12/RESULT.md'] = `<!-- report ${token} -->\nOpened https://github.com/acme/app-client/pull/15.`
  await clock.advance(10_000)
  await until(clock, async () => row('acme/app-client#15') === undefined)
  expect(row('acme/app-client#12')?.stages.slice(0, 3)).toEqual(['none', 'done', 'run'])
  await stopAll($, clock, ['c-640', 's-640', 'r-15'])
})

test("a report's PR goes to its worker's row: the header's, else the link in a report without one", async ($, on) => {
  const { clock, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-link', profile: 'builder', cwd: '/repo/wt2', task: 'Fix it.' })
  await settled()
  const tokens = [typed[0], typed[1]].map(t => t?.match(/<!-- report (\S+) -->/)?.[1])
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] =
    `<!-- report ${tokens[0]} -->\n\`\`\`report\nstatus: done\npr: 12\nsummary: Opened PR #12.\n\`\`\``
  files['/repo/wt2/.herdr-agents/w-link/RESULT.md'] = `<!-- report ${tokens[1]} -->\nOpened https://github.com/acme/app-client/pull/77.`
  await finish('w-busy')
  await finish('w-link')
  await clock.advance(3000)

  const keys = rowsIn(files).map(r => r.key)
  expect(keys).toContain('acme/app-client#12')
  expect(keys).toContain('acme/app-client#77')
  await stopAll($, clock, ['w-busy', 'w-link'])
})

test('workers join through shared numbers, and only a role name gives a number', async () => {
  const job = (name: string, startedAt: number, refs: number[]): Job => ({
    name,
    profile: 'builder',
    cwd: '/x',
    dir: '/x',
    startedAt,
    status: 'running',
    refs,
  })
  expect(briefRefs('Fix the login page', 'w-20251023').refs).toBeUndefined()
  expect(briefRefs('Fix the login page', 'b513-c1').refs).toEqual([513])
  expect(briefRefs('Review acme/app PR #9', 'r-1').prs).toEqual([9])
  const tasks = groupTasks({
    jobs: [job('a', 1, [1]), job('b', 2, [1, 2]), job('c', 3, [2]), job('d', 4, [3])],
    rows: [],
    items: [],
    prs: {},
    now: 10,
    repoOf: () => 'acme/app',
  })
  expect(tasks.map(t => [t.key, t.jobs.map(j => j.name).join()])).toEqual([
    ['acme/app#1', 'a,b,c'],
    ['acme/app#3', 'd'],
  ])
})

test('a starting worker is a running stage (◐) on its task row', () => {
  const [task] = groupTasks({
    jobs: [{ name: 'b-7', profile: 'builder', cwd: '/x', dir: '/x', startedAt: 1, status: 'starting', refs: [7] }],
    rows: [{ name: 'b-7', profile: 'builder', state: 'starting', startedAt: 1 }],
    items: [],
    prs: {},
    now: 10,
    repoOf: () => 'acme/app',
  })
  expect(task!.stages[1]).toBe('run')
  expect(task!.tab).toBe('b-7')
  expect(task!.isFinished).toBe(false)
})

test('a reported worker that waits blocked is a blocked stage on its task row, not a finished one', () => {
  const [task] = groupTasks({
    jobs: [{ name: 'b-7', profile: 'builder', cwd: '/x', dir: '/x', startedAt: 1, status: 'reported', endedAt: 5, refs: [7] }],
    rows: [{ name: 'b-7', profile: 'builder', state: 'blocked', startedAt: 1 }],
    items: [],
    prs: {},
    now: 10,
    repoOf: () => 'acme/app',
  })
  expect(task!.stages[1]).toBe('block')
  expect(task!.isFinished).toBe(false)
  expect(task!.who.text).toBe('blocked')
})
