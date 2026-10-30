// Copying from a pin's full text: the text drawn so it can be selected and a Copy button per command. The card, the sheet and
// the pin panel share it; the `c` and ⌘C keys are in copystate.js.
import { TextView } from 'gpui-base'
import { div } from 'gpui-kit'
import { copyTargets, pinMarkdown } from './copystate.js'
import { color, font, card as look } from './tokens.js'

const copyButton = (id, state, value) =>
  div()
    .id(id)
    .flex_none()
    .px(8)
    .py(2)
    .rounded(6)
    .border(1)
    .border_color(look.keyBorder)
    .text_size(11)
    .text_color(color.text)
    .cursor_pointer()
    .hover(s => s.bg(look.hover))
    .on_mouse_down('left', (_e, cx) => state.copy(cx, id, value))
    .child(state.copied === id ? 'Copied' : 'Copy')

/** `text`, selectable with the mouse, and a Copy button per command under it (one for the whole text with none). */
export function copyableText(prefix, text, state, textColor = color.soft) {
  const targets = copyTargets(text)
  return div()
    .flex()
    .flex_col()
    .gap(6)
    .child(
      div()
        .id(`${prefix}-text`)
        .text_color(textColor)
        .on_mouse_down('left', e => state.mouseDown(e))
        .on_mouse_up('left', () => state.mouseUp())
        .on_mouse_move(e => state.mouseMove(e))
        .child(TextView.markdown(`${prefix}-md`, pinMarkdown(text)).selectable()),
    )
    .children(
      targets.map((t, i) =>
        div()
          .flex()
          .items_center()
          .gap(8)
          .when(t.command, el =>
            el.child(div().flex_1().min_w_0().truncate().text_size(font.size).text_color(color.dim).child(t.value.split('\n')[0])),
          )
          .child(copyButton(`${prefix}-${i}`, state, t.value)),
      ),
    )
}
