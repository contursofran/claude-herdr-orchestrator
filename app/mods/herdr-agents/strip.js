import { Popup } from 'gpui-base'
import { div, svg } from 'gpui-kit'
import { focused, nextCommand, notify, openOverlay, playSound, run, setShared, shared, terminals } from 'herdr'
import {
  FLASH_MS,
  anyFlashing,
  contextLine,
  counts,
  flashing,
  isBoardCommand,
  isUnseen,
  nextPick,
  observeArrivals,
  otherCount,
  overlayPlan,
  pickAt,
  pickNumber,
  POPUP_W,
  popupHeight,
  popupSpot,
  stripItems,
  workRows,
} from './model.js'
import { Arrivals } from './arrivals.js'
import { card } from './card.js'
import { closeCard, openCard } from './cardctl.js'
import { handBack, takeDismissed } from './outside.js'
import { closeSheet, openSheet } from './sheetctl.js'
import { isSheetCommand, sheetTarget } from './sheetmodel.js'
import { closePins, closePopupOverlay } from './pinsctl.js'
import { color, font, icon, row, strip as look } from './tokens.js'

/** What a tab's icon is: white-on-dark glyph on a white disc (decide), outline (do) or a filled octagon (blocked). */
function tabIcon(kind, fg) {
  if (kind === 'ask') {
    return div()
      .size(12)
      .flex_none()
      .rounded_full()
      .bg(color.text)
      .flex()
      .items_center()
      .justify_center()
      .child(svg(icon('decide')).size(11).text_color(color.chipText))
  }
  return svg(icon(kind === 'blocked' ? 'blocked' : 'do'))
    .size(12)
    .flex_none()
    .text_color(kind === 'blocked' ? color.text : fg)
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
    this.boardsRead = false // the first read of the boards has ended
    this.waiting = null // the last command that came before it
    this.arrivals = new Arrivals({ play: playSound, post: notify })
  }

  /** Called with a live `cx` (from the board reader) after the boards changed. */
  observe(cx, boards) {
    this.arrivals.observe(boards)
    const now = Date.now()
    this.known = observeArrivals(this.known, boards, now)
    if (anyFlashing(this.known, now)) {
      // The flash is a native loop; one timer ends it with a redraw.
      cx.spawn(async cx => {
        await cx.sleep(FLASH_MS + 100)
        cx.notify()
      })
    }
  }

  /** Keys: ctrl-cmd-1..6 in layout:coordinator send herdr-agents.pick1..6 here. */
  listen(cx) {
    cx.spawn(async cx => {
      for (;;) {
        const name = String(await nextCommand())
        // Too early to know the board: it runs when the first read ends. Only the last one: one overlay shows at a time.
        if (this.boardsRead) this.command(name, cx)
        else this.waiting = name
      }
    })
  }

  /** What a command does, on the board shown now. */
  command(name, cx) {
    if (isBoardCommand(name)) return openBoardPopup(this.board)
    if (isSheetCommand(name)) {
      toggleSheet(this.board)
      return cx.notify()
    }
    const n = pickNumber(name)
    if (!n) return
    const item = pickAt(stripItems(this.board), n)
    if (item) this.pick(this.board, item, false)
    cx.notify()
  }

  /** The boards were read; `resolve` gives the board the focus shows. The first time, it runs the command that waited for
   *  this, as its own task: a failure there must not end the board reader that called this. */
  onBoardsRead(cx, resolve) {
    if (this.boardsRead) return
    this.boardsRead = true
    this.board = resolve()
    const name = this.waiting
    this.waiting = null
    if (name) cx.spawn(async cx => this.command(name, cx))
  }

  /** Select a tab and open the card for it (the owner's click or key). A click
   *  on the selected one deselects it and closes the card (`toggle`); a key never does, so a command that reaches the
   *  mod twice leaves it open. `press` is the click's event: if it already closed this item's card on its way here, the
   *  card stays closed; if it closed anything else, what opens now hands the keyboard back to where that would have. */
  pick(board, item, toggle = true, press = null) {
    const id = `${board.session}:${item.key}`
    this.seen.add(id)
    const gone = takeDismissed(press)
    if (gone?.surface === 'card' && gone.session === board.session && gone.key === item.key) return handBack(gone)
    const current = shared('hrd.pick')
    const next = nextPick(current, board.session, item.key, toggle)
    if (!next) closeCard()
    else if (current?.session !== next.session || current?.key !== next.key || !shared('hrd.open')) {
      // One overlay at a time: the pop-up goes before the card opens.
      const plan = overlayPlan('card', {
        popup: Boolean(shared('hrd.popup')),
        card: false,
        pins: Boolean(shared('hrd.pins')),
        sheet: Boolean(shared('hrd.sheet')),
      })
      if (plan.closePopup) closePopupOverlay()
      if (plan.closePins) closePins()
      if (plan.closeSheet) closeSheet(plan.refocus)
      // The card lines up with this tab: its place in the strip is kept while the card moves on to other items.
      openCard(
        board,
        item,
        gone,
        stripItems(board).findIndex(i => i.key === item.key),
      )
    }
  }
}

