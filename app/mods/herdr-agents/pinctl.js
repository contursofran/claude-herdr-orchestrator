import { notify, setShared, shared } from 'herdr'
import { send } from './board.js'
import { Outbox } from './outbox.js'
import { deriveBar, doneAction, markRead, newBarState, newestPin, pruneRead } from './model.js'

const FLASH_MS = 2200 // 1.1 s, twice

/**
 * What the pin bar remembers between draws: which pin the owner picked, the actions waiting out their undo time, the flash.
 * The read marks live in shared("hrd.read") and are written only on a click (R9), never on a board update.
 */
export class PinCtl {
  constructor() {
    this.outbox = new Outbox({ send, notify })
    this.bar = newBarState() // see deriveBar()
    this.flashId = null
    this.pruned = false
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
    const { state, view, list, flashStart } = deriveBar(this.bar, board, {
      read: shared('hrd.read') ?? {},
      hidden: this.outbox.hidden(),
      waiting: board ? this.outbox.waiting(board.session) : [],
      now: Date.now(),
    })
    this.bar = state
    if (!board) return view
    if (flashStart) {
      this.flashId = flashStart
      cx.timer.after(FLASH_MS, cx => {
        if (this.flashId === flashStart) {
          this.flashId = null
          cx.notify()
        }
      })
    }
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
      onRead: (id, cx) => {
        pick(null)
        this.mark(id)
        cx.notify()
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
