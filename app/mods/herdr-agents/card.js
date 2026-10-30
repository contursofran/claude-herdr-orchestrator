import { div, svg } from 'gpui-kit'
import { exec, notify, run, shared, terminals } from 'herdr'
import { send } from './board.js'
import { closeCard, openCard } from './cardctl.js'
import { CardState } from './cardstate.js'
import { answerAction, cardFor, cardHint, cardKeyAction, doneAction, nextItem } from './model.js'
import { color, font, icon, card as look } from './tokens.js'

/** The card's state for this copy (main.js, role `card`). */
export const makeCardState = cx => new CardState({ send, notify, handle: cx.focus_handle(), run, open: shared('hrd.open') })

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
    .on_mouse_down('left', onClick)
    .child(label)

/** A button with a key hint: `[1] Cursor` (no hint: just the label). `rec` is the recommended one. */
function keyButton(id, hint, label, rec, onClick) {
  return div()
    .id(id)
    .flex_none()
    .flex()
    .items_center()
    .gap(8)
    .pl(4)
    .pr(10)
    .py(3)
    .rounded(6)
    .border(1)
    .border_color(rec ? color.text : look.keyBorder)
    .when(rec, el => el.bg(color.text))
    .text_color(rec ? color.chipText : color.text)
    .when(rec, el => el.font_semibold())
    .cursor_pointer()
    .when(!rec, el => el.hover(s => s.bg(look.hover)))
    .on_mouse_down('left', onClick)
    .when(hint, el =>
      el.child(
        div()
          .size(18)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(4)
          .bg(rec ? look.kbdRec : look.kbd)
          .text_color(rec ? color.chipText : color.text)
          .text_size(11)
          .font_bold()
          .child(hint),
      ),
    )
    .child(label)
}

/** A plain button without a key hint. */
const button = (id, label, onClick, primary = false) =>
  div()
    .id(id)
    .flex_none()
    .px(11)
    .py(4)
    .rounded(6)
    .border(1)
    .border_color(primary ? color.text : look.keyBorder)
    .when(primary, el => el.bg(color.text))
    .text_color(primary ? color.chipText : color.text)
    .when(primary, el => el.font_semibold())
    .cursor_pointer()
    .when(!primary, el => el.hover(s => s.bg(look.hover)))
    .on_mouse_down('left', onClick)
    .child(label)

function faceIcon(face) {
  if (face === 'ask') {
    return div()
      .size(14)
      .flex_none()
      .rounded_full()
      .bg(color.text)
      .flex()
      .items_center()
      .justify_center()
      .child(svg(icon('decide')).size(13).text_color(color.chipText))
  }
  const name = face === 'blocked' || face === 'gone' ? 'blocked' : face === 'resolved' ? 'done' : 'do'
  return svg(icon(name)).size(14).flex_none().text_color(color.text)
}

function header(view, onClose) {
  return div()
    .flex()
    .items_center()
    .gap(10)
    .child(faceIcon(view.face))
    .child(div().flex_none().font_bold().text_color(color.text).child(view.id))
    .child(div().min_w_0().truncate().font_semibold().text_color(color.text).child(view.title))
    .when(view.meta, el => el.child(div().flex_none().text_color(look.meta).child(view.meta)))
    .child(div().flex_1())
    .child(ghost('card-esc', 'esc', onClose))
}

/**
 * The card's panel: the one open item of `open` (shared "hrd.open"), on its board. It draws nothing until opened.
 *   ctl    a CardState
 *   boards all boards (the open item's board is found by session, so a change of focus does not blank it)
 * The owner's click or key is the only thing that opens or closes it (it resizes the terminal), and it takes the keyboard.
 */
