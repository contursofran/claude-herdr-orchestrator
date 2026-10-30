import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { addCard, addVersion, coordinatorLayout, repointAgents, writeCoordinatorLayout } from '../layout.mjs'

// The shape of Herdr's main layout where it matters: work is tabs / work-body / status.
const main = () => ({
  id: 'root',
  type: 'row',
  children: [
    { id: 'sidebar', type: 'column', children: [{ id: 'agents', type: 'block', content: { mod: 'agents' } }] },
    {
      id: 'work',
      type: 'column',
      resizable: false,
      children: [
        { id: 'tabs', type: 'block', size: { px: 42 }, content: { mod: 'tabs' } },
        { id: 'work-body', type: 'row', children: [{ id: 'main', type: 'block', content: { tab: 'active' } }] },
        { id: 'status', type: 'block', size: { px: 28 }, content: { mod: 'workspace-status' } },
      ],
    },
  ],
})
const ids = layout => layout.children[1].children.map(c => c.id)

test("the pin bar goes after tabs and the strip after work-body, with the plan's sizes and roles", () => {
  const layout = coordinatorLayout(main())
  assert.deepEqual(ids(layout), ['tabs', 'hrd-pins', 'work-body', 'hrd-strip', 'hrd-status-row'])
  const [, pins, body, strip] = layout.children[1].children
  assert.deepEqual(body.children[0].floating, [
    { id: 'hrd-card', content: { mod: 'herdr-agents', props: { role: 'card' } }, edge: 'bottom', align: 'center' },
  ])
  assert.deepEqual(pins, {
    id: 'hrd-pins',
    type: 'block',
    size: { px: 38 },
    resizable: false,
    content: { mod: 'herdr-agents', props: { role: 'pinbar' } },
  })
  assert.deepEqual(strip, {
    id: 'hrd-strip',
    type: 'block',
    size: { px: 34 },
    resizable: false,
    content: { mod: 'herdr-agents', props: { role: 'strip' } },
  })
  assert.deepEqual(layout.cloned_from, { name: 'main' })
})

test('cloned_from carries the version when it is known', () => {
  assert.deepEqual(coordinatorLayout(main(), '0.1.9').cloned_from, { name: 'main', version: '0.1.9' })
})

test('everything else is main as it was, and main is not changed', () => {
  const input = main()
  const layout = coordinatorLayout(input)
  assert.deepEqual(input, main())
  delete layout.cloned_from
  // The status block's row goes back to the block it holds, at the row's height.
  const row = layout.children[1].children.at(-1)
  layout.children[1].children.push({ ...row.children[0], size: row.size })
  layout.children[1].children = layout.children[1].children.filter(c => !c.id.startsWith('hrd-'))
  layout.children[0].children[0].content = { mod: 'agents' }
  assert.equal(layout.children[1].children[1].children[0].floating.length, 1, 'only the floating card is added to main')
  delete layout.children[1].children[1].children[0].floating
  assert.deepEqual(layout, main())
})

test('a main without the work column, or already carrying the rows, is refused', () => {
  const noWork = main()
  noWork.children.pop()
  assert.throws(() => coordinatorLayout(noWork), /no work column/)
  const wrongOrder = main()
  wrongOrder.children[1].children.reverse()
  assert.throws(() => coordinatorLayout(wrongOrder), /no work column/)
  assert.throws(() => coordinatorLayout(coordinatorLayout(main())), /already has/)
})

