import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { app } from './fake-gpui.mjs'

const tokens = await import('../mods/herdr-agents/tokens.js')
const { pinbar } = await import('../mods/herdr-agents/pinbar.js')
const { PinCtl } = await import('../mods/herdr-agents/pinctl.js')
const { palettes, color, strip: stripLook, card, mode } = tokens

const cx = { notify() {}, spawn() {}, focus_handle: () => ({ focus() {} }), timer: { after() {}, every() {} } }

afterEach(() => {
  app.theme = null
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

test('mode: missing or unknown appearance is dark', () => {
  assert.equal(mode(), 'dark')
  assert.equal(color.text, '#EDEDED')
  app.theme = { appearance: 'sepia' }
  assert.equal(mode(), 'dark')
  app.theme = { appearance: 'light' }
  assert.equal(mode(), 'light')
})

test('tokens follow a theme change live, nested groups too', () => {
  const tabOn = stripLook.tabOn
  assert.equal(color.text, '#EDEDED')
  assert.equal(tabOn.bg, '#1A1A1A')
  app.theme = { appearance: 'light' }
  assert.equal(color.text, '#1A1A1A')
  assert.equal(tabOn.bg, '#FFFFFF')
  assert.equal(stripLook.flash.bg, '#1A1A1A')
  assert.equal(card.bg, '#FFFFFF')
  app.theme = { appearance: 'dark' }
  assert.equal(tabOn.bg, '#1A1A1A')
})

test('a rendered view repaints on a theme change without a reload', () => {
  const needs = [{ key: 'K1', kind: 'know', isOpen: true, text: 'K1 text' }]
  const board = { session: 's', needs }
  const draw = () => pinbar(board, new PinCtl().ui(board, cx)).node.calls.bg[0]
  assert.equal(draw(), palettes.dark.color.bar)
  app.theme = { appearance: 'light' }
  assert.equal(draw(), palettes.light.color.bar)
})

test('the strip keeps no colour from module load and none hard-coded', () => {
  const src = readFileSync(new URL('../mods/herdr-agents/strip.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /#[0-9a-f]{6}/i)
  assert.doesNotMatch(src, /^const \w+ = color\./m)
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
    [L.card.kbdRec, L.card.kbd],
    [L.color.text, L.card.bg],
    [L.popup.head, L.popup.bg],
    [L.color.text, L.popup.rowHover],
    [L.sheet.label, L.sheet.well],
    [L.sheet.waiting, L.sheet.well],
    [L.sheet.impact, L.sheet.well],
    [L.color.text, L.sheet.well],
  ]
  for (const [fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.4, `${fg} on ${bg} is ${ratio(fg, bg).toFixed(2)}`)
})
