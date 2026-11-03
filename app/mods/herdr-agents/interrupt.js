// The Interrupt button (#90), for an agent gone quiet in the agents list and the right panel.
import { div } from 'gpui-kit'
import { notify, theme } from 'herdr'
import { interruptAgent } from './board.js'
import { color } from './tokens.js'

/** `target` is what interruptTarget gives. `warn` makes it amber, as its line is once the agent has been quiet too long. */
export function interruptButton(id, target, warn) {
  const t = theme()
  return div()
    .id(id)
    .h(20)
    .px(8)
    .flex_none()
    .flex()
    .items_center()
    .rounded(5)
    .border_1()
    .border_color(warn ? `${t.working}66` : t.border)
    .text_size(11)
    .text_color(warn ? t.working : color.dim)
    .cursor_pointer()
    .hover(el => el.bg(color.hover))
    .on_mouse_down('left', (_e, cx) => {
      cx.stop_propagation()
      interruptAgent(target).catch(e => notify({ title: 'Could not interrupt', body: String(e?.message ?? e), level: 'error' }))
    })
    .child('Interrupt')
}
