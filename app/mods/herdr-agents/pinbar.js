import { div, svg } from 'gpui-kit'
import { closeOverlay, props, setShared, shared } from 'herdr'
import {
  PINS_ALL_ROW_TEXT,
  ageText,
  allPinsHeight,
  markAllRead,
  markRead,
  noteRows,
  orderPins,
  pinContext,
  popupKeyAction,
  rowsSteady,
  stillOpen,
} from './model.js'
import { openPins } from './pinsctl.js'
import { color, font, icon, pinsLook, row } from './tokens.js'

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

const ghostBase = (id, label) =>
  div()
    .id(id)
    .flex_none()
    .cursor_pointer()
    .px(8)
    .py(3)
    .rounded(6)
    .text_color(color.dim)
    .hover(s => s.text_color(color.text))
    .child(label)

const ghost = (id, label, onClick) => ghostBase(id, label).on_click(onClick)

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
          .tooltip(s.title)
          .on_click((_e, cx) => ui.onPick(s.id, cx))
          .child(div().h(3).w_full().rounded(2).bg(fill[s.kind])),
      ),
    )
}

/**
 * The pin bar's row: always there at its height so nothing resizes the terminal.
 *   board  the resolved board, or null (the row draws empty)
 *   ui     what main.js worked out: {mode, current, many, empty, segments, slim, meta, waiting, flash} and the handlers
 *          onPick(id, cx), onStep(dir, cx), onRead(id, cx), onDone(pin, cx), onUndo(id, cx), onReopen(cx)
 * The caret and `all pins` open the drop panel and the popover (S8, pinsView below); onBounds(b) keeps the bar's place.
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

  if (ui.mode === 'empty') {
    // Quiet, so the row keeps its height and says why it is empty; with no board (above) it stays blank.
    return base()
      .child(svg(icon('pin')).size(14).text_color(color.dim).flex_none())
      .child(div().flex_1().min_w_0().truncate().text_color(color.dim).child(ui.empty))
  }

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
      // Where the drop panel and the popover go: the bar's own bounds, from the press that opens them.
      .on_mouse_down('left', e => ui.onBounds(e?.bounds))
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
      .child(ghost('pin-caret', '▾', (_e, cx) => ui.onRead(pin.id, cx)).tooltip('Open this pin'))
      .when(ui.many, el => el.child(ghost('pin-prev', '‹', (_e, cx) => ui.onStep(-1, cx)).tooltip('Previous pin')))
      .child(segmentsRow(ui.segments, ui))
      .when(ui.many, el => el.child(ghost('pin-next', '›', (_e, cx) => ui.onStep(1, cx)).tooltip('Next pin')))
      .child(ghost('pin-all', 'all pins', (_e, cx) => ui.onAll(cx)))
      .child(
        div()
          // One id per pin: a press on this pin's × is no click on the pin that replaced it (#211).
          .id(`pin-done-${pin.key}`)
          .tooltip('Done')
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

// ---- The overlay (role `pins`): the drop panel for one pin, or the popover with all of them ----

const button = (id, label, onClick) =>
  div()
    .id(id)
    .flex_none()
    .cursor_pointer()
    .px(11)
    .py(4)
    .rounded(6)
    .border(1)
    .border_color(pinsLook.buttonBorder)
    .text_color(color.text)
    .hover(s => s.bg(pinsLook.buttonHover))
    .on_mouse_down('left', onClick)
    .child(label)

const ghostDown = (id, label, onClick) => ghostBase(id, label).on_mouse_down('left', onClick)

/** Done from here: a request the pin bar's copy turns into its own queued action (so the same 5 s undo applies). */
function requestDone(pin, session) {
  const asked = shared('hrd.doneReq')
  setShared('hrd.doneReq', [...(Array.isArray(asked) ? asked : []), { session, key: pin.key }])
}

/** This overlay closes itself: main.js's close() then hands the keyboard back. */
export function closePinsOverlay() {
  // A replaced overlay can still fire while it closes: the id in shared is then the new one's.
  if (shared('hrd.pins') === props()?.overlay) setShared('hrd.pins', null)
  try {
    closeOverlay(props()?.overlay)
  } catch {} // the app's own Esc may have closed it first
}

/**
 * The overlay's view. Its root has a fixed size (props() from pinsctl.js): a `size_full` root in a popup draws nothing.
 * The pins come in props().list, as they were when it opened; the read marks are read live (shared "hrd.read"), and `board`,
 * its board once read, takes out any pin resolved since. The popover's root shrinks as its pins go.
 *   gone    a Set of pin ids Done here, hidden at once (an undo shows them again on reopening)
 *   ctl     makePopupState (popup.js): the handle that takes the keyboard, so Esc reaches this overlay and not the terminal,
 *           and `leaving`, set when a row chooses where the keyboard goes; main.js's close() hands it back otherwise;
 *           also where the popover notes when its rows last moved
 */
