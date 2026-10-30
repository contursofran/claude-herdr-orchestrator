import { nextCommand, notify, setShared, shared } from 'herdr'
import { openPins } from './pinsctl.js'
import { takeDismissed } from './outside.js'
import { send } from './board.js'
import { Outbox } from './outbox.js'
import { deriveBar, doneAction, doneRequests, keyStep, markRead, newBarState, newestPin, pinStepDir, pins, pruneRead } from './model.js'

const FLASH_MS = 2200 // 1.1 s, twice

/**
 * What the pin bar remembers between draws: which pin the owner picked, the actions waiting out their undo time, the flash.
 * The read marks live in shared("hrd.read") and are written only on a click or a pin step (R9), never on a board update.
 */
export class PinCtl {
  constructor() {
    this.outbox = new Outbox({ send, notify })
    this.bar = newBarState() // see deriveBar()
    this.flashId = null
    this.pruned = false
    this.shown = null // {mode, list, current} of the last draw, for the keys; null with no board
    this.bounds = null // the bar's place in the window, as the last press on it reported it: where the overlays go
    this.back = null // the terminal that surface closed by the last press on the bar would have handed the keyboard to
  }

  /** Keys: ctrl-cmd-[ and ctrl-cmd-] in layout:coordinator send herdr-agents.prevpin / nextpin here. */
  listen(cx) {
    cx.spawn(async cx => {
      for (;;) {
        const dir = pinStepDir(String(await nextCommand()))
        if (dir) this.step(dir, cx)
        cx.notify()
      }
    })
  }

  /** Move to the previous or next pin of the row, wrapping, and mark it read (as a click on its segment does). */
  step(dir, cx) {
    const r = keyStep(this.shown, dir, id => this.mark(id))
    if (!r) return
    this.bar = { ...this.bar, sel: r.sel }
    this.shown = r.shown
    cx?.notify()
  }

  /** Called with the boards after each change. Drops read marks of boards that are gone, once; settles sent actions. */
  onBoards(boards) {
    if (!this.pruned) {
      this.pruned = true
      const cur = shared('hrd.read') ?? {}
      const next = pruneRead(cur, boards)
      if (next !== cur) setShared('hrd.read', next)
    }
    return this.outbox.settle(boards)
  }

  mark(id) {
    const cur = shared('hrd.read') ?? {}
    const next = markRead(cur, id)
    if (next !== cur) setShared('hrd.read', next)
  }

  /** The `ui` argument of pinbar(); `cx` is the render's own. */
  ui(board, cx) {
    // A Done from the drop panel or the popover: the same queued, undoable action as the Done ×.
    const asked = shared('hrd.doneReq')
    if (asked?.length) {
      setShared('hrd.doneReq', [])
      for (const r of doneRequests(asked)) this.outbox.schedule(cx, r.session, doneAction(r.key))
    }
    const { state, view, list, flashStart } = deriveBar(this.bar, board, {
      read: shared('hrd.read') ?? {},
      hidden: this.outbox.hidden(),
      waiting: board ? this.outbox.waiting(board.session) : [],
      now: Date.now(),
      slim: Boolean(shared('hrd.sheet')), // the sheet is open: the row goes slim at the same height
    })
    this.bar = state
    this.shownAt = view.current?.at ?? null
    if (!board) {
      this.shown = null
      return view
    }
    // Keys act only on a pin the row shows: not behind the undo row.
    this.shown = { mode: view.waiting.length ? 'undo' : view.mode, list, current: view.current }
    if (flashStart) {
      this.flashId = flashStart
      cx.timer.after(FLASH_MS, cx => {
        if (this.flashId === flashStart) {
          this.flashId = null
          cx.notify()
        }
      })
    }
    // What the overlays list: never a pin waiting on a Done, or it could be Done twice.
    const open = () => pins(board, shared('hrd.read') ?? {}, this.outbox.hidden())
    const pick = sel => {
      this.bar = { ...this.bar, sel }
    }
    return {
      ...view,
      flash: view.current ? this.flashId === view.current.id : false,
      onPick: (id, cx) => {
        pick(id)
        this.mark(id)
        cx.notify()
      },
      onStep: (dir, cx) => this.step(dir, cx),
      // Clicking a pin's title (or the caret) opens it, and marks it read.
      onRead: (id, cx) => {
        pick(null)
        this.mark(id)
        openPins(board.session, open(), 'panel', { id, bar: this.bounds, back: this.back })
        cx.notify()
      },
      onAll: cx => {
        openPins(board.session, open(), 'all', { bar: this.bounds, back: this.back })
        cx.notify()
      },
      onPress: e => {
        const b = e?.bounds
        if (b?.width > 0) this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
        // A press here that closed the card, sheet or pop-up: what it opens still hands the keyboard back.
        this.back = takeDismissed(e)?.back ?? null
      },
      onDone: (pin, cx) => {
        pick(null)
        this.outbox.schedule(cx, board.session, doneAction(pin.key))
        cx.notify()
      },
      onUndo: (id, cx) => {
        this.outbox.undo(id)
        cx.notify()
      },
      onReopen: cx => {
        pick(newestPin(list)?.id ?? null)
        cx.notify()
      },
    }
  }
}