export function card(boards, ctl, cx) {
  const root = div().id('card').size_full().min_h_0().flex().flex_col().bg(color.bar).p(0).text_size(font.size)
  const open = shared('hrd.open')
  const view = cardFor(boards, open, { queue: ctl.outbox.queue, sent: ctl.outbox.sent, terminals: terminals(), now: Date.now() })
  if (!view) {
    ctl.token = null
    return root
  }
  const board = (boards ?? []).find(b => b.session === open.session)

  // The first draw after an open: take the keyboard. (A cx of this render is fine to spawn from; handlers use their own.)
  const token = `${open.session}:${open.key}:${open.seq ?? 0}`
  if (ctl.token !== token) {
    ctl.token = token
    cx.spawn(async cx => {
      await cx.sleep(60)
      ctl.h.focus()
      cx.notify()
    })
  }

  const key = open.key
  const close = (_e, cx) => {
    closeCard()
    cx.notify()
  }
  // The panel keeps its height: nothing resizes the terminal but the owner's click or key, and a failed answer
  // comes back to the options, which need the room they had.
  const schedule = (cx, action) => ctl.schedule(cx, board.session, action)
  const answer = (i, cx) => schedule(cx, answerAction(key, view.options[i]))
  const done = (_e, cx) => schedule(cx, doneAction(key))
  const link = () => {
    if (view.url) exec('open', [view.url]).catch(() => {})
  }
  const next = (_e, cx) => {
    const item = nextItem(board, key, ctl.outbox.hidden())
    if (item) openCard(board, item, ctl.outbox, terminals())
    cx.notify()
  }

  const body = div().flex().flex_col().gap(12)
  if (view.face === 'ask') {
    body.child(div().text_color(color.soft).max_h(40).overflow_hidden().child(view.text))
    body.child(
      div()
        .flex()
        .flex_col()
        .gap(6)
        .children(
          view.options.slice(0, 6).map((o, i) => {
            const rec = i === view.recommended
            return div()
              .flex()
              .items_center()
              .gap(14)
              .child(
                div()
                  .w(200)
                  .flex_none()
                  .flex()
                  .child(keyButton(`card-opt-${i}`, i < 3 ? String(i + 1) : '', o, rec, (_e, cx) => answer(i, cx))),
              )
              .when(view.impacts[i], el => el.child(div().min_w_0().truncate().text_color(look.impact).child(view.impacts[i])))
          }),
        ),
    )
  } else if (view.face === 'do') {
    body.child(div().text_color(color.soft).max_h(40).overflow_hidden().child(view.text))
    body.child(
      div()
        .flex()
        .gap(6)
        .child(keyButton('card-done', '1', 'Done', true, done))
        .when(view.url, el => el.child(keyButton('card-link', '2', 'Open link', false, link))),
    )
  } else if (view.face === 'blocked') {
    body.child(div().text_color(color.soft).child('Stuck at a prompt'))
    body.child(
      div()
        .flex()
        .gap(6)
        .child(
          button(
            'card-tab',
            'Open its tab',
            (_e, cx) => {
              // With its terminal found, that one gets the keyboard; without, hand it back to where it was.
              closeCard(!view.terminal)
              if (view.terminal) run('pane.focus', { terminal: view.terminal })
              cx.notify()
            },
            true,
          ),
        ),
    )
  } else if (view.face === 'gone') {
    body.child(div().text_color(color.soft).child('Its board is gone: the session ended or the app restarted.'))
  } else {
    const more = nextItem(board, key, ctl.outbox.hidden())
    const text = view.detail
      ? `${view.verb} · ${view.detail} · ${view.sent ? 'sent' : 'sending'}`
      : `${view.verb} · ${view.sent ? 'sent' : 'sending'}`
    body.child(
      div()
        .flex()
        .items_center()
        .gap(10)
        .child(div().min_w_0().truncate().text_color(color.soft).child(text))
        .when(view.undoId, el =>
          el.child(
            button('card-undo', 'undo', (_e, cx) => {
              ctl.undo(view.undoId)
              cx.notify()
            }),
          ),
        )
        .when(more, el => el.child(button('card-next', 'next ›', next, true))),
    )
  }

  return root.child(
    div()
      .id('card-body')
      .track_focus(ctl.h)
      .on_key_down((e, cx) => {
        const act = cardKeyAction(view.face, e.keystroke ?? e.key, {
          options: view.options?.length ?? 0,
          url: Boolean(view.url),
          held: e.is_held,
        })
        if (act.type === 'ignore') return
        if (act.type === 'answer') answer(act.index, cx)
        else if (act.type === 'done') done(null, cx)
        else if (act.type === 'link') link()
        else close(null, cx)
      })
      .flex_1()
      .min_h_0()
      .mx(0)
      .flex()
      .flex_col()
      .gap(12)
      .px(16)
      .py(14)
      .bg(look.bg)
      .border(1)
      .border_color(look.border)
      .rounded(10)
      .child(header(view, close))
      .child(body)
      .child(
        div()
          .text_size(11)
          .text_color(look.meta)
          .child(cardHint(view.face, { options: view.options?.length ?? 0, url: Boolean(view.url) })),
      ),
  )
}
