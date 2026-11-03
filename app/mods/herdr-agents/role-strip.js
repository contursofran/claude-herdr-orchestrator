import { focused, setShared, shared, terminals } from 'herdr'
import { div } from 'gpui-kit'
import { Boards, beat, clearBeat } from './board.js'
import { makeCardState } from './card.js'
import { clearStaleOverlays, firstThisRun, onBoardsChanged } from './cardstate.js'
import { anyDrawFailed, clearDrawFailed, drawNoteDue, guardsDraw, noteDraw } from './drawguard.js'
import { HEARTBEAT_MS, resolveBoard } from './model.js'
import { PinCtl } from './pinctl.js'
import { BoardsRole } from './role-base.js'
import { StripState, strip } from './strip.js'

export default class StripRole extends BoardsRole {
  init(cx) {
    this.boards = new Boards()
    this.last = null
    // The strip's copy is the one always in the window (the coordinator layout has it and nothing else drops it), so it does what
    // the pin bar's copy used to do besides drawing: the heartbeat (one writer per window), the pin outbox, the start-of-run
    // clean-up and the report of a part that fails to draw.
    this.pin = new PinCtl()
    this.pin.outbox.release() // what the last copy queued and never sent would go out stale
    // Once per app run: overlays stay open across a layout switch, and a Done asked for on `main` waits for this copy.
    // The key keeps its old name (from when the pin bar copy ran this): renaming it would repeat the clean-up once after an upgrade.
    if (firstThisRun('hrd.pinbarStarted')) {
      clearStaleOverlays(shared, setShared)
      clearDrawFailed(shared, setShared) // a card that failed last run may not draw again to clear it
    }
    // The card (drawn by the strip's copy) settles its Outbox here, or a failed send would never show.
    this.card = makeCardState(cx)
    // The strip keeps arrival times and the owner's seen tabs, and listens for ctrl-cmd-1..6.
    this.part = new StripState()
    this.beating = true
    this.boards.start(cx, cx => {
      onBoardsChanged({ pin: this.pin, card: this.card, strip: this.part }, this.boards.list(), cx, () => this.drawnChanged())
      this.part.onBoardsRead(cx, () => resolveBoard(this.boards.list(), terminals(), focused(), this.last).board)
      // The first read says which coordinators are live: tell the plugin now, not 30 s later.
      if (this.beating && !this.started) {
        this.started = true
        this.beat(cx)
      }
    })
    // A data timer, no cx.notify: it must not redraw the window. One writer per window: the strip's copy only.
    cx.timer.every(HEARTBEAT_MS, cx => this.beat(cx))
    this.part.listen(cx)
    this.watchAges(cx) // the strip's card shows an age
  }

  beat(cx) {
    cx.spawn(async () => {
      try {
        await beat(this.boards.list(), terminals(), !anyDrawFailed(shared))
      } catch {
        // the plugin keeps its band when the file goes stale
      }
    })
  }

  /** Notes how this draw went, after the draw: setShared redraws every mod, which a draw should not start from inside. */
  noteDrawn(cx, error) {
    const role = this.props?.role
    if (!guardsDraw(role) || !drawNoteDue(role, error, shared)) return
    cx.spawn(async cx => {
      await cx.sleep(0)
      if (noteDraw(role, error, shared, setShared) && error) console.log(`herdr-agents: ${role} failed to draw: ${error}`)
    })
  }

  /** The strip's copy tells the plugin at once when a part starts or stops failing, not at the next 30 s beat. */
  beatOnChange(cx) {
    if (!this.beating) return
    const failed = anyDrawFailed(shared)
    if (failed === Boolean(this.beatFailed)) return
    this.beatFailed = failed
    this.beat(cx)
  }

  async close() {
    // A part that is gone no longer fails to draw. Its own key only: the other parts are still there.
    noteDraw(this.props.role, null, shared, setShared)
    await clearBeat()
  }

  render(cx) {
    this.beatOnChange(cx)
    try {
      // Resolved while drawing, so it follows focus with no polling.
      const found = resolveBoard(this.boards.list(), terminals(), focused(), this.last)
      this.last = found.pick
      this.part.board = found.board
      this.part.followPanel(cx, found.board)
      const fault = {} // the strip says here when only its card failed to draw
      const el = this.drewAges(
        strip(found.board, {
          part: this.part,
          boards: this.boards.list(),
          terminals: terminals(),
          fault,
          card: this.card,
          cx,
        }),
      )
      this.noteDrawn(cx, fault.error ?? null)
      return el
    } catch (error) {
      this.noteDrawn(cx, error)
      return div()
    }
  }
}
