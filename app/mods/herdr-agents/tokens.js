// The look, in one place. Two palettes of the design's greys, picked on every read from how light the theme's chrome is. The
// design has no hue, so this does not map tokens onto the theme's colours.
import { theme } from 'herdr'

export const font = { size: 12, line: 18, terminalSize: 13, terminalLine: 20 }

export const icon = name => `mods/herdr-agents/icons/${name}.svg`

export const row = { pins: 38, strip: 34 }

/** The palettes by mode. Each token group has the same keys in both; non-colour values are the same in both. */
export const palettes = {
  dark: {
    color: {
      bar: '#151515',
      barLine: '#222222',
      text: '#EDEDED',
      soft: '#BDBDBD',
      dim: '#6A6A6A',
      slimBar: '#131313',
      flash: '#262626',
      segCurrent: '#EDEDED',
      segUnread: '#9A9A9A',
      segRead: '#3A3A3A',
      chipText: '#111111',
      hover: '#222222',
    },
    // The strip (S3).
    strip: {
      line: '#3A3A3A',
      tabOff: { bg: '#151515', text: '#8A8A8A', border: '#242424', bottom: '#3A3A3A' },
      tabOn: { bg: '#1A1A1A', text: '#EDEDED', border: '#3A3A3A', bottom: '#1A1A1A' },
      // Static style once a new tab has stopped flashing and until it is selected.
      unseen: { text: '#EDEDED', border: '#6A6A6A' },
      flash: { bg: '#EDEDED', text: '#111111', period: 900 },
      pillHover: '#222222',
      pillOpen: '#262626',
      muted: '#8A8A8A',
      spin: 1400,
      // The only hues in the strip: the context line near its limit.
      ctxWarning: '#E5C07B',
      ctxError: '#E06C75',
    },
    // The answer card (S5), floating over the terminal.
    card: {
      bg: '#181818',
      border: '#3A3A3A',
      meta: '#7A7A7A',
      impact: '#8A8A8A',
      keyBorder: '#333333',
      kbd: '#2A2A2A',
      kbdRec: '#BDBDBD',
      hover: '#1E1E1E',
    },
    // The board pop-up (S7).
    popup: { bg: '#181818', border: '#3A3A3A', head: '#7A7A7A', rowHover: '#1C1C1C', cell: 44 },
    // The pin drop panel and the all-pins popover (S8).
    pinsLook: {
      bg: '#181818',
      line: '#3A3A3A',
      border: '#2E2E2E',
      rowHover: '#1C1C1C',
      dot: '#9A9A9A',
      buttonBorder: '#333333',
      buttonHover: '#1E1E1E',
    },
    // The context sheet (S9), floating over the top of the terminal.
    sheet: { well: '#111111', wellBorder: '#262626', rule: '#222222', label: '#7A7A7A', waiting: '#8A8A8A', impact: '#BDBDBD' },
  },
  light: {
    color: {
      bar: '#F5F5F5',
      barLine: '#E2E2E2',
      text: '#1A1A1A',
      soft: '#4A4A4A',
      dim: '#6E6E6E',
      slimBar: '#F7F7F7',
      flash: '#E6E6E6',
      segCurrent: '#1A1A1A',
      segUnread: '#8A8A8A',
      segRead: '#D0D0D0',
      chipText: '#FFFFFF',
      hover: '#E8E8E8',
    },
    strip: {
      line: '#D0D0D0',
      tabOff: { bg: '#F5F5F5', text: '#6E6E6E', border: '#E2E2E2', bottom: '#D0D0D0' },
      tabOn: { bg: '#FFFFFF', text: '#1A1A1A', border: '#D0D0D0', bottom: '#FFFFFF' },
      unseen: { text: '#1A1A1A', border: '#8A8A8A' },
      flash: { bg: '#1A1A1A', text: '#FFFFFF', period: 900 },
      pillHover: '#E8E8E8',
      pillOpen: '#E2E2E2',
      muted: '#6E6E6E',
      spin: 1400,
      ctxWarning: '#966400',
      ctxError: '#CF222E',
    },
    card: {
      bg: '#FFFFFF',
      border: '#D0D0D0',
      meta: '#6E6E6E',
      impact: '#6E6E6E',
      keyBorder: '#D8D8D8',
      kbd: '#EEEEEE',
      kbdRec: '#4A4A4A',
      hover: '#F2F2F2',
    },
    popup: { bg: '#FFFFFF', border: '#D0D0D0', head: '#6E6E6E', rowHover: '#F2F2F2', cell: 44 },
    pinsLook: {
      bg: '#FFFFFF',
      line: '#D0D0D0',
      border: '#DADADA',
      rowHover: '#F2F2F2',
      dot: '#8A8A8A',
      buttonBorder: '#D8D8D8',
      buttonHover: '#F2F2F2',
    },
    sheet: { well: '#F5F5F5', wellBorder: '#E2E2E2', rule: '#E8E8E8', label: '#6E6E6E', waiting: '#6E6E6E', impact: '#4A4A4A' },
  },
}

/**
 * The mode now, from the colours the theme really draws. theme() has no appearance field, and settings().dark is the
 * appearance, which a fixed theme ignores: fixed dark under a light system would get white cards in a dark window.
 * A chrome that isn't a hex colour means dark.
 */
export function mode() {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(theme()?.chrome ?? '')
  if (!hex) return 'dark'
  const [r, g, b] = hex.slice(1).map(c => parseInt(c, 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b >= 0.5 ? 'light' : 'dark'
}

const at = (path, m) => path.reduce((o, k) => o[k], palettes[m])

// An object whose every read follows the mode, nested groups included, so a view never keeps a colour.
const groups = new Map()
function live(path) {
  const id = path.join('.')
  if (groups.has(id)) return groups.get(id)
  const out = {}
  for (const key of Object.keys(at(path, 'dark'))) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get() {
        const v = at(path, mode())[key]
        return v !== null && typeof v === 'object' ? live([...path, key]) : v
      },
    })
  }
  groups.set(id, out)
  return out
}

export const color = live(['color'])
export const strip = live(['strip'])
export const card = live(['card'])
export const popup = live(['popup'])
export const pinsLook = live(['pinsLook'])
export const sheet = live(['sheet'])
