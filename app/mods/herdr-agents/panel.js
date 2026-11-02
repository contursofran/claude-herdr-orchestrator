// Role `panel`: the right panel on an orchestrator's tab, which is its board (#274). The strip's copy moves the panel here on
// arrival at the tab (`panelMove` in panelmodel.js); this copy only draws the board that tab resolves to.
import { div, svg } from 'gpui-kit'
import { run, terminals, theme } from 'herdr'
import { openCard } from './cardctl.js'
import { boardSpace, counts, mergedText, projectName, rowAction, stripItems } from './model.js'
import { holdPanel } from './panelheld.js'
import { PANEL_HISTORY, panelSections } from './panelmodel.js'
import { cell, link } from './popup.js'
import { color, font, popup as look } from './tokens.js'

const CELL = 18

/** Goes where the pop-up's row goes: the worker's tab, else the question's card. */
function open(r, board) {
  const act = rowAction(r, terminals(), boardSpace(board, terminals()))
  if (act?.type === 'focus') run('pane.focus', { terminal: act.terminal })
  else if (act?.type === 'card') {
    const at = stripItems(board).findIndex(i => i.key === act.item)
    openCard(board, { key: act.item }, null, Math.max(0, at))
  }
}

function row(r, board, now) {
  const merged = mergedText(r, now)
  const who = merged && r.who.text === 'merged' ? '' : r.who.text
  return div()
    .id(`panel-${r.key}`)
    .flex_none()
    .flex()
    .flex_col()
    .gap(3)
    .px(8)
    .py(6)
    .rounded(6)
    .cursor_pointer()
    .hover(el => el.bg(look.rowHover))
    .on_mouse_down('left', () => open(r, board))
    .child(
      div()
        .flex()
        .items_center()
        .gap(8)
        .child(div().flex_1().min_w_0().truncate().text_color(color.text).child(r.title))
        .children(r.stages.map(name => cell(name, CELL))),
    )
    .child(
      div()
        .flex()
        .items_center()
        .gap(8)
        .text_size(11)
        .text_color(color.dim)
        .when(Boolean(r.link), el =>
          el.child(
            div()
              .flex_none()
              .child(link(r, `${r.link.text} ↗`, `panel-pr-${r.key}`)),
          ),
        )
        .when(!r.link && Boolean(r.label), el => el.child(div().flex_none().child(r.label)))
        .when(Boolean(merged), el => el.child(div().flex_none().child(merged)))
        .when(Boolean(who), el => el.child(div().flex_1().min_w_0().truncate().child(who))),
    )
}

const sectionHead = (text, extra = null) =>
  div()
    .h(26)
    .flex_none()
    .px(8)
    .flex()
    .items_center()
    .justify_between()
    .text_color(look.head)
    .child(div().flex_1().min_w_0().truncate().child(text))
    .when(Boolean(extra), el => el.child(extra))

/** A cell is too narrow for a stage's name: `P`, `B`, `R`, as the design has it; short names like `CI` and `you` fit. */
export const stageHead = name => (name.length <= 3 && name !== 'rev' ? name : name[0].toUpperCase())

/** The column heads over the stage cells, in the same places. */
const stageHeads = names =>
  div()
    .flex()
    .flex_none()
    .gap(8)
    .text_size(10)
    .children(names.map(n => div().w(CELL).flex_none().flex().justify_center().truncate().child(stageHead(n))))

/** Closes the panel and holds it closed, until `panel ▴` opens it. */
const closeButton = () =>
  div()
    .id('panel-close')
    .size(20)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .rounded(5)
    .text_color(color.dim)
    .cursor_pointer()
    .hover(el => el.bg(color.hover).text_color(color.text))
    .on_click(() => {
      holdPanel(true)
      run('layout.hide', { id: 'panel' })
    })
    .child(svg('mods/pane/close.svg').size(12))

/** What the orchestrator is doing, from Herdr's own status, with the design's dot: amber only while working. */
function statusChip(board) {
  const status = terminals().find(x => x?.address === board.coordinator?.terminal)?.status
  if (!status) return null
  return div()
    .flex_none()
    .flex()
    .items_center()
    .gap(6)
    .text_size(11)
    .text_color(color.dim)
    .when(status === 'working', el => el.child(div().size(7).rounded(4).bg(theme().working)))
    .child(status)
}

/** A history list: its head, the newest few rows, and `all N` to see the rest. `ui.open` holds the lists opened. */
function history(name, rows, board, now, ui) {
  if (!rows.length) return []
  const open = ui.open.has(name)
  const toggle =
    rows.length <= PANEL_HISTORY
      ? null
      : div()
          .id(`panel-all-${name}`)
          .flex_none()
          .px(6)
          .rounded(5)
          .text_size(11)
          .cursor_pointer()
          .hover(el => el.bg(color.hover).text_color(color.text))
          .on_mouse_down('left', (_e, cx) => {
            if (open) ui.open.delete(name)
            else ui.open.add(name)
            cx.notify()
          })
          .child(open ? 'fewer' : `all ${rows.length}`)
  return [sectionHead(name, toggle), ...(open ? rows : rows.slice(0, PANEL_HISTORY)).map(r => row(r, board, now))]
}

/** Fills its block: the stack gives it the panel's whole size, and the strip's copy says when it shows. Framed like Herdr's Changes. */
export function panelView(board, now = Date.now(), ui = { open: new Set() }) {
  const t = theme()
  const root = div()
    .id('hrd-panel')
    .size_full()
    .min_h_0()
    .flex()
    .flex_col()
    .rounded(10)
    .overflow_hidden()
    .bg(t.background)
    .border_1()
    .border_color(t.border)
    .text_size(font.size)
    .text_color(color.text)
  if (!board) return root.child(div().p(14).text_color(color.dim).child('No board for this tab.'))
  const { work, merged } = panelSections(board)
  const chip = statusChip(board)
  const names = board.stageNames?.length === 5 ? board.stageNames : ['plan', 'build', 'rev', 'CI', 'you']
  return root
    .child(
      div()
        .flex_none()
        .flex()
        .items_center()
        .gap(8)
        .px(14)
        .py(10)
        .border_b(1)
        .border_color(t.border)
        .child(
          div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(2)
            .child(div().truncate().font_bold().child(projectName(board)))
            .child(div().text_size(11).text_color(color.dim).child('Board')),
        )
        .when(Boolean(chip), el => el.child(chip))
        .child(closeButton()),
    )
    .child(
      div()
        .id('panel-rows')
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .px(6)
        .py(4)
        .overflow_y_scrollbar()
        .child(sectionHead(`Work · ${counts(board).working} running`, stageHeads(names)))
        .children(work.map(r => row(r, board, now)))
        .when(work.length === 0, el => el.child(div().px(8).py(6).text_color(color.dim).child('Nothing running.')))
        .children(history('Merged', merged, board, now, ui)),
    )
}
