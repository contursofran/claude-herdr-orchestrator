import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { coordinatorLayout, writeCoordinatorLayout } from '../layout.mjs'

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
  assert.deepEqual(ids(layout), ['tabs', 'hrd-pins', 'work-body', 'hrd-strip', 'status'])
  const [, pins, , strip] = layout.children[1].children
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
  layout.children[1].children = layout.children[1].children.filter(c => !c.id.startsWith('hrd-'))
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
    assert.deepEqual(ids(JSON.parse(readFileSync(target, 'utf8'))), ['tabs', 'hrd-pins', 'work-body', 'hrd-strip', 'status'])
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
