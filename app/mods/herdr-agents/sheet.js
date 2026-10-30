import { div, svg } from 'gpui-kit'
import { exec, notify, readTextFile, run, settings, setShared, shared } from 'herdr'
import { send } from './board.js'
import { CardState, clearStaleSheet } from './cardstate.js'
import { button, faceIcon, ghost, keyButton } from './card.js'
import { sheetDoneLine, sheetHint, sheetKeyAction, sheetMore, sheetSize, sheetView, whyLines } from './sheetmodel.js'
import { closeSheet, pageSheet } from './sheetctl.js'
import { color, font, icon, card as look, sheet as sheetLook } from './tokens.js'

/** The sheet's state for this copy (main.js, role `sheet`): the card's (an Outbox for the undo window, the focus handle),
 *  plus the RESULT.md files read so far. A sheet left open when the app last ran is not brought back. */
export class SheetState extends CardState {
  constructor(args) {
    super(args)
    this.files = new Map() // path -> text, or null when it could not be read
  }

  /** Read `path` once (the sheet redraws when it arrives). */
  read(cx, path) {
    if (!path || this.files.has(path)) return
    this.files.set(path, null)
    cx.spawn(async cx => {
      let value = null
      try {
        value = await readTextFile(path)
      } catch {}
      this.files.set(path, value)
      cx.notify()
    })
  }
}

export function makeSheetState(cx) {
  clearStaleSheet(shared, setShared)
  return new SheetState({ send, notify, handle: cx.focus_handle() })
}

const label = text => div().flex_none().text_color(sheetLook.label).child(text)

function pager(view, board, cx) {
  const { pos } = view
  const step = key => (_e, cx) => {
    if (key) pageSheet(key)
    cx.notify()
  }
  const arrow = (id, glyph, key) =>
    div()
      .id(id)
      .flex_none()
      .size(22)
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .text_color(key ? color.soft : color.dim)
      .when(key, el =>
        el
          .cursor_pointer()
          .hover(s => s.bg(look.hover))
          .on_mouse_down('left', step(key)),
      )
      .child(glyph)
  return div()
    .flex_none()
    .flex()
    .items_center()
    .gap(4)
    .child(arrow('sheet-prev', '‹', pos.prev))
    .child(
      div()
        .flex_none()
        .text_color(look.impact)
        .child(pos.i ? `${pos.i} of ${pos.n}` : `${pos.n} open`),
    )
    .child(arrow('sheet-next', '›', pos.next))
}

function header(view, board, close, cx, showMeta) {
  return div()
    .flex()
    .items_center()
    .gap(10)
    .child(faceIcon(view.face === 'ask' ? 'ask' : view.face === 'resolved' || view.face === 'gone' ? view.face : 'do'))
    .child(div().flex_none().font_bold().text_color(color.text).child(view.id))
    .child(div().min_w_0().truncate().font_semibold().text_color(color.text).child(view.title))
    .when(showMeta && view.meta, el => el.child(div().flex_none().text_color(look.meta).child(view.meta)))
    .child(div().flex_1())
    .when(view.pos.n, el => el.child(pager(view, board, cx)))
    .child(ghost('sheet-esc', 'esc', close))
}

/**
 * The floating sheet: the open item of "hrd.sheet", with its context. It draws nothing until opened (Herdr hides a
 * floating block that renders nothing) and nothing it does touches the terminal's size. It is `size.h` tall at most
 * 470 px, shorter in a short window, so the prompt stays in view while there is room. Its two columns scroll on their own; in a
 * narrow window everything between the header and the last row is one scrolling column, options first.
 *   ctl    a SheetState
 *   boards all boards (the open item's board is found by session, so a change of focus does not blank it)
 * Only the owner's click or key opens or closes it; it takes the keyboard when opened.
 */
