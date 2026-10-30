import { div } from 'gpui-kit'
import { color, font, row } from './tokens.js'
import { debugLine } from './model.js'

/** The strip's row: same at constant height. This slice draws one line. */
export function strip(board) {
  return div()
    .h(row.strip)
    .w_full()
    .flex()
    .items_center()
    .px(16)
    .bg(color.bar)
    .border_b(1)
    .border_color(color.barLine)
    .text_size(font.size)
    .text_color(color.dim)
    .truncate()
    .child(debugLine(board))
}
