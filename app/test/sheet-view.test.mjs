import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { app, findId, textOf } from './fake-gpui.mjs'

// After the fake is registered: these import `gpui-kit` and `herdr`.
const { sheetBlock, SheetState } = await import('../mods/herdr-agents/sheet.js')
const { openSheet } = await import('../mods/herdr-agents/sheetctl.js')
const { card } = await import('../mods/herdr-agents/card.js')

const board = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url)))
const cx = { notify() {}, spawn() {} }
const ctl = () => new SheetState({ send() {}, notify() {}, handle: { focus() {} } })
const draw = (boards, key, viewport) => {
  globalThis.window = { viewport_size: () => viewport }
  app.store['hrd.sheet'] = { session: boards[0]?.session ?? 'gone', key, seq: 1 }
  return sheetBlock(boards, ctl(), cx)
}
const SMALL = { width: 760, height: 460 }
const SHORT = { width: 1280, height: 500 }
const TALL = { width: 1280, height: 821 }
const isInside = (root, id, inner) => Boolean(findId(findId(root, id), inner))

beforeEach(() => {
  app.store = {}
  app.settings = { zoom: 1 }
})

test('the sheet draws once no item is open, the normal end of answering the last one', () => {
  const b = board()
  for (const n of b.needs) n.isOpen = false
  for (const viewport of [SMALL, TALL]) {
    const text = textOf(draw([b], 'D7', viewport)).join(' ')
    assert.match(text, /closed/)
    assert.doesNotMatch(text, /sent|sending/, 'nothing was sent: it says only what happened')
    assert.doesNotMatch(text, / of \d| open/, 'no pager with nothing to page to')
  }
})

test('the sheet draws without a board: a board rewritten with another session', () => {
  for (const viewport of [SMALL, TALL]) {
    const el = draw([], 'D7', viewport)
    assert.match(textOf(el).join(' '), /This board has ended/)
    assert.equal(findId(el, 'sheet-ask'), null)
  }
})

test('a narrow short window: every option and Ask principal can be reached, and nothing overflows', () => {
  const el = draw([board()], 'D7', SMALL)
  assert.ok(findId(el, 'sheet-scroll').node.calls.overflow_y_scrollbar, 'the middle scrolls')
  for (const id of ['sheet-opt-0', 'sheet-opt-1', 'sheet-why']) assert.ok(isInside(el, 'sheet-scroll', id), id)
  assert.ok(findId(el, 'sheet-ask'), 'Ask principal is drawn')
  assert.ok(!isInside(el, 'sheet-scroll', 'sheet-ask'), 'and stays in view, outside the scrolling part')
  assert.equal(findId(el, 'sheet-options').node.calls.flex_1, undefined, 'the list takes its own height, so nothing overlaps')
  assert.match(textOf(el).join(' '), /scroll for more/)
})

test('a wide short window says options are scrolled out; a tall one does not', () => {
  const short = draw([board()], 'D7', SHORT)
  assert.match(textOf(short).join(' '), /scroll for more/)
  assert.ok(findId(short, 'sheet-options').node.calls.overflow_y_scrollbar)
  assert.ok(isInside(short, 'sheet-options', 'sheet-opt-1'))
  assert.doesNotMatch(textOf(draw([board()], 'D7', TALL)).join(' '), /scroll for more/)
})

test('opening writes shared state once, so mods redraw once', () => {
  let writes = 0
  const store = new Proxy(
    {},
    {
      set(t, k, v) {
        writes++
        t[k] = v
        return true
      },
    },
  )
  app.store = store
  openSheet({ session: 's' }, 'D7')
  assert.equal(writes, 1)
  assert.equal(store['hrd.sheet'].key, 'D7')
  assert.ok(store['hrd.sheet'].seq > 0, 'a new open is told from the last')
})

test('the sheet takes its size from the zoom the app draws it at', () => {
  const b = board()
  app.settings = { zoom: 1.2 }
  const el = draw([b], 'D7', TALL)
  assert.deepEqual(el.node.calls.w, [726])
  assert.ok(findId(el, 'sheet-scroll'), 'too narrow at this zoom for two columns')
  app.settings = { zoom: 1 }
  assert.deepEqual(draw([b], 'D7', TALL).node.calls.w, [940])
})

test('a sheet whose board has ended shows no empty Why or Options', () => {
  for (const viewport of [SMALL, TALL]) {
    const text = textOf(draw([], 'D7', viewport)).join(' ')
    assert.match(text, /This board has ended/)
    assert.doesNotMatch(text, /Options|No text to show|Why it asks/)
  }
})

test('a sheet too narrow for the meta leaves it out, so esc stays inside', () => {
  app.settings = { zoom: 1.2 }
  assert.doesNotMatch(
    textOf(findId(draw([board()], 'D7', SMALL), 'sheet-body'))
      .slice(0, 4)
      .join(' '),
    /#601/,
  )
  app.settings = { zoom: 1 }
  assert.match(textOf(draw([board()], 'D7', TALL)).join(' '), /#601 · w-api/)
})

test('the card takes its size from the zoom the app draws it at', () => {
  const b = board()
  globalThis.window = { viewport_size: () => ({ width: 1000, height: 800 }) }
  app.store['hrd.open'] = { session: b.session, key: 'D7', seq: 1 }
  const width = zoom => {
    app.settings = { zoom }
    return findId(card([b], ctl(), cx), 'card').node.calls.w[0]
  }
  assert.equal(width(1), 560)
  assert.equal(width(1.2), 493)
})
