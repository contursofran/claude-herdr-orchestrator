import { div, svg } from 'gpui-kit'
import { color, font, icon, row } from './tokens.js'

const base = () =>
  div()
    .id('pinbar')
    .relative()
    .h(row.pins)
    .w_full()
    .flex()
    .items_center()
    .pl(16)
    .pr(10)
    .gap(10)
    .bg(color.bar)
    .border_b(1)
    .border_color(color.barLine)
    .text_size(font.size)

const ghost = (id, label, onClick) =>
  div()
    .id(id)
    .flex_none()
    .cursor_pointer()
    .px(8)
    .py(3)
    .rounded(6)
    .text_color(color.dim)
    .hover(s => s.text_color(color.text))
    .on_click(onClick)
    .child(label)

/** The segments: one hit area per pin; the bar inside shows current, unread or read. */
function segmentsRow(segments, ui) {
  const width = { current: 18, unread: 8, read: 8 }
  const fill = { current: color.segCurrent, unread: color.segUnread, read: color.segRead }
  return div()
    .flex()
    .items_center()
    .gap(4)
    .flex_none()
    .children(
      segments.map(s =>
        div()
          .id(`seg-${s.id}`)
          .h(14)
          .w(width[s.kind])
          .flex()
          .items_center()
          .cursor_pointer()
          .on_click((_e, cx) => ui.onPick(s.id, cx))
          .child(div().h(3).w_full().rounded(2).bg(fill[s.kind])),
      ),
    )
}

/**
 * The pin bar's row: always there at its height so nothing resizes the terminal.
 *   board  the resolved board, or null (the row draws empty)
 *   ui     what main.js worked out: {mode, current, segments, slim, meta, waiting, flash} and the handlers
 *          onPick(id, cx), onRead(id, cx), onDone(pin, cx), onUndo(id, cx), onReopen(cx)
 * The caret and `all pins` belong to S8 (the drop panel and popover) and are not drawn here.
 */
export function pinbar(board, ui) {
  if (!board) return base()

  // A Done × waiting out its undo time: say so, whatever else is on the board.
  if (ui.waiting.length) {
    const w = ui.waiting[ui.waiting.length - 1]
    return base()
      .child(svg(icon('pin')).size(14).text_color(color.dim).flex_none())
      .child(div().flex_1().min_w_0().truncate().text_color(color.soft).child(`Done: ${w.title}`))
      .child(ghost('pin-undo', 'undo', (_e, cx) => ui.onUndo(w.id, cx)))
  }

  if (ui.mode === 'empty') return base()

  if (ui.mode === 'slim') {
    return base()
      .bg(color.slimBar)
      .cursor_pointer()
      .text_size(11)
      .text_color(color.dim)
      .on_click((_e, cx) => ui.onReopen(cx))
      .child(div().flex_1().min_w_0().truncate().child(ui.slim))
  }

  const pin = ui.current
  return (
    base()
      // The unread flash: a layer behind the content fades in and out, 1.1 s a time; main.js removes it after two.
      .when(ui.flash, el =>
        el.child(div().absolute().top(0).left(0).size_full().bg(color.flash).loop('opacity', { from: 0, to: 1, period: 1100 })),
      )
      .child(svg(icon('pin')).size(14).text_color(color.text).flex_none())
      .when(pin.tag, el =>
        el.child(div().flex_none().px(6).rounded(3).bg(color.text).text_color(color.chipText).font_bold().child(pin.tag)),
      )
      .child(
        // Title and summary are one click target: reading it marks it read.
        div()
          .id('pin-text')
          .flex_1()
          .min_w_0()
          .flex()
          .items_center()
          .gap(10)
          .cursor_pointer()
          .on_click((_e, cx) => ui.onRead(pin.id, cx))
          .child(
            div()
              // Beside a summary the title stops at 260; with none it has the whole row.
              .when(pin.summary, el => el.flex_none().max_w(260))
              .when(!pin.summary, el => el.flex_1().min_w_0())
              .truncate()
              .text_color(pin.unread ? color.text : color.soft)
              .when(pin.unread, el => el.font_bold())
              .when(!pin.unread, el => el.font_semibold())
              .child(pin.title),
          )
          .when(pin.summary, el => el.child(div().flex_1().min_w_0().truncate().text_color(color.soft).child(pin.summary))),
      )
      .child(div().flex_none().text_color(color.dim).child(ui.meta))
      .child(segmentsRow(ui.segments, ui))
      .child(
        div()
          .id('pin-done')
          .flex_none()
          .size(28)
          .flex()
          .items_center()
          .justify_center()
          .rounded(6)
          .cursor_pointer()
          .hover(s => s.bg(color.hover))
          .on_click((_e, cx) => ui.onDone(pin, cx))
          .child(svg(icon('close')).size(12).text_color(color.dim)),
      )
  )
}
