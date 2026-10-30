import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { app, findId, textOf } from './fake-gpui.mjs'

// After the fake is registered: these import `gpui-kit` and `herdr`.
const { makeSheetState, sheetBlock, SheetState } = await import('../mods/herdr-agents/sheet.js')
const { openSheet } = await import('../mods/herdr-agents/sheetctl.js')
const { card } = await import('../mods/herdr-agents/card.js')
const { openPins } = await import('../mods/herdr-agents/pinsctl.js')
const { toggleSheet } = await import('../mods/herdr-agents/strip.js')

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

test('a sheet left by the last run is cleared once per app run, not by a later copy', () => {
  delete globalThis.__hrdStarted?.['hrd.sheetStarted']
  const cx = { focus_handle: () => ({}) }
  app.store['hrd.sheet'] = { session: 's', key: 'D7' }
  makeSheetState(cx)
  assert.equal(app.store['hrd.sheet'], null)
  app.store['hrd.sheet'] = { session: 's', key: 'D7' }
  makeSheetState(cx)
  assert.deepEqual(app.store['hrd.sheet'], { session: 's', key: 'D7' }, 'a layout switch keeps an open sheet')
})

test('opening the pins closes the sheet and hands the keyboard back', () => {
  app.ran = []
  app.store['hrd.sheet'] = { session: 's', key: 'D7', back: 't1', space: null }
  openPins('s', [], 'all')
  assert.equal(app.store['hrd.sheet'], null)
  assert.deepEqual(app.ran.at(-1), ['pane.focus', { terminal: 't1' }])
})

test('opening the sheet closes the pins and the shared pop-up', () => {
  app.closed = []
  app.store['hrd.pins'] = 'p1'
  app.store['hrd.popup'] = 'p2'
  toggleSheet(board())
  assert.deepEqual(app.closed.sort(), ['p1', 'p2'])
  assert.ok(app.store['hrd.sheet'])
})

// A need whose "Why" comes from its RESULT.md, a sheet whose reads the test ends by hand, and a draw on an open of the sheet.
const FILE = '/r/RESULT.md'
const fileSheet = () => {
  const b = board()
  const need = b.needs.find(n => n.key === 'D7')
  need.text = ''
  need.source = { file: FILE }
  const s = ctl()
  const c = { notifies: 0, focuses: 0, tasks: [], notify: () => c.notifies++, sleep: async () => {}, spawn: f => c.tasks.push(f) }
  s.h = { focus: () => c.focuses++ }
  // Taking the keyboard also redraws: what is left is the redraws for the file.
  c.redraws = () => c.notifies - c.focuses
  c.finish = () => Promise.all(c.tasks.splice(0).map(f => f(c)))
  const open = (seq = 1, key = 'D7') => {
    globalThis.window = { viewport_size: () => TALL }
    app.store['hrd.sheet'] = { session: b.session, key, seq }
    return textOf(sheetBlock([b], s, c)).join(' ')
  }
  return { b, s, c, open }
}

test('the Why box says Reading… while the read runs, then the text', async () => {
  const { c, open } = fileSheet()
  app.files = { [FILE]: 'first text' }
  assert.match(open(), /Reading…/)
  await c.finish()
  assert.equal(c.redraws(), 1)
  const after = open()
  assert.match(after, /first text/)
  assert.doesNotMatch(after, /Reading…/)
})

test('a file that cannot be read ends Reading…', async () => {
  const { c, open } = fileSheet()
  app.files = { [FILE]: new Error('no access') }
  open()
  await c.finish()
  assert.equal(c.redraws(), 1)
  assert.match(open(), /No text to show/)
})

test('a rewritten RESULT.md shows the next time the sheet opens the item; redraws of one open read nothing', async () => {
  const { c, open } = fileSheet()
  app.files = { [FILE]: 'first text' }
  open()
  await c.finish()
  app.files = { [FILE]: 'second text' }
  open()
  await c.finish()
  assert.match(open(), /first text/, 'same open: no read')
  assert.equal(c.redraws(), 1)
  assert.match(open(2), /first text/, 'the last text stays up during the re-read')
  await c.finish()
  assert.equal(c.redraws(), 2)
  assert.match(open(2), /second text/)
})

test('a re-read that finds the same text does not redraw', async () => {
  const { c, open } = fileSheet()
  app.files = { [FILE]: 'same' }
  open(1)
  await c.finish()
  open(2)
  await c.finish()
  assert.equal(c.redraws(), 1)
})

test('paging away and back re-reads, also through an item with no file', async () => {
  const { b, c, open } = fileSheet()
  const other = b.needs.find(n => n.key !== 'D7' && n.isOpen)
  app.files = { [FILE]: 'first text' }
  open()
  await c.finish()
  app.files = { [FILE]: 'second text' }
  open(1, other.key)
  await c.finish()
  open()
  await c.finish()
  assert.match(open(), /second text/)
})

test('closed and opened with the same seq it reads again; an older read ending late does not win', async () => {
  const { b, s, c, open } = fileSheet()
  app.files = { [FILE]: 'one' }
  open()
  const slow = c.tasks.splice(0)
  app.store['hrd.sheet'] = null
  sheetBlock([b], s, c)
  app.files = { [FILE]: 'two' }
  open()
  await c.finish()
  app.files = { [FILE]: 'old' }
  await Promise.all(slow.map(f => f(c)))
  assert.match(open(), /two/)
})
