import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { app, findId, textOf } from './fake-gpui.mjs'

// After the fake is registered: these import `gpui-kit` and `herdr`.
const { COPIED_MS, CopyState, commandsIn, copyKey, copyTargets, pinMarkdown } = await import('../mods/herdr-agents/copystate.js')
const { card } = await import('../mods/herdr-agents/card.js')
const { CardState } = await import('../mods/herdr-agents/cardstate.js')
const { SheetState, sheetBlock } = await import('../mods/herdr-agents/sheet.js')
const { pinsView } = await import('../mods/herdr-agents/pinbar.js')
const { cardHint, cardKeyAction, panelHeight } = await import('../mods/herdr-agents/model.js')
const { sheetHint, sheetKeyAction, sheetMore } = await import('../mods/herdr-agents/sheetmodel.js')

/** A cx that records copies and redraws, and holds the timer until `fire()`. */
function fakeCx() {
  const cx = {
    copied: [],
    notified: 0,
    sleeps: [],
    tasks: [],
    write_to_clipboard: t => cx.copied.push(t),
    notify: () => cx.notified++,
    sleep: ms => (cx.sleeps.push(ms), new Promise(r => cx.tasks.push(r))),
    spawn: f => f(cx),
    fire: async () => {
      cx.tasks.splice(0).forEach(r => r())
      await new Promise(r => setImmediate(r))
    },
  }
  return cx
}

const CMD = `ssh host "grep '^KEY=' some/.env"`
const board = text => ({
  session: 's',
  needs: [{ key: 'T1', kind: 'do', text, title: 'Run it', isOpen: true, at: 1 }],
  workers: [],
})
const openOn = () => {
  app.store['hrd.open'] = { session: 's', key: 'T1', back: 't1', space: 'a', seq: 1 }
  app.store['hrd.pick'] = { session: 's', key: 'T1' }
  app.focused = { terminal: 't1', space: 'a' }
}
const makeCard = () => new CardState({ send() {}, notify() {}, handle: { focus() {} } })
const press = (root, id, cx) => findId(root, id).node.calls.on_mouse_down[1]({ button: 'left' }, cx)
const keyOn = (root, id, keystroke, cx) => findId(root, id).node.calls.on_key_down[0]({ keystroke }, cx)
const labelOf = (root, id) => findId(root, id).node.kids[0]

beforeEach(() => {
  app.store = {}
  app.ran = []
  app.settings = { zoom: 1 }
})

test('commandsIn: each backticked command exactly, once; no guessing from prose', () => {
  assert.deepEqual(commandsIn(`Run \`${CMD}\` now`), [CMD])
  assert.deepEqual(commandsIn('`a b` then `c` and `a b`'), ['a b', 'c'])
  assert.deepEqual(commandsIn('run npm ci now'), [])
  assert.deepEqual(commandsIn("it's a lone ` backtick"), [])
  assert.deepEqual(commandsIn('a ` on one line\nand ` on the next'), [], 'a span stays on one line')
  assert.deepEqual(commandsIn('`` a`b ``'), ['a`b'])
  assert.deepEqual(commandsIn('```sh\nnpm ci\nnpm test\n```'), ['npm ci\nnpm test'])
  assert.deepEqual(commandsIn('`  `'), [], 'nothing but spaces')
  assert.deepEqual(commandsIn(null), [])
})

test('copyTargets: the commands, else the whole text, else nothing', () => {
  assert.deepEqual(
    copyTargets('`a` `b`').map(t => t.value),
    ['a', 'b'],
  )
  assert.deepEqual(copyTargets('plain text'), [{ value: 'plain text', command: false }])
  assert.deepEqual(copyTargets('  '), [])
})