/** Open the work table above the strip, right aligned. Only the owner's click or key calls this. One overlay at a
 *  time: an open card goes first. The popup's root has a fixed size, so its height is
 *  worked out here from the rows and handed over as a prop. `press` is the click's event: if it already closed the pop-up on
 *  its way here, the pop-up stays closed. */
export function openBoardPopup(board, press = null) {
  const gone = takeDismissed(press)
  if (gone?.surface === 'popup') return handBack(gone)
  if (!board) return
  const height = popupHeight(workRows(board).length)
  const view = window.viewport_size()
  const plan = overlayPlan('popup', {
    popup: Boolean(shared('hrd.popup')),
    card: Boolean(shared('hrd.open')),
    pins: Boolean(shared('hrd.pins')),
    sheet: Boolean(shared('hrd.sheet')),
  })
  // The terminal to hand back; if the card holds the keyboard, the one the card will hand back. Read before anything closes.
  const back = shared('hrd.open')?.back ?? gone?.back ?? focused()?.terminal ?? null
  const space = (gone?.back ? gone.space : focused()?.space) ?? null
  // The card took the keyboard: closing it gives it back to the terminal that had it.
  if (plan.closeCard) closeCard(plan.refocus)
  // A second open replaces the first instead of stacking on it.
  if (plan.closePopup) closePopupOverlay()
  if (plan.closePins) closePins()
  if (plan.closeSheet) closeSheet(plan.refocus)
  const overlay = openOverlay({
    mod: 'herdr-agents',
    kind: 'popup',
    frame: 'none',
    width: POPUP_W,
    height,
    at: popupSpot(view.width, view.height, height),
    props: { role: 'board', session: board.session, height, board, back, space },
  })
  setShared('hrd.popup', overlay)
}

/** ⌘J (and the pill): close the sheet if it is up, else open it on the item the card shows or the first open one. One
 *  overlay at a time: an open card or pop-up goes first. Only the owner's click or key calls this. `press` is the click's
 *  event: if it already closed the sheet on its way here, the sheet stays closed; if it closed the card, the sheet opens on
 *  that card's item. */
