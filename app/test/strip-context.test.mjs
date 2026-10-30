import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findId, textOf } from './fake-gpui.mjs'

const { contextLine } = await import('../mods/herdr-agents/model.js')
const { strip } = await import('../mods/herdr-agents/strip.js')
const { strip: look } = await import('../mods/herdr-agents/tokens.js')

const board = context => ({ session: 's', summary: { context } })
const draw = context => strip(board(context), { boards: [], terminals: [] })

test("the text is the band's, rounded to k", () => {
  assert.deepEqual(contextLine(board({ tokens: 145_400, limit: 250_000 })), { text: 'ctx 145k / 250k', level: null })
})

test('warning starts at 80% and error, with its note, at 95%', () => {
  const at = tokens => contextLine(board({ tokens, limit: 100_000 }))
  assert.equal(at(79_999).level, null)
  assert.deepEqual(at(80_000), { text: 'ctx 80k / 100k', level: 'warning' })
  assert.equal(at(94_999).level, 'warning')
  assert.deepEqual(at(95_000), { text: 'ctx 95k / 100k · resets soon', level: 'error' })
})

test('no line without usable data', () => {
  for (const b of [
    null,
    {},
    { summary: {} },
    board(null),
    board({ tokens: 5, limit: 0 }),
    board({ tokens: 5, limit: -1 }),
    board({ limit: 5 }),
    board({ tokens: '5', limit: 9 }),
  ]) {
    assert.equal(contextLine(b), null)
  }
})

test('the strip draws it in the right group, left of the counts, in the colour of its level', () => {
  const shade = tokens => findId(draw({ tokens, limit: 100_000 }), 'strip-context').node.calls.text_color[0]
  assert.equal(shade(10_000), look.muted)
  assert.equal(shade(80_000), look.ctxWarning)
  assert.equal(shade(95_000), look.ctxError)
  const text = textOf(draw({ tokens: 10_000, limit: 100_000 }))
  assert.ok(text.indexOf('ctx 10k / 100k') >= 0)
  assert.ok(text.indexOf('ctx 10k / 100k') < text.indexOf('board ▴'))
  assert.equal(findId(draw({ tokens: 10_000, limit: 100_000 }), 'count-working') !== null, true)
  const right = draw({ tokens: 10_000, limit: 100_000 }).node.kids.at(-1)
  assert.equal(right.node.kids[0].node.calls.id[0], 'strip-context')
})

test('the strip draws nothing for it without data, and no empty child', () => {
  for (const context of [null, undefined, { tokens: 5, limit: 0 }]) {
    const el = draw(context)
    assert.equal(findId(el, 'strip-context'), null)
    assert.equal(el.node.kids.at(-1).node.kids.includes(null), false)
  }
})