test('pinMarkdown: only backticked parts are code; prose draws as written', () => {
  assert.equal(pinMarkdown('rm *.log'), 'rm \\*\\.log')
  assert.equal(pinMarkdown('# a\nb'), '\\# a  \nb')
  assert.equal(pinMarkdown('run `a *b*` x_y'), 'run `a *b*` x\\_y')
  assert.equal(pinMarkdown('lone ` tick'), 'lone \\` tick')
})

test('copyKey: only c and cmd-c', () => {
  assert.equal(copyKey('c'), 'c')
  assert.equal(copyKey('cmd-c'), 'cmd-c')
  for (const k of ['ctrl-c', 'shift-c', 'ctrl-cmd-1', 'cmd-1', 'escape', '1']) assert.equal(copyKey(k), null, k)
})

test('cardKeyAction: copy keys copy and do not close; 1 and Esc still work; no text closes as before', () => {
  assert.deepEqual(cardKeyAction('do', 'c', { copy: 'c' }), { type: 'copy', chord: 'c' })
  assert.deepEqual(cardKeyAction('do', 'cmd-c', { copy: 'cmd-c' }), { type: 'copy', chord: 'cmd-c' })
  assert.deepEqual(cardKeyAction('do', '1', { copy: null }), { type: 'done' })
  assert.deepEqual(cardKeyAction('do', 'escape', { copy: null }), { type: 'close' })
  assert.deepEqual(cardKeyAction('do', 'c', { copy: 'c', held: true }), { type: 'ignore' })
  assert.deepEqual(cardKeyAction('resolved', 'c'), { type: 'close' })
  assert.deepEqual(sheetKeyAction('c', { copy: 'c' }), { type: 'copy', chord: 'c' })
  assert.deepEqual(sheetKeyAction('c'), { type: 'ignore' })
})

test('the hints say c copies, only where it does', () => {
  assert.match(cardHint('do', { copy: true }), /^1 done · c copies · esc or any other key closes/)
  assert.match(cardHint('ask', { options: 2, copy: true }), /^1-2 answers · c copies · /)
  assert.match(cardHint('ask', { copy: true }), /^c copies · /)
  assert.doesNotMatch(cardHint('do'), /copies/)
  assert.match(sheetHint({ copy: true }), /c copies · esc closes/)
  assert.doesNotMatch(sheetHint(), /copies/)
})

test('CopyState: the label lasts one timer of about 1.5 s, and a later copy keeps it', async () => {
  const cx = fakeCx()
  const s = new CopyState()
  s.copy(cx, 'a', 'one')
  assert.deepEqual(cx.copied, ['one'])
  assert.equal(s.copied, 'a')
  assert.deepEqual(cx.sleeps, [COPIED_MS])
  assert.equal(COPIED_MS, 1500)
  s.copy(cx, 'b', 'two')
  await cx.fire()
  assert.equal(s.copied, null, 'the last timer clears it')
  assert.equal(cx.sleeps.length, 2, 'no loop: one timer per copy')
  const held = fakeCx()
  const t = new CopyState()
  t.copy(held, 'a', 'one')
  const first = held.tasks.splice(0)
  t.copy(held, 'b', 'two')
  first.forEach(r => r())
  await new Promise(r => setImmediate(r))
  assert.equal(t.copied, 'b', "the first timer does not clear the second copy's label")
})

test('CopyState.key: cmd-c leaves a possible selection to the text view; c always copies the first', () => {
  const s = new CopyState()
  const cx = fakeCx()
  s.mouseDown({ position: { x: 10, y: 10 } })
  s.mouseMove({ position: { x: 11, y: 11 } })
  s.key(cx, 'cmd-c', 'p', '`a`')
  assert.deepEqual(cx.copied, ['a'], 'a shaky click is no selection')
  s.mouseMove({ position: { x: 40, y: 10 } })
  s.mouseUp()
  s.key(cx, 'cmd-c', 'p', '`a`')
  assert.deepEqual(cx.copied, ['a'], 'after a drag, cmd-c writes nothing itself')
  s.key(cx, 'c', 'p', '`a`')
  assert.deepEqual(cx.copied, ['a', 'a'])
  s.mouseDown({ position: { x: 1, y: 1 }, click_count: 2 })
  s.mouseUp()
  s.key(cx, 'cmd-c', 'p', '`a`')
  assert.equal(cx.copied.length, 2, 'a double click selects a word')
  s.mouseDown({ position: { x: 1, y: 1 }, click_count: 1 })
  s.mouseUp()
  s.mouseMove({ position: { x: 90, y: 90 } })
  s.key(cx, 'cmd-c', 'p', '`a`')
  assert.equal(cx.copied.length, 3, 'a click clears it, and moving after the release is no drag')
  s.key(cx, 'c', 'p', '  ')
  assert.equal(cx.copied.length, 3, 'empty text: nothing to copy')
})

