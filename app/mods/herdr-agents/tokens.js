// The look, in one place. The design's greys, not theme(): it has no hue, and a light theme is not supported.
export const font = { size: 12, line: 18, terminalSize: 13, terminalLine: 20 }

export const color = {
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
}

export const icon = name => `mods/herdr-agents/icons/${name}.svg`

export const row = { pins: 38, strip: 34 }

// The strip (S3).
export const strip = {
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
}

// The answer card (S5), a panel row below the terminal.
export const card = {
  bg: '#1A1A1A',
  border: '#3A3A3A',
  meta: '#7A7A7A',
  impact: '#8A8A8A',
  keyBorder: '#333333',
  kbd: '#2A2A2A',
  kbdRec: '#BDBDBD',
  hover: '#1E1E1E',
}
