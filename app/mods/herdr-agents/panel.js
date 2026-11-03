// Role `panel`: the right panel, which follows the tab (#274): an orchestrator's tab draws its board, a worker's tab that worker.
// The strip's copy moves the panel here on arrival at the tab (`panelMove` in panelmodel.js); this copy only draws.
import { div, svg } from 'gpui-kit'
import { closeOverlay, notify, props, run, setShared, shared, terminals, theme } from 'herdr'
import { send } from './board.js'
import { openCard } from './cardctl.js'
import { boardSpace, counts, liveLine, mergedText, projectName, rowAction, rowLive, stripItems } from './model.js'
import { holdPanel } from './panelheld.js'
import { PANEL_FLOAT_W, PANEL_HISTORY, focusedWorker, panelSections, rowStageNames, workerRow } from './panelmodel.js'
import { interruptButton } from './interrupt.js'
import { cell, link, popupShell } from './popup.js'
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

/** An agent's line: dim, amber once it has been quiet too long. */
function liveText(live, text) {
  return div()
    .min_w_0()
    .truncate()
    .text_color(live?.warn ? theme().working : color.dim)
    .child(text ?? '')
}

function row(r, board, now, ui) {
  const merged = mergedText(r, now)
  const who = merged && r.who.text === 'merged' ? '' : r.who.text
  const live = rowLive(board, r, now)
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
    .on_mouse_down('left', () => {
      open(r, board)
      ui?.close?.(true) // the row has moved the keyboard: closing must not take it back
    })
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
        .when(Boolean(who), el => el.child(div().min_w_0().truncate().child(who)))
        .when(Boolean(live), el => el.child(liveText(live, live?.short))),
    )
    .when(Boolean(r.blocked), el =>
      el.child(
        div()
          .flex()
          .items_center()
          .gap(8)
          .text_size(11)
          .child(div().flex_1().min_w_0().truncate().text_color(theme().blocked).child(`blocked · ${r.blocked}`))
          .child(div().flex_none().text_color(color.dim).child('open tab')),
      ),
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

/** Closes the panel and holds it closed, until `panel ▴` opens it. A floating panel (`ui.close`) only goes away. */
const closeButton = ui =>
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
      if (ui.close) return ui.close()
      holdPanel(true)
      run('layout.hide', { id: 'panel' })
    })
    .child(svg('mods/pane/close.svg').size(12))

/** What the orchestrator is doing, from Herdr's own status, with the design's dot: amber only while working. */
function statusChip(board, now) {
  const status = terminals().find(x => x?.address === board.coordinator?.terminal)?.status
  if (!status) return null
  // Quiet mid-turn, it says so and offers the way out.
  const live = status === 'working' ? liveLine(board.coordinator, now) : null
  if (live?.quiet) {
    return div()
      .flex_none()
      .flex()
      .items_center()
      .gap(8)
      .text_size(11)
      .child(liveText(live, live.text))
      .child(interruptButton('panel-interrupt', { terminal: board.coordinator.terminal }, live.warn))
  }
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
  return [sectionHead(name, toggle), ...(open ? rows : rows.slice(0, PANEL_HISTORY)).map(r => row(r, board, now, ui))]
}

/** The frame both views draw in: it fills its block, as the stack gives it the panel's whole size. Framed like Herdr's Changes. */
function frame(id) {
  const t = theme()
  return div()
    .id(id)
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
}

/** Stop needs a second press, since it closes a running worker's tab. `ui.stopping` is the worker the first press was for. */
function stopButton(board, worker, ui) {
  const armed = ui.stopping === worker.name
  return div()
    .id('panel-stop')
    .h(24)
    .px(10)
    .flex_none()
    .flex()
    .items_center()
    .rounded(5)
    .border_1()
    .border_color(theme().border)
    .text_size(11)
    .text_color(armed ? color.text : color.dim)
    .cursor_pointer()
    .hover(el => el.bg(color.hover).text_color(color.text))
    .on_mouse_down('left', (_e, cx) => {
      ui.stopping = armed ? null : worker.name
      if (armed) {
        send(board.session, { action: 'stop', worker: worker.name }).catch(e =>
          notify({ title: 'Could not stop', body: String(e?.message ?? e), level: 'error' }),
        )
      }
      cx.notify()
    })
    .child(armed ? `Stop ${worker.name}?` : 'Stop')
}

/** Back to the orchestrator this worker belongs to, which draws its board again. A floating panel closes on the way. */
function backButton(board, ui) {
  const terminal = board.coordinator?.terminal
  if (!terminal) return null
  return div()
    .id('panel-back')
    .h(24)
    .px(10)
    .flex()
    .flex_none()
    .self_start()
    .items_center()
    .rounded(5)
    .border_1()
    .border_color(theme().border)
    .text_size(11)
    .text_color(color.text)
    .cursor_pointer()
    .hover(el => el.bg(color.hover))
    .on_mouse_down('left', () => {
      run('pane.focus', { terminal })
      ui?.close?.(true)
    })
    .child(`‹ ${projectName(board)} board`)
}

