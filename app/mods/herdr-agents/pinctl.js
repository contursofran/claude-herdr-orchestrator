import { setShared, shared } from 'herdr'
import { Outbox } from './board.js'
import {
  ageText,
  currentPin,
  doneAction,
  markRead,
  newPinIds,
  newestPin,
  pinbarMode,
  pins,
  pruneRead,
  segments,
  slimLine,
} from './model.js'

const FLASH_MS = 2200 // 1.1 s, twice

/**
 * What the pin bar remembers between draws: which pin the owner picked, the actions waiting out their undo time, the flash.
 * The read marks live in shared("hrd.read") and are written only on a click (R9), never on a board update.
 */
export class PinCtl {
  constructor() {
    this.outbox = new Outbox()
    this.sel = null // the pin id picked with a segment or the slim bar
    this.session = null
    this.seen = null // pin ids at the last draw
    this.flashed = new Set()
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
    if (!board) return { mode: 'empty', waiting: [] }
    const read = shared('hrd.read') ?? {}
    const list = pins(board, read, this.outbox.hidden())
    if (this.session !== board.session) {
      this.session = board.session
      this.sel = null
      this.seen = null
    }
    if (newPinIds(this.seen, list).length) this.sel = null // a new pin takes the bar back from a picked one
    this.seen = new Set(list.map(p => p.id))

    const mode = pinbarMode(list, this.sel)
    const current = currentPin(list, this.sel)
    if (mode === 'full' && current.unread && !this.flashed.has(current.id)) {
      const id = current.id
      this.flashed.add(id)
      this.flashId = id
      cx.timer.after(FLASH_MS, cx => {
        if (this.flashId === id) {
          this.flashId = null
          cx.notify()
        }
      })
    }

    const all = pins(board, read)
    const waiting = this.outbox.waiting(board.session).map(q => ({ id: q.id, title: all.find(p => p.key === q.key)?.title ?? q.key }))
    return {
      mode,
      current,
      segments: segments(list, current),
      slim: slimLine(list),
      meta: current ? [current.who, ageText(current.at, Date.now())].filter(Boolean).join(' · ') : '',
      waiting,
      flash: current ? this.flashId === current.id : false,
      onPick: (id, cx) => {
        this.sel = id
        this.mark(id)
        cx.notify()
      },
      onRead: (id, cx) => {
        this.sel = null
        this.mark(id)
        cx.notify()
      },
      onDone: (pin, cx) => {
        this.sel = null
        this.outbox.schedule(cx, board.session, doneAction(pin.key))
        cx.notify()
      },
      onUndo: (id, cx) => {
        this.outbox.undo(id)
        cx.notify()
      },
      onReopen: cx => {
        this.sel = newestPin(list)?.id ?? null
        cx.notify()
      },
    }
  }
}