export function sheetBlock(boards, ctl, cx) {
  const size = sheetSize(typeof window !== 'undefined' ? window.viewport_size?.() : null, settings()?.zoom)
  const open = shared('hrd.sheet')
  if (!open) {
    ctl.token = null
    return div()
  }
  const board = (boards ?? []).find(b => b.session === open.session)
  const raw = sheetView(board, open.key, { queue: ctl.outbox.queue, sent: ctl.outbox.sent, now: Date.now() })
  // The "Why" box falls back to the asker's RESULT.md, read once; the draw after it arrives has it.
  if (raw.whyFile) ctl.read(cx, raw.whyFile)
  const view = raw.whyFile
    ? sheetView(board, open.key, { queue: ctl.outbox.queue, sent: ctl.outbox.sent, now: Date.now(), fileText: ctl.files.get(raw.whyFile) })
    : raw

  // The first draw after an open: take the keyboard, so Esc works.
  const token = `${open.session}:${open.seq ?? 0}`
  if (ctl.token !== token) {
    ctl.token = token
    cx.spawn(async cx => {
      await cx.sleep(60)
      ctl.h.focus()
      cx.notify()
    })
  }

  const close = (_e, cx) => {
    closeSheet()
    cx.notify()
  }
  const choose = (opt, cx) => {
    if (opt.action && board) ctl.schedule(cx, board.session, opt.action)
    else if (opt.url) exec('open', [opt.url]).catch(() => {})
  }
  const askPrincipal = (_e, cx) => {
    // The board has no chat action: this hands the owner the coordinator's terminal, and the sheet closes.
    closeSheet(false)
    if (view.ask) run('pane.focus', { terminal: view.ask })
    cx.notify()
  }
  const resolved = view.face === 'resolved'
  const { narrow } = size

  const why = div()
    .id('sheet-why')
    .when(!narrow, el => el.flex_1().min_h_0().overflow_y_scrollbar())
    .px(14)
    .py(12)
    .rounded(8)
    .bg(sheetLook.well)
    .border(1)
    .border_color(sheetLook.wellBorder)
    .flex()
    .flex_col()
    .gap(2)
    .text_color(color.soft)
  if (view.why) for (const line of whyLines(view.why)) why.child(div().child(line === '' ? ' ' : line))
  else
    why.child(
      div()
        .text_color(color.dim)
        .child(view.whyFile ? (ctl.files.has(view.whyFile) ? 'No text to show.' : 'Reading…') : 'No text to show.'),
    )

  const left = div()
    .min_w_0()
    .when(!narrow, el => el.flex_1().min_h_0())
    .when(narrow, el => el.flex_none())
    .flex()
    .flex_col()
    .gap(6)
    .child(
      div()
        .flex_none()
        .flex()
        .justify_between()
        .gap(10)
        .child(label('Why it asks'))
        .child(div().min_w_0().truncate().text_color(sheetLook.label).child(view.source)),
    )
    .child(why)
  if (view.refs.length) {
    left.child(
      div()
        .flex_none()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(8)
        .child(label('Refs'))
        .children(
          view.refs.map((r, i) =>
            div()
              .id(`sheet-ref-${i}`)
              .min_w_0()
              .truncate()
              .text_color(r.url ? color.text : color.soft)
              .when(r.url, el =>
                el
                  .cursor_pointer()
                  .hover(s => s.text_color(color.soft))
                  .on_mouse_down('left', () => exec('open', [r.url]).catch(() => {})),
              )
              .child(r.label),
          ),
        ),
    )
  }

  const options = div()
    .id('sheet-options')
    .flex()
    .flex_col()
    .when(!narrow, el => el.flex_1().min_h_0().overflow_y_scrollbar())
  view.options.forEach((o, i) => {
    options.child(
      div()
        .flex()
        .flex_col()
        .gap(4)
        .py(8)
        .border_t(1)
        .border_color(sheetLook.rule)
        .child(
          div()
            .flex()
            .child(
              resolved
                ? div()
                    .text_color(o.picked ? color.text : look.meta)
                    .when(o.picked, el => el.font_bold())
                    .child(o.picked ? `✓ ${o.label}` : o.label)
                : keyButton(`sheet-opt-${i}`, i < 3 ? String(i + 1) : '', o.label, o.rec, (_e, cx) => choose(o, cx)),
            ),
        )
        .when(o.impact, el => el.child(div().text_color(sheetLook.impact).child(o.impact))),
    )
  })
  if (resolved) {
    options.child(div().pt(8).text_color(color.soft).child(sheetDoneLine(view)))
  }
  const actions = div()
    .id('sheet-actions')
    .flex_none()
    .flex()
    .items_center()
    .gap(8)
    .flex_wrap()
    .when(view.ask, el => el.child(ghost('sheet-ask', 'Ask principal', askPrincipal)))
    .when(view.undoId, el =>
      el.child(
        button('sheet-undo', 'undo', (_e, cx) => {
          ctl.undo(view.undoId)
          cx.notify()
        }),
      ),
    )
  const gone = view.face === 'gone'
  const right = div()
    .flex_none()
    .when(!narrow, el => el.w(420).min_h_0())
    .when(narrow, el => el.w_full())
    .flex()
    .flex_col()
    .gap(6)
    .child(label('Options'))
    .child(options)
    .when(!narrow, el => el.child(actions))

  const waiting = div()
    .flex_none()
    .flex()
    .items_center()
    .gap(8)
    .text_color(sheetLook.waiting)
    .child(svg(icon('waiting')).size(12).flex_none())
    .child(div().min_w_0().truncate().child(view.waitingOn))
  const hint = sheetHint({ options: resolved ? 0 : view.options.length, paged: view.pos.n > 1, more: sheetMore(view, size) })

  return div()
    .id('sheet')
    .w(size.w)
    .h(size.h)
    .flex()
    .flex_col()
    .text_size(font.size)
    .child(
      div()
        .id('sheet-body')
        .track_focus(ctl.h)
        .on_key_down((e, cx) => {
          const act = sheetKeyAction(e.keystroke ?? e.key, { options: resolved ? 0 : view.options.length, held: e.is_held })
          if (act.type === 'ignore') return
          if (act.type === 'close') close(null, cx)
          else if (act.type === 'prev' || act.type === 'next') {
            const key = act.type === 'prev' ? view.pos.prev : view.pos.next
            if (key) pageSheet(key)
            cx.notify()
          } else choose(view.options[act.index], cx)
        })
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .gap(12)
        .px(20)
        .py(14)
        .child(header(view, board, close, cx, size.meta))
        .when(!narrow && !gone, el => el.child(waiting).child(div().flex_1().min_h_0().flex().gap(22).child(left).child(right)))
        .when(gone, el => el.child(waiting).child(div().flex_1()))
        .when(narrow && !gone, el =>
          el.child(
            div()
              .id('sheet-scroll')
              .flex_1()
              .min_h_0()
              .overflow_y_scrollbar()
              .flex()
              .flex_col()
              .gap(12)
              .child(waiting)
              .child(right)
              .child(left),
          ),
        )
        .child(
          div()
            .flex_none()
            .flex()
            .items_center()
            .gap(8)
            .text_size(11)
            .text_color(look.meta)
            .when(narrow, el => el.child(actions))
            .child(div().min_w_0().truncate().child(hint)),
        ),
    )
}
