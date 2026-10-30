import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const read = rel => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
const schema = read('../../docs/board-schema.json')

// The subset of JSON Schema the board schema uses.
function check(value, node, path, errors) {
  if (node.$ref)
    node = node.$ref
      .split('/')
      .slice(1)
      .reduce((n, k) => n[k], schema)
  if ('const' in node && value !== node.const) errors.push(`${path}: not ${node.const}`)
  if (node.enum && !node.enum.includes(value)) errors.push(`${path}: ${value} not in ${node.enum}`)
  if (node.type) {
    const types = [].concat(node.type)
    const is = t =>
      t === 'integer'
        ? Number.isInteger(value)
        : t === 'null'
          ? value === null
          : t === 'array'
            ? Array.isArray(value)
            : t === 'object'
              ? value !== null && typeof value === 'object' && !Array.isArray(value)
              : typeof value === t
    if (!types.some(is)) return void errors.push(`${path}: expected ${types}`)
  }
  if (Array.isArray(value)) {
    if (node.minItems && value.length < node.minItems) errors.push(`${path}: too short`)
    if (node.maxItems && value.length > node.maxItems) errors.push(`${path}: too long`)
    if (node.items) value.forEach((v, i) => check(v, node.items, `${path}[${i}]`, errors))
  } else if (value && typeof value === 'object') {
    for (const k of node.required ?? []) if (!(k in value)) errors.push(`${path}: missing ${k}`)
    for (const [k, sub] of Object.entries(node.properties ?? {})) if (k in value) check(value[k], sub, `${path}.${k}`, errors)
  }
}

test('every fixture validates against docs/board-schema.json', () => {
  const files = readdirSync(new URL('../fixtures/', import.meta.url)).filter(f => f.endsWith('.json'))
  assert.ok(files.includes('full.json'))
  for (const f of files) {
    const errors = []
    check(read(`../fixtures/${f}`), schema, f, errors)
    assert.deepEqual(errors, [])
  }
})

test('the validator catches a bad board', () => {
  const board = read('../fixtures/full.json')
  const errors = []
  check({ ...board, version: 2, tasks: [{ stages: ['done'] }], needs: [{ kind: 'nope' }] }, schema, 'bad', errors)
  assert.equal(errors.length, 3)
})

test('full.json has what the plan lists: a blocked worker, 2 asks, 2 dos, 3 knows (one untitled), 6 tasks, the coordinator terminal', () => {
  const b = read('../fixtures/full.json')
  const kinds = k => b.needs.filter(n => n.kind === k)
  assert.equal(b.workers.filter(w => w.state === 'blocked').length, 1)
  assert.deepEqual([kinds('ask').length, kinds('do').length, kinds('know').length], [2, 2, 3])
  assert.equal(kinds('know').filter(n => !n.title).length, 1)
  assert.equal(b.tasks.length, 6)
  assert.equal(b.coordinator.terminal, 't4')
})

test('every icon the strip draws exists in the mod folder', () => {
  const strip = readFileSync(new URL('../mods/herdr-agents/strip.js', import.meta.url), 'utf8')
  const names = [...strip.matchAll(/icon\('([a-z-]+)'\)/g)].map(m => m[1])
  assert.ok(names.length >= 1)
  const have = readdirSync(new URL('../mods/herdr-agents/icons/', import.meta.url))
  for (const n of ['working', 'waiting', 'blocked', 'decide', 'do', ...names]) assert.ok(have.includes(`${n}.svg`), n)
})