export function pinsView(gone, ctl, board = null) {
  const p = props() ?? {}
  const read = shared('hrd.read') ?? {}
  const list = stillOpen(p.list ?? [], board)
    .filter(x => !gone.has(x.id))
    .map(x => ({ ...x, unread: read[x.id] !== true }))
  const close = closePinsOverlay
  // The next overlay takes the keyboard, and hands it back to the terminal this one would have.
  const openNext = (view, opts) => {
    ctl.leaving = true
    openPins(session, list, view, { ...opts, bar: bar(), back: p.back })
  }
  const root = div()
    .id('pins-overlay')
    .track_focus(ctl.h)
    .on_key_down(e => {
      if (popupKeyAction(e.keystroke ?? e.key, e.is_held) === 'close') close()
    })
    .w(Number(p.width))
    .h(p.view === 'panel' ? Number(p.height) : Math.min(Number(p.height), allPinsHeight(list.length)))
    .flex_none()
    .flex()
    .flex_col()
    .text_size(font.size)
  const session = p.session
  const bar = () => p.bar
  const done = (pin, cx) => {
    requestDone(pin, session)
    gone.add(pin.id)
    cx.notify()
  }
  if (p.view === 'panel') {
    const pin = list.find(x => x.id === p.id)
    return root
      .bg(pinsLook.bg)
      .border_b(1)
      .border_color(pinsLook.line)
      .pt(14)
      .pb(14)
      .pr(16)
      .pl(39)
      .gap(12)
      .child(
        div()
          .id('pin-full')
          .flex_1()
          .min_h_0()
          .overflow_y_scroll()
          .text_size(font.terminalSize)
          .line_height(`${font.terminalLine}px`)
          .text_color(color.text)
          .child(pin?.text ?? ''),
      )
      .child(
        div()
          .id('pin-context')
          .h(font.line)
          .flex_none()
          .truncate()
          .text_color(color.dim)
          .child(pin ? pinContext(pin, Date.now()) : ''),
      )
      .child(
        div()
          .flex_none()
          .flex()
          .items_center()
          .gap(8)
          .child(
            button('pin-panel-done', 'done', (_e, cx) => {
              if (pin) done(pin, cx)
              close()
            }),
          )
          .child(
            ghostDown('pin-panel-all', 'all pins', () => {
              openNext('all')
            }),
          ),
      )
  }

  const ordered = orderPins(list)
  const now = Date.now()
  noteRows(
    ctl,
    // The read state is part of a row: `mark read` going away moves `done` under the cursor (#205).
    ordered.map(pin => `${pin.key}:${pin.unread ? 'unread' : 'read'}`),
    now,
  )
  // Buttons fire on the press, so one aimed at a row that just moved up would hit the row now under the cursor: ignore it.
  const onRow = act => (e, cx) => {
    if (rowsSteady(ctl, Date.now())) act(e, cx)
  }
  return root
    .bg(pinsLook.bg)
    .border(1)
    .border_color(pinsLook.border)
    .rounded(10)
    .p(10)
    .gap(4)
    .child(
      div()
        .h(24)
        .flex_none()
        .px(10)
        .flex()
        .items_center()
        .gap(10)
        .child(div().flex_1().min_w_0().truncate().text_color(color.dim).child(`Pinned by your agents · ${list.length}`))
        .child(
          ghostDown('pins-mark-all', 'mark all read', (_e, cx) => {
            const next = markAllRead(read, list)
            if (next !== read) setShared('hrd.read', next)
            cx.notify()
          }),
        )
        .child(div().flex_none().text_size(11).text_color(color.dim).child('esc')),
    )
    .child(
      div()
        .id('pins-rows')
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .gap(4)
        .overflow_y_scroll()
        .children(
          ordered.map(pin =>
            div()
              .id(`pin-${pin.key}`)
              .flex_none()
              .h(122)
              .line_height(`${font.line}px`)
              .pt(10)
              .px(10)
              .pb(8)
              .rounded(8)
              .flex()
              .flex_col()
              .gap(4)
              .hover(s => s.bg(pinsLook.rowHover))
              .child(
                div()
                  .id(`pin-open-${pin.key}`)
                  .flex()
                  .items_center()
                  .gap(8)
                  .cursor_pointer()
                  // A click on the title opens it as the drop panel, and marks it read.
                  .on_mouse_down(
                    'left',
                    onRow(() => {
                      const next = markRead(shared('hrd.read') ?? {}, pin.id)
                      setShared('hrd.read', next)
                      openNext('panel', { id: pin.id })
                    }),
                  )
                  .child(
                    div()
                      .size(6)
                      .flex_none()
                      .rounded_full()
                      .when(pin.unread, el => el.bg(pinsLook.dot)),
                  )
                  .child(
                    div()
                      .flex_1()
                      .min_w_0()
                      .truncate()
                      .text_color(pin.unread ? color.text : color.soft)
                      .when(pin.unread, el => el.font_bold())
                      .when(!pin.unread, el => el.font_semibold())
                      .child(pin.title),
                  )
                  .child(
                    div()
                      .flex_none()
                      .text_color(color.dim)
                      .child([pin.who, ageText(pin.at, now)].filter(Boolean).join(' · ')),
                  ),
              )
              .child(
                div()
                  .id(`pin-summary-${pin.key}`)
                  // Whole lines only: exactly three, so the third is never cut through.
                  .h(PINS_ALL_ROW_TEXT * font.line)
                  .flex_none()
                  .overflow_hidden()
                  .text_color(color.soft)
                  .child(pin.summary || pin.text),
              )
              .child(
                div()
                  .flex_none()
                  .flex()
                  .items_center()
                  .gap(4)
                  .when(pin.unread, el =>
                    el.child(
                      ghostDown(
                        `pin-read-${pin.key}`,
                        'mark read',
                        onRow((_e, cx) => {
                          setShared('hrd.read', markRead(read, pin.id))
                          cx.notify()
                        }),
                      ),
                    ),
                  )
                  .child(
                    ghostDown(
                      `pin-done-${pin.key}`,
                      'done',
                      onRow((_e, cx) => {
                        done(pin, cx)
                        if (list.length <= 1) close()
                      }),
                    ),
                  ),
              ),
          ),
        ),
    )
}