export function toggleSheet(board, press = null) {
  const gone = takeDismissed(press)
  if (gone?.surface === 'sheet') return handBack(gone)
  if (shared('hrd.sheet')) return closeSheet()
  if (!board) return
  const card = shared('hrd.open') ?? (gone?.surface === 'card' ? gone : null)
  const key = sheetTarget(board, card?.session === board.session ? card.key : null)
  if (!key) return
  const plan = overlayPlan('sheet', {
    popup: Boolean(shared('hrd.popup')),
    card: Boolean(shared('hrd.open')),
    pins: Boolean(shared('hrd.pins')),
    sheet: false,
  })
  if (plan.closeCard) closeCard(plan.refocus)
  if (plan.closePopup) closePopupOverlay()
  if (plan.closePins) closePins()
  openSheet(board, key, gone)
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
    .on_mouse_down('left', (e, cx) => {
      if (state) state.pick(board, item, true, e)
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
    .text_color(n > 0 ? color.text : color.dim)
  return div()
    .id(`count-${name}`)
    .h(24)
    .px(8)
    .flex()
    .items_center()
    .gap(5)
    .rounded(5)
    .hover(el => el.bg(look.pillHover))
    .text_color(n > 0 ? color.text : color.dim)
    .child(spin ? glyph.spin(look.spin) : glyph)
    .child(String(n))
}

/** `ctx 145k / 250k`: quiet until it nears the limit, as in the band. */
function contextText(line) {
  const shade = line.level === 'error' ? look.ctxError : line.level === 'warning' ? look.ctxWarning : look.muted
  return div()
    .id('strip-context')
    .flex_none()
    .text_color(shade)
    .when(line.level === 'error', el => el.font_bold())
    .child(line.text)
}

/** `⌘J`: opens or closes the context sheet. */
const sheetPill = board =>
  div()
    .id('strip-sheet')
    .h(24)
    .px(8)
    .flex()
    .items_center()
    .rounded(5)
    .text_color(look.muted)
    .cursor_pointer()
    .hover(el => el.bg(look.pillHover))
    .on_mouse_down('left', (e, cx) => {
      toggleSheet(board, e)
      cx.notify()
    })
    .child('⌘J')

/** `board ▴`: opens the work table above it. */
const boardPill = board =>
  div()
    .id('strip-board')
    .h(24)
    .px(8)
    .flex()
    .items_center()
    .rounded(5)
    .text_color(look.muted)
    .cursor_pointer()
    .hover(el => el.bg(look.pillHover))
    .on_mouse_down('left', (e, cx) => {
      openBoardPopup(board, e)
      cx.notify()
    })
    .child('board ▴')

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
  const tabEls = items.map(item => tab(item, board, state, now))
  // The answer card floats above the tab it opened from, left edges together (the Popup keeps it inside the window). That is
  // the tab at the place it opened at, so it stays put as the card moves on to other items; with no tab there, the row.
  const open = ctx.card ? shared('hrd.open') : null
  if (open) {
    let content = null
    try {
      content = card(ctx.boards ?? [], ctx.card, ctx.cx)
    } catch (error) {
      // A card that throws must not blank the strip: draw it without the card, say so, and close it so a redraw doesn't throw again.
      if (ctx.fault) ctx.fault.error = error
      ctx.cx?.spawn(async cx => {
        await cx.sleep(0) // setShared redraws every mod, which a draw should not start from inside
        closeCard()
      })
    }
    if (content) {
      const at = items.length ? Math.max(0, Math.min(open.at ?? 0, items.length - 1)) : -1
      const float = trigger => Popup.new('answer-card', trigger).anchor('bottom_left').content(content)
      if (at >= 0) tabEls[at] = float(tabEls[at])
      else tabs.child(float(div().id('card-anchor')))
    }
  } else if (ctx.card?.hold) {
    // After the last item closed, the keyboard waits on an empty element (cardctl.js holdKeyboard).
    root.child(card(ctx.boards ?? [], ctx.card, ctx.cx))
  }
  for (const el of tabEls) tabs.child(el)
  // A divider and a gap before the right-hand group, so a tab cut by the scroll reads as "more this way" and never runs into `ctx`.
  const right = div().id('strip-right').flex_none().h(32).pl(12).pr(8).flex().items_center().gap(12)
  right.child(div().id('strip-divider').w(1).h(16).bg(look.line))
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
  const context = contextLine(board)
  if (context) right.child(contextText(context))
  right
    .child(
      div()
        .flex()
        .items_center()
        .gap(4)
        .child(count('working', c.working))
        .child(count('waiting', c.waiting))
        .child(count('blocked', c.blocked)),
    )
    .child(boardPill(board))
    .child(sheetPill(board))
  return root.child(tabs).child(right)
}
