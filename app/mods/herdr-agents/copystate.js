// What copying from a pin's text decides and remembers. No `gpui-kit` or `herdr` import, so it can be tested.
// A fenced block on its own lines, or a span on one line. A lone backtick matches neither, so nothing is guessed from prose.
const CODE = /^(`{3,})[^\n`]*\n([\s\S]*?)\n\1[ \t]*$|(?<![`\\])(`+)(?!`)([^\n]*?[^`\n])\3(?!`)/gm
const PUNCTUATION = /[!-/:-@[-`{-~]/g

const spanText = s => (/^ .*[^ ].* $/.test(s) ? s.slice(1, -1) : s) // Markdown's own rule for `` a`b ``

/** Each command written in backticks in `text`, in order, each once. */
export function commandsIn(text) {
  const found = []
  for (const m of String(text ?? '').matchAll(CODE)) {
    const command = m[1] ? m[2] : spanText(m[4])
    if (command.trim() && !found.includes(command)) found.push(command)
  }
  return found
}

/** What can be copied from `text`: its commands, or with none the whole text; [] when it is empty. The first is what the keys copy. */
export function copyTargets(text) {
  const commands = commandsIn(text)
  if (commands.length) return commands.map(value => ({ value, command: true }))
  return String(text ?? '').trim() ? [{ value: String(text), command: false }] : []
}

/** `text` as Markdown that draws as written: only its backticked parts are code, and a `*`, `#` or line break stays what it is. */
export function pinMarkdown(text) {
  const plain = s => s.replace(PUNCTUATION, '\\$&').replace(/\n/g, '  \n')
  const value = String(text ?? '')
  let out = ''
  let at = 0
  for (const m of value.matchAll(CODE)) {
    out += plain(value.slice(at, m.index)) + m[0]
    at = m.index + m[0].length
  }
  return out + plain(value.slice(at))
}

/** Which copy key `keystroke` is: 'c', 'cmd-c' or null. Chords such as ctrl-cmd-1 or shift-c are not copy keys. */
export function copyKey(keystroke) {
  const k = String(keystroke ?? '').toLowerCase()
  return k === 'c' || k === 'cmd-c' ? k : null
}

export const COPIED_MS = 1500
const DRAG_PX = 3

/** One surface's copy state: which button reads "Copied", and whether the mouse may have selected text. */
export class CopyState {
  constructor() {
    this.copied = null
    this.presses = 0
    this.press = null
    this.selected = false
  }

  /** Put `value` on the clipboard, and label button `id` "Copied" until a one-shot timer ends, unless a later copy took over. */
  copy(cx, id, value) {
    cx.write_to_clipboard(value)
    const n = ++this.presses
    this.copied = id
    cx.notify()
    cx.spawn(async cx => {
      await cx.sleep(COPIED_MS)
      if (this.presses !== n) return
      this.copied = null
      cx.notify()
    })
  }

  /** A press in the text ends any selection. A drag or a double click may start one. The kit does not tell a mod if it did. */
  mouseDown(e) {
    this.press = e?.position ?? null
    this.selected = (e?.click_count ?? 1) > 1
  }

  mouseMove(e) {
    if (!this.press || !e?.position) return
    if (Math.abs(e.position.x - this.press.x) >= DRAG_PX || Math.abs(e.position.y - this.press.y) >= DRAG_PX) this.selected = true
  }

  mouseUp() {
    this.press = null
  }

  /** A copy key on `text` under button ids `${prefix}-0`…: ⌘C over a possible selection is left to the text view, which copies it. */
  key(cx, chord, prefix, text) {
    if (chord === 'cmd-c' && this.selected) return
    const first = copyTargets(text)[0]
    if (first) this.copy(cx, `${prefix}-0`, first.value)
  }
}