test('card: a Copy per command with the exact text; selectable text; the label changes; nothing closes', async () => {
  openOn()
  const ctl = makeCard()
  const draw = () => card([board(`Run \`${CMD}\` then \`npm ci\``)], ctl, { ...fakeCx(), spawn() {} })
  const root = draw()
  const md = findId(root, 'card-copy-T1-md').node
  assert.deepEqual(md.calls.selectable, [])
  const cx = fakeCx()
  assert.equal(labelOf(root, 'card-copy-T1-1'), 'Copy')
  press(root, 'card-copy-T1-1', cx)
  assert.deepEqual(cx.copied, ['npm ci'])
  assert.equal(labelOf(draw(), 'card-copy-T1-1'), 'Copied')
  assert.equal(labelOf(draw(), 'card-copy-T1-0'), 'Copy')
  await cx.fire()
  assert.equal(labelOf(draw(), 'card-copy-T1-1'), 'Copy')
  press(root, 'card-copy-T1-0', cx)
  assert.deepEqual(cx.copied, ['npm ci', CMD])
  assert.ok(app.store['hrd.open'], 'a Copy click does not close the card')
  assert.deepEqual(app.ran, [], 'and the keyboard is not handed back')
})

test('card: c and cmd-c copy the first command without closing or handing back; x still closes', () => {
  openOn()
  const ctl = makeCard()
  const root = card([board(`Run \`${CMD}\` then \`npm ci\``)], ctl, { ...fakeCx(), spawn() {} })
  const cx = fakeCx()
  keyOn(root, 'card-body', 'c', cx)
  keyOn(root, 'card-body', 'cmd-c', cx)
  assert.deepEqual(cx.copied, [CMD, CMD])
  assert.ok(app.store['hrd.open'])
  assert.deepEqual(app.ran, [])
  keyOn(root, 'card-body', 'x', cx)
  assert.equal(app.store['hrd.open'], null)
  assert.deepEqual(app.ran, [['pane.focus', { terminal: 't1' }]], 'a closing key still hands the keyboard back')
})

test('card: a pin with no backticks has one Copy for its whole text, and c copies it', () => {
  openOn()
  const text = 'Rotate the key.\nThen tell me.'
  const root = card([board(text)], makeCard(), { ...fakeCx(), spawn() {} })
  assert.equal(findId(root, 'card-copy-T1-1'), null)
  const cx = fakeCx()
  press(root, 'card-copy-T1-0', cx)
  keyOn(root, 'card-body', 'c', cx)
  assert.deepEqual(cx.copied, [text, text])
})

test('sheet: the pin text gets the same part; a RESULT.md or excerpt stays plain', () => {
  const b = board('Run `npm ci`')
  app.store['hrd.sheet'] = { session: 's', key: 'T1', seq: 1 }
  const ctl = new SheetState({ send() {}, notify() {}, handle: { focus() {} } })
  const root = sheetBlock([b], ctl, { ...fakeCx(), spawn() {} })
  const cx = fakeCx()
  press(root, 'sheet-copy-T1-0', cx)
  keyOn(root, 'sheet-body', 'c', cx)
  assert.deepEqual(cx.copied, ['npm ci', 'npm ci'])
  assert.ok(app.store['hrd.sheet'], 'still open')
  b.needs[0].source = { excerpt: 'Why: `npm ci`' }
  const plain = sheetBlock([b], ctl, { ...fakeCx(), spawn() {} })
  assert.equal(findId(plain, 'sheet-copy-T1-0'), null)
  keyOn(plain, 'sheet-body', 'c', cx)
  assert.equal(cx.copied.length, 2)
})

