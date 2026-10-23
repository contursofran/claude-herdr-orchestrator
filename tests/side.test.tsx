import { expect, test } from 'claude-code/testing'
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
  expect((await ui.find({ key: 'task-#640' }))?.text).toMatch(/#640 +Sort bags +◐ +◐ +· +· +\? +w-busy now/)
  expect((await ui.find({ key: 'item-D1' }))?.text).toMatch(/▸ \? D1 +Bag sort order +#640/)
  expect((await ui.find({ key: 'item-T1' }))?.text).toMatch(/☐ T1 +Merge server #77 +#77/)

  // The recommended answer comes first; answering keeps the box on D1 and its row in place.
  await ui.press({ key: 'opt-1-0' })
  expect(submitted.at(-1)).toMatch(/<herdr-decision id="D1" from="w-busy">[\s\S]*The owner chose: By type/)
  expect((await ui.find({ key: 'item-D1' }))?.text).toMatch(/✓ D1 +Bag sort order/)
  expect(await ui.find({ type: 'Text', text: '✓ By type' })).toBeDefined()
  expect((await ui.find({ key: 'next' }))?.text).toBe('next T1 ▸')
  expect((await ui.find({ key: 'task-#640' }))?.text).toMatch(/◐ +◐ +· +· +✓ +w-busy/)

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
  expect((await ui.find({ key: 'task-#12' }))?.text).toMatch(/#12 +hotbar keys +· +✓ +◐ +◐ +· +r-15 now/)
  expect(await ui.find({ key: 'task-#15' })).toBeUndefined()

  await ui.press({ key: 'task-#12' })
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
  expect((await ui.find({ key: 'task-#12' }))?.text).toMatch(/· +✓ +✓ +✓ +· +merged/)
  await ui.press({ key: 'clear-tasks' })
  expect(await ui.find({ key: 'task-#12' })).toBeUndefined()
  await ui.unmount()
})
