import { expect, test } from 'claude-code/testing'
import { briefRefs, groupTasks } from '../hooks/tasks'
import type { Job } from '../types'
import { BAND, command, start, stopAll } from './harness'

// The sidebar (/hrd-side): work by issue or PR, what needs the person, and the answer box.

const PANE = {
  plugin: 'herdr-agents',
  component: 'Pane',
  requestId: 'hrd-side',
  props: { title: 'herdr', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('workers on one issue share a row, and an answer stays in its slot until clear done', async ($, on) => {
  const { clock, submitted } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'p-640',
    profile: 'planner',
    cwd: '/repo',
    task: '# Plan acme/app-client issue #640 (Sort bags)\n\nRead the issue.',
  })
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'w-busy',
    profile: 'builder',
    cwd: '/repo/wt',
    task: 'Build #640: sort by type',
  })
  await $.tool.call({
    tool: 'mcp__herdr-agents__ask_owner',
    question: 'Sort bags by type or by weight?',
    title: 'Bag sort order',
    options: ['By weight', 'By type'],
    recommended: 1,
    from: 'w-busy',
  })
  await clock.advance(1000)
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Merge server #77' })
  expect((await command($, 'hrd-side')).text).toMatch(/Sidebar open/)
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // plan and build run, CI has not started, the question is the person's.
  expect((await ui.find({ key: 'task-acme/app-client#640' }))?.text).toMatch(/#640 +Sort bags +◐ +◐ +· +· +\? +w-busy now/)
  expect((await ui.find({ key: 'item-D1' }))?.text).toMatch(/▸ \? D1 +Bag sort order +#640/)
  expect((await ui.find({ key: 'item-T1' }))?.text).toMatch(/☐ T1 +Merge server #77 +#77/)

  // The recommended answer comes first; answering keeps the box on D1 and its row in place.
  await ui.press({ key: 'opt-1-0' })
  expect(submitted.at(-1)).toMatch(/<herdr-decision id="D1" from="w-busy">[\s\S]*The owner chose: By type/)
  expect((await ui.find({ key: 'item-D1' }))?.text).toMatch(/✓ D1 +Bag sort order/)
  expect(await ui.find({ type: 'Text', text: '✓ By type' })).toBeDefined()
  expect((await ui.find({ key: 'next' }))?.text).toBe('next T1 ▸')
  expect((await ui.find({ key: 'task-acme/app-client#640' }))?.text).toMatch(/◐ +◐ +· +· +✓ +w-busy/)

  await ui.press({ key: 'clear-items' })
  expect(await ui.find({ key: 'item-D1' })).toBeUndefined()
  expect((await ui.find({ key: 'item-T1' }))?.text).toMatch(/☐ T1/)

  // The band steps aside while the sidebar shows, and comes back once it closes.
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  expect((await command($, 'hrd-side')).text).toBe('Sidebar closed.')
  await band.redraw()
  expect(await band.find({ type: 'Text', text: /^☐ Merge server .*#77 +T1/ })).toBeDefined()
  await band.unmount()
  await ui.unmount()
  await stopAll($, clock, ['p-640', 'w-busy'])
})

test("a reviewer joins the row of the PR its builder linked, with the PR's checks", async ($, on) => {
  const { clock, typed, files, prs } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'w-done',
    profile: 'builder',
    cwd: '/repo/wt',
    task: '# Build #12: hotbar keys',
  })
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-done/RESULT.md'] =
    `<!-- report ${token} -->\nOpened https://github.com/acme/app-client/pull/15. Tests pass.`
  await clock.advance(10_000)
  await $.tool.call({
    tool: 'mcp__herdr-agents__spawn',
    worker: 'r-15',
    profile: 'reviewer',
    cwd: '/repo',
    task: 'Review acme/app-client PR #15 (hotbar keys)',
  })
  prs['acme/app-client#15'] = { state: 'OPEN', statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }] }
  await command($, 'hrd-side')
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // No planner, the build reported, the review runs and so do the PR's checks.
  expect((await ui.find({ key: 'task-acme/app-client#12' }))?.text).toMatch(/#12 +hotbar keys +· +✓ +◐ +◐ +· +r-15 now/)
  expect(await ui.find({ key: 'task-acme/app-client#15' })).toBeUndefined()

  await ui.press({ key: 'task-acme/app-client#12' })
  // A Link's found text is its href, then what it draws.
  const open = (await ui.findAll({ type: 'Link' })).find(l => String(l.text).endsWith('open'))
  expect(open?.props.href).toBe('https://github.com/acme/app-client/pull/15')
  expect(await ui.find({ type: 'Text', text: 'app-client PR #15' })).toBeDefined()
  await ui.press({ key: 'show-report' })
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toMatch(/Opened https:\/\/github\.com\/acme\/app-client\/pull\/15/)
  await ui.press({ key: 'back' })

  // Once the review is in and the PR merged, the row is done until clear done removes it.
  await stopAll($, clock, ['r-15'])
  prs['acme/app-client#15'] = {
    state: 'MERGED',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  }
  await clock.advance(2 * 60_000)
  expect((await ui.find({ key: 'task-acme/app-client#12' }))?.text).toMatch(/· +✓ +✓ +✓ +· +merged/)
  await ui.press({ key: 'clear-tasks' })
  expect(await ui.find({ key: 'task-acme/app-client#12' })).toBeUndefined()

  // A new worker on it brings the row back.
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'f-12', profile: 'builder', cwd: '/repo/wt2', task: 'Fix round for #12' })
  await clock.advance(3000)
  expect((await ui.find({ key: 'task-acme/app-client#12' }))?.text).toMatch(/#12 +hotbar keys +· +◐/)
  await ui.unmount()
  await stopAll($, clock, ['f-12'])
})