test('pin panel: Copy and c copy; the list of all pins has no copy key', () => {
  const list = [{ id: 's:K1', key: 'K1', title: 't', text: 'Run `npm ci`', at: 1 }]
  app.props = { view: 'panel', session: 's', id: 's:K1', list, width: 900, height: 200, overlay: 'o1' }
  const ctl = { h: {}, copy: new CopyState(), leaving: false }
  const root = pinsView(new Set(), ctl)
  const cx = fakeCx()
  press(root, 'pin-copy-0', cx)
  keyOn(root, 'pins-overlay', 'c', cx)
  assert.deepEqual(cx.copied, ['npm ci', 'npm ci'])
  assert.deepEqual(app.closed.filter(Boolean), [], 'nothing closes')
  app.props = { ...app.props, view: 'all' }
  keyOn(pinsView(new Set(), ctl), 'pins-overlay', 'c', cx)
  assert.equal(cx.copied.length, 2)
})

test('pin_for_owner tells the agent to put a command in backticks, with no new field', () => {
  const src = readFileSync(new URL('../../hooks/tools.ts', import.meta.url), 'utf8')
  assert.match(src, /Put a command to run in backticks/)
})

const mouse = (root, id, name, e) => findId(root, id).node.calls[name].at(-1)(e)
const ARGS = { id: 's:K1', list: [], width: 900, height: 200, overlay: 'o1', session: 's' }

test('panelHeight leaves room for the Copy rows, up to three', () => {
  const none = panelHeight('', 900)
  assert.equal(panelHeight('Rotate the key', 900), none + 36, 'the whole-text row')
  assert.equal(panelHeight('Run `a`', 900), none + 36)
  assert.equal(panelHeight('Run `a` `b` `c`', 900), none + 108)
  assert.equal(panelHeight('Run `a` `b` `c` `d` `e`', 900), none + 108, 'more rows scroll')
})

test('sheetMore counts the Copy rows of a pin text', () => {
  const view = { face: 'ask', options: [], pinText: 'x', why: '' }
  const size = { narrow: false, w: 800, h: 190 }
  assert.equal(sheetMore({ ...view, pinText: '' }, size), false)
  assert.equal(sheetMore({ ...view, pinText: 'Run `a` `b`' }, size), true)
})

test('pinMarkdown: leading spaces or a tab never make a code block, and no backslash shows', () => {
  assert.equal(pinMarkdown('a\n\n    b-c'), 'a  \n  \n&#32;&#32;&#32;&#32;b\\-c')
  assert.equal(pinMarkdown('\tb'), '&#9;b')
  assert.equal(pinMarkdown('x `a` \n  y'), 'x `a`   \n&#32;&#32;y')
  assert.equal(pinMarkdown('run `a`\n   b'), 'run `a`  \n&#32;&#32;&#32;b')
})

test('commandsIn: a CRLF fence copies the command without the carriage return', () => {
  assert.deepEqual(commandsIn('```sh\r\nls\r\npwd\r\n```'), ['ls\npwd'])
})

