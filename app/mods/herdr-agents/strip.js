import { div, svg } from 'gpui-kit'
import { nextCommand, run, setShared, shared, terminals } from 'herdr'
import { FLASH_MS, counts, flashing, isUnseen, observeArrivals, otherCount, pickAt, stripItems } from './model.js'
import { color, font, icon, row, strip as look } from './tokens.js'

const white = color.text

/** What a tab's icon is: white-on-dark glyph on a white disc (decide), outline (do) or a filled octagon (blocked). */
function tabIcon(kind, fg) {
  if (kind === 'ask') {
    return div()
      .size(12)
      .flex_none()
      .rounded_full()
      .bg(white)
      .flex()
      .items_center()
      .justify_center()
      .child(svg(icon('decide')).size(11).text_color('#111111'))
  }
  return svg(icon(kind === 'blocked' ? 'blocked' : 'do'))
    .size(12)
    .flex_none()
    .text_color(kind === 'blocked' ? white : fg)
}

/** The inside of a tab: icon, bold id, short label. Drawn twice for a flashing tab (the second copy inverted). */
function tabBody(item, fg) {
  return div()
    .flex()
    .items_center()
    .gap(7)
    .text_color(fg)
    .child(tabIcon(item.kind, fg))
    .child(div().font_bold().flex_none().child(item.id))
    .child(div().max_w(110).truncate().child(item.label))
}

/** State the strip keeps between draws: when each item first showed up, which ones the owner has seen. */
export class StripState {
  constructor() {
    this.known = null
    this.seen = new Set()
    this.board = null
  }

  /** Called with a live `cx` (from the board reader) after the boards changed. */
  observe(cx, boards) {
    const now = Date.now()
    this.known = observeArrivals(this.known, boards, now)
    if (Object.values(this.known).some(at => flashing('x', at, now))) {
      // The flash is a native loop; one timer ends it with a redraw.
      cx.spawn(async cx => {
        await cx.sleep(FLASH_MS + 100)
        cx.notify()
      })
    }
  }

  /** Keys: cmd-shift-1..6 in layout:coordinator send herdr-agents.pick1..6 here. */
  listen(cx) {
    cx.spawn(async cx => {
      for (;;) {
        const name = String(await nextCommand())
        const m = /(?:^|\.)pick([1-6])$/.exec(name)
        if (!m) continue
        const item = pickAt(stripItems(this.board), Number(m[1]))
        if (item) this.pick(this.board, item, false)
        cx.notify()
      }
    })
  }

  /** Select a tab. A click on the selected one deselects it (`toggle`); a key never does, so a command that
   *  reaches the mod twice leaves it selected. */
  pick(board, item, toggle = true) {
    const id = `${board.session}:${item.key}`
    const now = shared('hrd.pick')
    this.seen.add(id)
    setShared(
      'hrd.pick',
      toggle && now?.session === board.session && now?.key === item.key ? null : { session: board.session, key: item.key },
    )
  }
}

function tab(item, board, state, now) {
  const id = `${board.session}:${item.key}`
  const picked = shared('hrd.pick')
  const on = picked?.session === board.session && picked?.key === item.key
  const flash = flashing(id, state?.known?.[id], now)
  const unseen = !on && !flash && isUnseen(id, state?.known, state?.seen)
  const t = on ? look.tabOn : look.tabOff
  const fg = unseen ? look.unseen.text : t.text
  const border = unseen ? look.unseen.border : t.border
  const el = div()
    .id(`tab-${item.key}`)
    .relative()
    .flex_none()
    .h(32)
    .px(12)
    .mr(2)
    .flex()
    .items_center()
    .border_t(1)
    .border_l(1)
    .border_r(1)
    .border_color(border)
    .rounded_t(8)
    .bg(t.bg)
    .text_size(font.size)
    .cursor_pointer()
    .on_mouse_down('left', (_e, cx) => {
      if (state) state.pick(board, item)
      cx.notify()
    })
    .child(tabBody(item, fg))
    // The bottom edge: the strip's line under an off tab, the tab's own colour under the selected one.
    .child(div().absolute().left(0).right(0).bottom(0).h(1).bg(t.bottom))
  if (!flash) return el
  // A flashing tab alternates to light: an inverted copy fades in and out on top, four swings.
  return el.child(
    div()
      .absolute()
      .top(0)
      .left(0)
      .right(0)
      .bottom(0)
      .px(12)
      .flex()
      .items_center()
      .rounded_t(8)
      .bg(look.flash.bg)
      .opacity(0)
      .loop('opacity', { from: 0, to: 1, period: look.flash.period })
      .child(tabBody(item, look.flash.text)),
  )
}

function count(name, n) {
  const spin = name === 'working' && n > 0
  const glyph = svg(icon(name))
    .size(12)
    .flex_none()
    .text_color(n > 0 ? white : color.dim)
  return div()
    .flex()
    .items_center()
    .gap(5)
    .text_color(n > 0 ? white : color.dim)
    .child(spin ? glyph.spin(look.spin) : glyph)
    .child(String(n))
}

/** A pill on the right: no action yet for `board` (S7) and `⌘J` (S9). */
const pill = text => div().h(24).px(8).flex().items_center().rounded(5).text_color(look.muted).child(text)

/** The strip's row: tabs for what needs the owner, then counts. Always the same height so nothing resizes the terminal. */
export function strip(board, ctx = {}) {
  const root = div().relative().h(row.strip).w_full().flex().items_end().bg(color.bar).text_size(font.size)
  root.child(div().absolute().left(0).right(0).bottom(0).h(1).bg(look.line))
  if (!board) return root
  const state = ctx.part
  const now = Date.now()
  const items = stripItems(board)
  const c = counts(board)
  const other = otherCount(ctx.boards ?? [], ctx.terminals ?? terminals(), board)
  const tabs = div().id('strip-tabs').flex_1().min_w(0).pl(8).flex().items_end().overflow_x_scroll()
  for (const item of items) tabs.child(tab(item, board, state, now))
  const right = div().flex_none().h(32).pr(8).flex().items_center().gap(12)
  if (other.count > 0 && other.terminal) {
    right.child(
      div()
        .id('strip-other')
        .h(24)
        .px(8)
        .flex()
        .items_center()
        .rounded(5)
        .text_color(look.muted)
        .cursor_pointer()
        .hover(el => el.bg(look.pillHover))
        .on_mouse_down('left', (_e, cx) => {
          run('pane.focus', { terminal: other.terminal })
          cx.notify()
        })
        .child(`${other.count} in other ›`),
    )
  }
  right
    .child(
      div()
        .flex()
        .items_center()
        .gap(12)
        .child(count('working', c.working))
        .child(count('waiting', c.waiting))
        .child(count('blocked', c.blocked)),
    )
    .child(pill('board ▾'))
    .child(pill('⌘J'))
  return root.child(tabs).child(right)
}
