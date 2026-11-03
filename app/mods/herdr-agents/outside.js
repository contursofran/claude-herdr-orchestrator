// A press outside closes the board pop-up, the card and the sheet. That handler runs in the capture phase, before the press
// reaches the button underneath, so it leaves a note here: the button that opened the surface reads it and acts as a toggle
// instead of opening it again. The note is for one press; samePress tells it from a later one, with no timer.
import { focused, run, setShared, shared } from 'herdr'
import { canRefocus, samePress } from './model.js'

/** Remember that this press closed `surface` ('card', 'sheet' or 'popup'); `open` is {session, key, back, space}. */
export function noteDismissed(surface, press, open) {
  setShared('hrd.dismissed', {
    surface,
    session: open?.session ?? null,
    key: open?.key ?? null,
    back: open?.back ?? null,
    space: open?.space ?? null,
    x: press?.position?.x,
    y: press?.position?.y,
    button: press?.button,
    clicks: press?.click_count,
    at: Date.now(),
  })
}

/** What `press` closed on its way to this button, or null. Clears the note, so nothing reads it twice. */
export function takeDismissed(press) {
  const note = shared('hrd.dismissed')
  if (!note) return null
  setShared('hrd.dismissed', null)
  return samePress(note, press, Date.now()) ? note : null
}

/** The press was on the button of the surface it closed: that is a plain toggle, so the keyboard goes back as on Esc. */
export function handBack(note) {
  if (canRefocus(note, focused()?.space)) run('pane.focus', { terminal: note.back })
}

/** Where the open board pop-up would hand the keyboard ({back, space}), or null. While it is open it holds the keyboard, so
 *  focused() names no terminal; the surface that replaces it (a key, not a press) takes this as the terminal to return to. */
export function openPopupBack() {
  const open = shared('hrd.popup') ? shared('hrd.popupBack') : null
  return open?.back ? { back: open.back, space: open.space ?? null } : null
}