test('card: a drag in the text leaves cmd-c to the text view; a press on Copy ends that; c still copies', () => {
  openOn()
  const ctl = makeCard()
  const root = card([board(`Run \`${CMD}\``)], ctl, { ...fakeCx(), spawn() {} })
  const id = 'card-copy-T1-text'
  const cx = fakeCx()
  mouse(root, id, 'on_mouse_down', { position: { x: 0, y: 0 }, click_count: 1 })
  mouse(root, id, 'on_mouse_move', { position: { x: 20, y: 0 } })
  mouse(root, id, 'on_mouse_up', {})
  keyOn(root, 'card-body', 'cmd-c', cx)
  assert.deepEqual(cx.copied, [], 'left to the text view')
  keyOn(root, 'card-body', 'c', cx)
  assert.deepEqual(cx.copied, [CMD])
  press(root, 'card-copy-T1-0', cx)
  keyOn(root, 'card-body', 'cmd-c', cx)
  assert.deepEqual(cx.copied, [CMD, CMD, CMD], 'the selection is gone after a press on Copy')
  mouse(root, id, 'on_mouse_down', { position: { x: 0, y: 0 }, click_count: 1 })
  mouse(root, id, 'on_mouse_up', {})
  mouse(root, id, 'on_mouse_move', { position: { x: 90, y: 0 } })
  keyOn(root, 'card-body', 'cmd-c', cx)
  assert.equal(cx.copied.length, 4, 'a move after the release is not a drag')
})

test('card and sheet: a new pin forgets the old selection', () => {
  openOn()
  const ctl = makeCard()
  ctl.copy.selected = true
  card([board('Run `a`')], ctl, { ...fakeCx(), spawn() {} })
  assert.equal(ctl.copy.selected, false)
  app.store['hrd.sheet'] = { session: 's', key: 'T1', seq: 1 }
  const sheet = new SheetState({ send() {}, notify() {}, handle: { focus() {} } })
  sheet.copy.selected = true
  sheetBlock([board('Run `a`')], sheet, { ...fakeCx(), spawn() {} })
  assert.equal(sheet.copy.selected, false)
})

test('card and sheet footers say c copies when there is something to copy, and not otherwise', () => {
  openOn()
  const text = r => textOf(r).join(' ')
  assert.match(text(card([board('Run `a`')], makeCard(), { ...fakeCx(), spawn() {} })), /c copies/)
  assert.doesNotMatch(text(card([board('')], makeCard(), { ...fakeCx(), spawn() {} })), /c copies/)
  app.store['hrd.sheet'] = { session: 's', key: 'T1', seq: 1 }
  const sheet = () => new SheetState({ send() {}, notify() {}, handle: { focus() {} } })
  assert.match(text(sheetBlock([board('Run `a`')], sheet(), { ...fakeCx(), spawn() {} })), /c copies/)
  assert.doesNotMatch(text(sheetBlock([board('')], sheet(), { ...fakeCx(), spawn() {} })), /c copies/)
})

test('card: a pin with no text still closes on c', () => {
  openOn()
  const root = card([board('')], makeCard(), { ...fakeCx(), spawn() {} })
  const cx = fakeCx()
  keyOn(root, 'card-body', 'c', cx)
  assert.deepEqual(cx.copied, [])
  assert.equal(app.store['hrd.open'], null)
})

test('pin panel: the hint says c copies; a held c copies nothing and closes nothing', () => {
  const list = [{ id: 's:K1', key: 'K1', title: 't', text: 'Run `npm ci`', at: 1 }]
  app.props = { ...ARGS, view: 'panel', list }
  const ctl = { h: {}, copy: new CopyState(), leaving: false }
  const root = pinsView(new Set(), ctl)
  assert.match(textOf(findId(root, 'pin-context')).join(' '), /c copies/)
  const cx = fakeCx()
  findId(root, 'pins-overlay').node.calls.on_key_down[0]({ keystroke: 'c', is_held: true }, cx)
  assert.deepEqual(cx.copied, [])
  assert.deepEqual(app.closed.filter(Boolean), [])
  app.props = { ...ARGS, view: 'panel', list: [{ ...list[0], text: '' }] }
  assert.doesNotMatch(textOf(findId(pinsView(new Set(), ctl), 'pin-context')).join(' '), /c copies/)
})