test('writeCoordinatorLayout writes the file once and never overwrites it', () => {
  const home = mkdtempSync(join(tmpdir(), 'hrd-layout-'))
  try {
    mkdirSync(join(home, 'layouts'))
    writeFileSync(join(home, 'layouts', 'main.json'), JSON.stringify(main()))
    assert.equal(writeCoordinatorLayout(home), 'written')
    const target = join(home, 'layouts', 'coordinator.json')
    assert.deepEqual(ids(JSON.parse(readFileSync(target, 'utf8'))), ['tabs', 'hrd-pins', 'work-body', 'hrd-strip', 'hrd-status-row'])
    writeFileSync(target, '{"mine":true}')
    assert.equal(writeCoordinatorLayout(home), 'exists')
    assert.equal(readFileSync(target, 'utf8'), '{"mine":true}')
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'layouts', 'main.json'), 'utf8')), main())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('without a main layout nothing is written', () => {
  const home = mkdtempSync(join(tmpdir(), 'hrd-layout-'))
  try {
    mkdirSync(join(home, 'layouts'))
    assert.throws(() => writeCoordinatorLayout(home))
    assert.equal(existsSync(join(home, 'layouts', 'coordinator.json')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the agents block points at this mod with role agents; main keeps Herdr's own", () => {
  const input = main()
  const layout = coordinatorLayout(input)
  assert.deepEqual(layout.children[0].children[0], {
    id: 'agents',
    type: 'block',
    content: { mod: 'herdr-agents', props: { role: 'agents' } },
  })
  assert.deepEqual(input.children[0].children[0].content, { mod: 'agents' })
})

test("repointAgents keeps the block's other content props", () => {
  const layout = main()
  layout.children[0].children[0].content = { mod: 'agents', props: { keep: 1, role: 'x' }, extra: true }
  assert.equal(repointAgents(layout), true)
  assert.deepEqual(layout.children[0].children[0].content, {
    mod: 'herdr-agents',
    props: { keep: 1, role: 'agents' },
    extra: true,
  })
})

test("repointAgents touches only a block still on Herdr's agents mod", () => {
  const mine = main()
  mine.children[0].children[0].content = { mod: 'my-agents' }
  assert.equal(repointAgents(mine), false)
  assert.deepEqual(mine.children[0].children[0].content, { mod: 'my-agents' })
  const again = coordinatorLayout(main())
  assert.equal(repointAgents(again), false)
  assert.equal(repointAgents({ id: 'root', children: [] }), false)
})

test('a coordinator layout that exists gets its agents block repointed and nothing else', () => {
  const home = mkdtempSync(join(tmpdir(), 'hrd-layout-'))
  try {
    mkdirSync(join(home, 'layouts'))
    writeFileSync(join(home, 'layouts', 'main.json'), JSON.stringify(main()))
    const target = join(home, 'layouts', 'coordinator.json')
    const old = main()
    old.children[1].children.splice(1, 0, { id: 'mine', type: 'block', size: { px: 10 } })
    writeFileSync(target, JSON.stringify(old))
    assert.equal(writeCoordinatorLayout(home), 'updated')
    const got = JSON.parse(readFileSync(target, 'utf8'))
    assert.deepEqual(got.children[0].children[0].content, { mod: 'herdr-agents', props: { role: 'agents' } })
    got.children[0].children[0].content = { mod: 'agents' }
    // The floating card on `main` is another addition; the owner's own block stays where it was.
    assert.deepEqual(
      got.children[1].children.map(c => c.id),
      ['tabs', 'mine', 'work-body', 'hrd-status-row'],
    )
    assert.equal(got.children[1].children[2].children[0].floating[0].id, 'hrd-card')
    delete got.children[1].children[2].children[0].floating
    // ...and the status block's row, which has a test of its own.
    got.children[1].children[3] = old.children[1].children[3]
    assert.deepEqual(got, old)
    assert.equal(writeCoordinatorLayout(home), 'exists', 'a second run changes nothing')
    writeFileSync(target, 'not json')
    assert.equal(writeCoordinatorLayout(home), 'exists')
    assert.equal(readFileSync(target, 'utf8'), 'not json')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

const layoutHome = (t, layout) => {
  const home = mkdtempSync(join(tmpdir(), 'hrd-layout-'))
  mkdirSync(join(home, 'layouts'))
  writeFileSync(join(home, 'layouts', 'main.json'), JSON.stringify(main()))
  writeFileSync(join(home, 'layouts', 'coordinator.json'), JSON.stringify(layout))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return { home, target: join(home, 'layouts', 'coordinator.json') }
}

test("the old hidden card row is removed and the floating card added, and the owner's edits stay", t => {
  const old = coordinatorLayout(main())
  const kids = old.children[1].children
  kids.splice(3, 0, {
    id: 'hrd-card',
    type: 'block',
    size: { px: 120 },
    resizable: false,
    hidden: true,
    content: { mod: 'herdr-agents', props: { role: 'card' } },
  })
  delete kids[2].children[0].floating
  kids[1].size = { px: 50 } // the owner's own edit
  const { home, target } = layoutHome(t, old)
  assert.equal(writeCoordinatorLayout(home), 'updated')
  const got = JSON.parse(readFileSync(target, 'utf8'))
  assert.deepEqual(ids(got), ['tabs', 'hrd-pins', 'work-body', 'hrd-strip', 'hrd-status-row'])
  assert.deepEqual(got.children[1].children[1].size, { px: 50 })
  assert.deepEqual(
    got.children[1].children[2].children[0].floating.map(f => f.id),
    ['hrd-card'],
  )
  assert.equal(writeCoordinatorLayout(home), 'exists', 'a second run changes nothing')
})

test('a floating card the owner dragged is left alone, and a leftover hidden row is still removed', t => {
  const old = coordinatorLayout(main())
  const kids = old.children[1].children
  const dragged = { id: 'hrd-card', content: { mod: 'herdr-agents', props: { role: 'card' } }, edge: 'right', align: 'start' }
  kids[2].children[0].floating = [dragged]
  const { home, target } = layoutHome(t, old)
  assert.equal(writeCoordinatorLayout(home), 'exists', 'nothing to change')
  const before = readFileSync(target, 'utf8')
  kids.splice(3, 0, { id: 'hrd-card', type: 'block', hidden: true })
  writeFileSync(target, JSON.stringify(old))
  assert.equal(writeCoordinatorLayout(home), 'updated')
  const got = JSON.parse(readFileSync(target, 'utf8'))
  assert.deepEqual(got.children[1].children[2].children[0].floating, [dragged])
  assert.deepEqual(ids(got), ['tabs', 'hrd-pins', 'work-body', 'hrd-strip', 'hrd-status-row'])
  assert.equal(before.includes('"edge":"right"'), true)
})

test('addCard adds the floating block once, keeps other floating blocks, and does nothing without a main block', () => {
  const layout = main()
  layout.children[1].children[1].children[0].floating = [{ id: 'board', content: { mod: 'board' }, edge: 'left', align: 'center' }]
  assert.equal(addCard(layout), true)
  assert.deepEqual(
    layout.children[1].children[1].children[0].floating.map(f => f.id),
    ['board', 'hrd-card'],
  )
  assert.equal(addCard(layout), false)
  assert.equal(addCard({ id: 'root', children: [] }), false)
})

test('with no main block the old card row goes, no card is added, and the result says so', t => {
  const old = main()
  const kids = old.children[1].children
  kids.splice(3, 0, {
    id: 'hrd-card',
    type: 'block',
    size: { px: 120 },
    hidden: true,
    content: { mod: 'herdr-agents', props: { role: 'card' } },
  })
  old.children[1].children[1].children[0].id = 'elsewhere'
  const { home, target } = layoutHome(t, old)
  assert.equal(writeCoordinatorLayout(home), 'updated-no-card')
  assert.equal(JSON.stringify(JSON.parse(readFileSync(target, 'utf8'))).includes('hrd-card'), false)
})

const versionRow = layout => layout.children[1].children.at(-1)

test("the status block shares a fixed row with the version block, in the status block's place and height", () => {
  assert.deepEqual(versionRow(coordinatorLayout(main())), {
    id: 'hrd-status-row',
    type: 'row',
    size: { px: 28 },
    resizable: false,
    children: [
      { id: 'status', type: 'block', size: { weight: 1 }, content: { mod: 'workspace-status' } },
      {
        id: 'hrd-version',
        type: 'block',
        size: { px: 190 },
        resizable: false,
        content: { mod: 'herdr-agents', props: { role: 'version' } },
      },
    ],
  })
})

test('addVersion is repeatable and leaves alone a status block on another mod, or no status block', () => {
  const layout = coordinatorLayout(main())
  const once = structuredClone(layout)
  assert.equal(addVersion(layout), false)
  assert.deepEqual(layout, once)
  const other = main()
  other.children[1].children[2].content.mod = 'my-status'
  const before = structuredClone(other)
  assert.equal(addVersion(other), false)
  assert.deepEqual(other, before)
  assert.equal(addVersion({ id: 'root', children: [] }), false)
})

test('an existing coordinator layout gets the version block once and keeps its status settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'hrd-layout-'))
  try {
    mkdirSync(join(home, 'layouts'))
    const old = coordinatorLayout(main())
    // As an install from before this change wrote it.
    old.children[1].children[4] = { id: 'status', type: 'block', size: { px: 28 }, min: 20, content: { mod: 'workspace-status' } }
    const target = join(home, 'layouts', 'coordinator.json')
    writeFileSync(target, JSON.stringify(old))
    assert.equal(writeCoordinatorLayout(home), 'updated')
    const row = versionRow(JSON.parse(readFileSync(target, 'utf8')))
    assert.deepEqual(
      row.children.map(c => c.id),
      ['status', 'hrd-version'],
    )
    assert.equal(row.children[0].min, 20)
    assert.deepEqual(row.size, { px: 28 })
    const first = readFileSync(target, 'utf8')
    assert.equal(writeCoordinatorLayout(home), 'exists', 'a second run changes nothing')
    assert.equal(readFileSync(target, 'utf8'), first)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a layout with no main block that only gains the version block reports updated, not a missing card', () => {
  const home = mkdtempSync(join(tmpdir(), 'hrd-layout-'))
  try {
    mkdirSync(join(home, 'layouts'))
    const layout = { id: 'root', children: [{ id: 'status', type: 'block', size: { px: 28 }, content: { mod: 'workspace-status' } }] }
    writeFileSync(join(home, 'layouts', 'coordinator.json'), JSON.stringify(layout))
    assert.equal(writeCoordinatorLayout(home), 'updated')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
