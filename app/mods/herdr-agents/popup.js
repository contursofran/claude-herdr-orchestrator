// The board pop-up: the work table of the one board the strip shows, opened from `board ▴` (or ctrl-cmd-b).
import { div, svg } from 'gpui-kit'
import { closeOverlay, focused, notify, props, run, terminals } from 'herdr'
import { send } from './board.js'
import { openCard } from './cardctl.js'
import { POPUP_ROW, POPUP_W, boardSpace, popupKeyAction, popupRefocus, projectName, rowAction, workRows, wrapUpButton } from './model.js'
import { color, font, icon, popup as look } from './tokens.js'

/** A handle that takes the keyboard after the first draw, as the card does: Esc would otherwise go to the terminal. */
export function takeKeyboard(cx) {
  const h = cx.focus_handle()
  cx.spawn(async cx => {
    await cx.sleep(60)
    h.focus()
    cx.notify()
  })
  return h
}

/** This pop-up's keyboard, and whether a row already chose where it goes next. */
export const makePopupState = cx => ({ h: takeKeyboard(cx), leaving: false })

/** The overlay is going, however it was closed (Esc, a click outside, a new pop-up): give the keyboard back. */
export function releasePopup(ctl) {
  const p = props()
  const terminal = popupRefocus({ back: p?.back, space: p?.space }, focused(), ctl?.leaving)
  if (terminal) run('pane.focus', { terminal })
}

const whoColor = kind => (kind === 'you' ? color.text : kind === 'text' ? color.soft : color.dim)

/** One stage cell: a 14 px icon in a 44 px column. A decision (`ask`) is the white disc with the dark glyph. */
function cell(name) {
  const box = div().w(look.cell).flex_none().flex().items_center().justify_center()
  if (!name) return box
  if (name === 'decide') {
    return box.child(
      div()
        .size(14)
        .rounded_full()
        .bg(color.text)
        .flex()
        .items_center()
        .justify_center()
        .child(svg(icon('decide')).size(13).text_color(color.chipText)),
    )
  }
  const glyph = svg(icon(name))
    .size(14)
    .text_color(name === 'done' ? color.soft : color.text)
  return box.child(name === 'working' ? glyph.spin(1400) : glyph)
}

function row(r, board, ctl) {
  return div()
    .id(`work-${r.key}`)
    .h(POPUP_ROW)
    .flex_none()
    .px(8)
    .rounded(6)
    .flex()
    .items_center()
    .gap(8)
    .cursor_pointer()
    .hover(el => el.bg(look.rowHover))
    .on_mouse_down('left', () => {
      const act = rowAction(r, terminals(), boardSpace(board, terminals()))
      if (!act) return
      // The row says where the keyboard goes next, so closing must not hand it back.
      ctl.leaving = true
      closeOverlay(props().overlay)
      if (act.type === 'focus') run('pane.focus', { terminal: act.terminal })
      // One overlay at a time, so the pop-up went first.
      else openCard(board, { key: act.item })
    })
    .child(div().w(44).flex_none().text_color(color.dim).child(r.label))
    .child(div().flex_1().min_w_0().truncate().text_color(color.text).child(r.title))
    .child(div().w(70).flex_none().truncate().text_size(11).text_color(whoColor(r.who.kind)).child(r.who.text))
    .children(r.stages.map(cell))
}

/** The pop-up. Its root has a fixed size (props().height from the strip): a `size_full` root in a popup draws nothing. */
export function popupView(board, ctl) {
  const height = Number(props()?.height) || 0
  const root = div()
    .id('board-popup')
    .track_focus(ctl.h)
    .on_key_down(e => {
      if (popupKeyAction(e.keystroke ?? e.key, e.is_held) !== 'close') return
      try {
        closeOverlay(props().overlay)
      } catch {} // the app's own Esc may have closed it first
    })
    .w(POPUP_W)
    .h(height)
    .flex_none()
    .flex()
    .flex_col()
    .bg(look.bg)
    .border(1)
    .border_color(look.border)
    .rounded(10)
    .pt(10)
    .pb(8)
    .px(6)
    .text_size(font.size)
  if (!board) return root
  const wrap = wrapUpButton(board)
  const stageNames = board.stageNames?.length === 5 ? board.stageNames : ['plan', 'build', 'rev', 'CI', 'you']
  const head = div()
    .h(24)
    .flex_none()
    .px(8)
    .flex()
    .items_center()
    .gap(8)
    .child(div().w(44).flex_none().text_color(look.head).child('Work'))
    .child(
      div()
        .id('work-wrap')
        .h(20)
        .px(8)
        .flex()
        .items_center()
        .rounded(5)
        .text_color(color.dim)
        .cursor_pointer()
        .hover(el => el.bg(color.hover).text_color(color.text))
        .on_mouse_down('left', (_e, cx) => {
          // A write to the board's action folder, through the same path as every other action.
          send(board.session, wrap.action).catch(e => notify({ title: 'Could not send', body: String(e?.message ?? e), level: 'error' }))
          cx.notify()
        })
        .child(wrap.text),
    )
    .child(div().flex_1().min_w_0().truncate().text_color(look.head).child(projectName(board)))
    .child(div().w(70).flex_none())
    .children(stageNames.map(n => div().w(look.cell).flex_none().flex().justify_center().text_size(11).text_color(look.head).child(n)))
  const rows = workRows(board)
  return root.child(head).child(
    div()
      .id('work-rows')
      .flex_1()
      .min_h_0()
      .flex()
      .flex_col()
      .overflow_y_scroll()
      .children(rows.map(r => row(r, board, ctl))),
  )
}