/** A worker's tab: who it is, how far it got, what it is on and its PR, from what the board has. */
export function workerView(board, worker, ui = { open: new Set() }) {
  const t = theme()
  const r = workerRow(board, worker)
  const names = rowStageNames(r, board.stageNames?.length === 5 ? board.stageNames : STAGE_NAMES)
  const about = [worker.repo?.split('/').pop(), worker.note].filter(Boolean).join(' · ')
  const live = worker.state === 'working' ? liveLine(worker, Date.now()) : null
  const target = { session: board.session, worker: worker.name }
  const back = backButton(board, ui)
  return frame('hrd-panel-worker')
    .child(
      div()
        .flex_none()
        .flex()
        .flex_col()
        .gap(6)
        .px(14)
        .py(10)
        .border_b(1)
        .border_color(t.border)
        .when(Boolean(back), el => el.child(back))
        .child(
          div()
            .flex()
            .items_center()
            .gap(8)
            .child(div().min_w_0().truncate().font_bold().child(worker.name))
            .when(Boolean(worker.profile), el =>
              el.child(
                div()
                  .flex_none()
                  .px(4)
                  .rounded(3)
                  .border_1()
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(color.dim)
                  .child(worker.profile),
              ),
            )
            .child(div().flex_1())
            .child(
              div()
                .flex_none()
                .text_size(11)
                .text_color(color.dim)
                .child(worker.state ?? ''),
            ),
        )
        .when(Boolean(about), el => el.child(div().min_w_0().truncate().text_size(11).text_color(color.dim).child(about)))
        .when(Boolean(live), el =>
          el.child(
            div()
              .flex()
              .items_center()
              .justify_between()
              .gap(8)
              .text_size(11)
              .child(liveText(live, live?.text))
              // Here too for a long command, which never reads as quiet and may be what hangs.
              .child(interruptButton('panel-interrupt', target, live?.warn)),
          ),
        )
        .when(Boolean(r), el =>
          el.child(
            div()
              .flex()
              .items_center()
              .gap(10)
              .child(
                div()
                  .flex()
                  .flex_none()
                  .gap(8)
                  .children(r.stages.slice(5 - names.length).map(name => cell(name, CELL))),
              )
              .child(div().min_w_0().truncate().text_size(11).text_color(color.dim).child(names.join(' · '))),
          ),
        ),
    )
    .child(
      div()
        .id('panel-worker-body')
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .gap(14)
        .px(14)
        .py(12)
        .overflow_y_scrollbar()
        .when(!r, el => el.child(div().text_color(color.dim).child('No task on the board for this worker.')))
        .when(Boolean(r), el =>
          el
            .child(
              div()
                .flex()
                .flex_col()
                .gap(6)
                .child(div().text_color(look.head).child('Task'))
                .child(div().child(r.title))
                .when(Boolean(r.now), inner => inner.child(div().text_size(11).text_color(color.dim).child(r.now))),
            )
            .when(Boolean(r.link), inner =>
              inner.child(
                div()
                  .flex()
                  .items_center()
                  .gap(8)
                  .text_color(color.dim)
                  .child(
                    div()
                      .flex_none()
                      .child(link(r, `${r.link.text} ↗`, `panel-pr-${r.key}`)),
                  )
                  .child(div().min_w_0().truncate().text_size(11).child(r.who.text)),
              ),
            ),
        ),
    )
    .child(
      div()
        .flex_none()
        .flex()
        .justify_end()
        .px(14)
        .py(10)
        .border_t(1)
        .border_color(t.border)
        .child(stopButton(board, worker, ui)),
    )
}

const STAGE_NAMES = ['plan', 'build', 'rev', 'CI', 'you']

/** What the panel draws for the tab in focus: that worker on a worker's tab, else the board. */
export function panelFor(board, focus, now, ui) {
  const worker = focusedWorker(board, terminals(), focus)
  return worker ? workerView(board, worker, ui) : panelView(board, now, ui)
}

/** The board, which the strip's copy says when to show. */
export function panelView(board, now = Date.now(), ui = { open: new Set() }) {
  const t = theme()
  const root = frame('hrd-panel')
  if (!board) return root.child(div().p(14).text_color(color.dim).child('No board for this tab.'))
  const { look: stuck, work, merged } = panelSections(board)
  const chip = statusChip(board, now)
  const names = board.stageNames?.length === 5 ? board.stageNames : STAGE_NAMES
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
        .child(closeButton(ui)),
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
        .when(stuck.length > 0, el =>
          el.child(sectionHead(`Needs a look · ${stuck.length}`, stageHeads(names))).children(stuck.map(r => row(r, board, now, ui))),
        )
        .child(sectionHead(`Work · ${counts(board).working} running`, stuck.length > 0 ? null : stageHeads(names)))
        .children(work.map(r => row(r, board, now, ui)))
        .when(work.length === 0, el => el.child(div().px(8).py(6).text_color(color.dim).child('Nothing running.')))
        .children(history('Merged', merged, board, now, ui)),
    )
}

/** `panel ▴` below the width limit: the same views in a pop-up over the terminal. The pop-up holds the keyboard, so the tab it
 *  follows is the terminal it hands back to. */
export function floatView(board, ctl, now, ui) {
  const overlay = props()?.overlay
  ui.close ??= moved => {
    if (moved) ctl.leaving = true
    if (shared('hrd.popup') === overlay) setShared('hrd.popup', null)
    try {
      closeOverlay(overlay)
    } catch {} // the app already closed it
  }
  return popupShell(ctl, PANEL_FLOAT_W, Number(props()?.height) || 0).child(panelFor(board, { terminal: props()?.back }, now, ui))
}