test('one number in two repos is two rows, and a row that joins another keeps its slot', async ($, on) => {
  const { clock, typed, files, prs } = await start($, on)
  const spawn = (worker: string, profile: string, cwd: string, task: string) =>
    $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker, profile, cwd, task })
  await spawn('c-640', 'builder', '/repo', 'Build #640: sort bags')
  await spawn('s-640', 'builder', '/srv', 'Build #640: bag weights')
  await spawn('w-12', 'builder', '/repo/wt', 'Build #12: hotbar keys')
  await spawn('r-15', 'reviewer', '/repo', 'Review PR #15 (hotbar keys)')
  await command($, 'hrd-side')
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'task-acme/app-client#640' }))?.text).toMatch(/#640 +sort bags/)
  expect((await ui.find({ key: 'task-acme/app-server#640' }))?.text).toMatch(/#640 +bag weights/)
  // The review runs before the builder's report says which PR it opened: a row of its own.
  expect((await ui.find({ key: 'task-acme/app-client#15' }))?.text).toMatch(/#15 +hotbar keys +· +· +◐/)
  await ui.press({ key: 'task-acme/app-client#15' })

  // The report links PR #15: the review joins #12, its slot says so until clear done, the
  // box follows it to #12, and the PR's failed checks show ■.
  const token = typed.find(t => t.includes('w-12'))?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-12/RESULT.md'] = `<!-- report ${token} -->\nOpened https://github.com/acme/app-client/pull/15.`
  prs['acme/app-client#15'] = {
    state: 'OPEN',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
  }
  await clock.advance(10_000)
  await clock.advance(2 * 60_000)
  expect((await ui.find({ key: 'task-acme/app-client#12' }))?.text).toMatch(/#12 +hotbar keys +· +✓ +◐ +■ +· +r-15/)
  expect((await ui.find({ key: 'task-acme/app-client#15' }))?.text).toMatch(/#15 +joined #12/)
  expect(await ui.find({ type: 'Text', text: /^#12  hotbar keys/ })).toBeDefined()
  await ui.press({ key: 'clear-tasks' })
  expect(await ui.find({ key: 'task-acme/app-client#15' })).toBeUndefined()
  expect(await ui.find({ key: 'task-acme/app-client#12' })).toBeDefined()
  await ui.unmount()
  await stopAll($, clock, ['c-640', 's-640', 'r-15'])
})

test('the box shows every answer at the same height, and a closed item keeps its slot', async ($, on) => {
  const { clock, submitted } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__ask_owner',
    question:
      'The bag window needs one layout for the first release. The old client used a fixed grid; testers asked for sorting by weight, and the art team drew tabs per item type. Which one ships first?',
    title: 'Bag layout',
    options: ['A fixed grid like the old client', 'Sorted by weight', 'Tabs per item type', 'Both, behind a setting'],
    recommended: 2,
  })
  await clock.advance(1000)
  await $.tool.call({ tool: 'mcp__herdr-agents__ask_owner', question: 'Ship on Friday?', title: 'Ship day', options: ['Yes', 'No'] })
  await command($, 'hrd-side')
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Four answers, the recommended first, take two lines, so the question keeps two.
  expect((await ui.find({ key: 'opt-1-0' }))?.text).toBe(' Tabs per item type ')
  expect((await ui.find({ key: 'opt-1-1' }))?.text).toBe('A fixed grid like the old c…')
  expect(await ui.find({ key: 'opt-1-3' })).toBeDefined()
  expect(await ui.find({ key: 'ol1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^The bag window needs one layout/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^client used a fixed grid.*…$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ships first/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'tab moves · enter presses' })).toBeDefined()

  // The coordinator settles D1: it stays in its slot, struck through, with the answer, and
  // a new to-do takes the next free slot.
  await ui.press({ key: 'item-D1' })
  await $.tool.call({ tool: 'mcp__herdr-agents__decided', ids: ['D1'], answer: 'Tabs', by: 'coordinator' })
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Test the bags at http://localhost:5173' })
  await clock.advance(3000)
  expect((await ui.find({ key: 'item-D1' }))?.text).toMatch(/✓ D1 +Bag layout/)
  expect(await ui.find({ type: 'Text', text: '✓ Tabs (coordinator)' })).toBeDefined()
  expect((await ui.find({ key: 'item-T1' }))?.text).toMatch(/☐ T1 +Test the bags/)

  // A to-do's box links what its text names; Done sends it.
  await ui.press({ key: 'item-T1' })
  expect((await ui.findAll({ type: 'Link' })).find(l => String(l.text).endsWith('open'))?.props.href).toBe('http://localhost:5173')
  await ui.press({ key: 'tick-1' })
  expect(submitted.at(-1)).toMatch(/herdr-owner-done/)
  expect(await ui.find({ type: 'Text', text: '✓ done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'T1 done · sent' })).toBeDefined()
  await ui.unmount()
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
