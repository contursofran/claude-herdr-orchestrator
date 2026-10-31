import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { app } from './fake-gpui.mjs'

const tokens = await import('../mods/herdr-agents/tokens.js')
const { pinbar } = await import('../mods/herdr-agents/pinbar.js')
const { PinCtl } = await import('../mods/herdr-agents/pinctl.js')
const { palettes, color, strip: stripLook, card, mode } = tokens
const { strip } = await import('../mods/herdr-agents/strip.js')
const { card: drawCard } = await import('../mods/herdr-agents/card.js')
const { CardState } = await import('../mods/herdr-agents/cardstate.js')
const { popupView } = await import('../mods/herdr-agents/popup.js')
const { pinsView } = await import('../mods/herdr-agents/pinbar.js')
const { sheetBlock, SheetState } = await import('../mods/herdr-agents/sheet.js')

const cx = { notify() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {}, every() {} } }

afterEach(() => {
  app.theme = null
  app.props = null
  app.settings = { zoom: 1 }
  globalThis.window = undefined
})

// Every key path of a palette, with its value type; and every leaf value.
const shape = (o, path = '') =>
  Object.entries(o).flatMap(([k, v]) => (v !== null && typeof v === 'object' ? shape(v, `${path}${k}.`) : [`${path}${k}:${typeof v}`]))
const leaves = (o, path = '') =>
  Object.entries(o).flatMap(([k, v]) => (v !== null && typeof v === 'object' ? leaves(v, `${path}${k}.`) : [[`${path}${k}`, v]]))

test('both palettes have the same keys, and non-colour values match', () => {
  assert.deepEqual(shape(palettes.light), shape(palettes.dark))
  const dark = Object.fromEntries(leaves(palettes.dark))
  for (const [k, v] of leaves(palettes.light)) {
    if (typeof v === 'number') assert.equal(v, dark[k], k)
    else assert.match(v, /^#[0-9A-F]{6}$/, k)
  }
})

const LIGHT = { chrome: '#f1f1ee' }
const DARK = { chrome: '#101114' }

test('mode: read from the chrome the theme draws', () => {
  assert.equal(mode(), 'dark')
  assert.equal(color.text, '#EDEDED')
  app.theme = LIGHT
  assert.equal(mode(), 'light')
  app.theme = DARK
  assert.equal(mode(), 'dark')
  app.theme = { chrome: '#FFFFFFFF' }
  assert.equal(mode(), 'light')
  for (const chrome of [undefined, '', 'red', '#fff']) {
    app.theme = { chrome }
    assert.equal(mode(), 'dark', String(chrome))
  }
})

test('mode: ignores the fields it must not trust', () => {
  // The real theme() has no appearance; settings().dark says the system's, not a fixed theme's.
  app.theme = { ...DARK, appearance: 'light', is_dark: false }
  app.settings = { zoom: 1, dark: false }
  assert.equal(mode(), 'dark')
  app.theme = { ...LIGHT, appearance: 'dark', is_dark: true }
  app.settings = { zoom: 1, dark: true }
  assert.equal(mode(), 'light')
})

test('tokens follow a theme change live, nested groups too', () => {
  const tabOn = stripLook.tabOn
  assert.equal(color.text, '#EDEDED')
  assert.equal(tabOn.bg, '#1A1A1A')
  app.theme = LIGHT
  assert.equal(color.text, '#1A1A1A')
  assert.equal(tabOn.bg, '#FFFFFF')
  assert.equal(stripLook.flash.bg, '#1A1A1A')
  assert.equal(card.bg, '#FFFFFF')
  app.theme = DARK
  assert.equal(tabOn.bg, '#1A1A1A')
})

const full = () => JSON.parse(readFileSync(new URL('../fixtures/full.json', import.meta.url), 'utf8'))
const CONSUMERS = ['strip', 'pinbar', 'card', 'popup', 'sheet', 'copy']

// Every surface, drawn with the full fixture and a decision open.
const SURFACES = {
  pinbar: b => pinbar(b, new PinCtl().ui(b, cx)),
  strip: b => strip(b, { boards: [b], terminals: [] }),
  card: b => {
    app.store['hrd.open'] = { session: b.session, key: 'D7', seq: 1 }
    return drawCard([b], new CardState({ send() {}, notify() {}, handle: { focus() {} } }), cx)
  },
  popup: b => popupView(b, { h: {}, leaving: false }),
  pins: () => {
    const list = [{ key: 'K2', kind: 'know', isOpen: true, text: 'K2 full text', from: 'builder' }]
    app.props = { view: 'panel', session: 's', id: 's:K2', list, width: 900, height: 200, overlay: 'o1' }
    return pinsView(new Set(), {})
  },
  sheet: b => {
    app.store['hrd.sheet'] = { session: b.session, key: 'D7', seq: 1 }
    return sheetBlock([b], new SheetState({ send() {}, notify() {}, handle: { focus() {} } }), cx)
  },
}

const values = m => new Set(leaves(palettes[m]).map(([, v]) => v))

for (const [name, draw] of Object.entries(SURFACES)) {
  test(`${name} draws only the palette of the mode, and switches without a reload`, () => {
    globalThis.window = { viewport_size: () => ({ width: 1280, height: 821 }) }
    for (const [m, theme] of [
      ['light', LIGHT],
      ['dark', DARK],
      ['light', LIGHT],
    ]) {
      app.theme = theme
      app.colours.clear()
      app.store = {}
      draw(full())
      const allowed = values(m)
      const stray = [...app.colours].filter(c => !allowed.has(c) && !Object.values(theme).includes(c))
      assert.ok(app.colours.size > 0, `${name} drew no colour`)
      assert.deepEqual(stray, [], `${name} in ${m}`)
    }
  })
}

test('no view keeps a colour from module load or hard-codes one', async () => {
  for (const name of CONSUMERS) {
    const url = new URL(`../mods/herdr-agents/${name}.js`, import.meta.url)
    assert.doesNotMatch(readFileSync(url, 'utf8'), /#[0-9a-f]{6}\b/i, name)
    const before = app.themeReads
    await import(`${url.href}?load`)
    assert.equal(app.themeReads, before, `${name}.js reads the theme as it loads`)
  }
})

// WCAG contrast ratio of two hex colours.
const lum = hex => {
  const [r, g, b] = [1, 3, 5]
    .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('light: text reads on the background it sits on', () => {
  const L = palettes.light
  const pairs = [
    [L.color.text, L.color.bar],
    [L.color.soft, L.color.bar],
    [L.color.dim, L.color.bar],
    [L.color.chipText, L.color.text],
    [L.strip.tabOff.text, L.strip.tabOff.bg],
    [L.strip.tabOn.text, L.strip.tabOn.bg],
    [L.strip.unseen.text, L.strip.tabOff.bg],
    [L.strip.flash.text, L.strip.flash.bg],
    [L.strip.muted, L.strip.tabOff.bg],
    [L.strip.ctxWarning, L.strip.tabOff.bg],
    [L.strip.ctxError, L.strip.tabOff.bg],
    [L.card.meta, L.card.bg],
    [L.card.impact, L.card.bg],
    [L.color.chipText, L.card.kbdRec],
    [L.color.text, L.card.kbd],
    [L.color.text, L.card.bg],
    [L.popup.head, L.popup.bg],
    [L.color.text, L.popup.rowHover],
    [L.sheet.label, L.sheet.well],
    [L.sheet.waiting, L.sheet.well],
    [L.sheet.impact, L.sheet.well],
    [L.color.text, L.sheet.well],
  ]
  for (const [fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg} is ${ratio(fg, bg).toFixed(2)}`)
})
