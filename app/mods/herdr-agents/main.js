import { View, div } from 'gpui-kit'
import { focused, props, setShared, shared, terminals } from 'herdr'
import { AgentsList } from './agents.js'
import { Boards, beat, clearBeat } from './board.js'
import { card, makeCardState } from './card.js'
import { clearStaleOverlays, firstThisRun, onBoardsChanged } from './cardstate.js'
import { AGE_TICK_MS, AgeClock, HEARTBEAT_MS, agedTimes, drawnKey, pinsOverlayEmpty, resolveBoard, stillOpen } from './model.js'
import { closePinsOverlay, pinbar, pinsView } from './pinbar.js'
import { makePopupState, popupView, releasePopup } from './popup.js'
import { PinCtl } from './pinctl.js'
import { makeSheetState, sheetBlock } from './sheet.js'
import { StripState, strip } from './strip.js'
import { readVersion, versionView } from './version.js'

// One mod, one file per part; props().role says which part this copy draws.
// Role `agents` is the agents list (agents.js), which keeps state of its own; `version`, `pins` and `board` have their own
// branches here. Each of the roles below takes what it needs from the same bag.
const roles = {
  pinbar: (board, x) => pinbar(board, x.pin.ui(board, x.cx)),
  strip: (board, x) => strip(board, x.strip),
  card: (_board, x) => card(x.strip.boards, x.card, x.cx),
  sheet: (_board, x) => sheetBlock(x.strip.boards, x.sheet, x.cx),
}

export default class HerdrAgents extends View {
  init(_props, cx) {
    if (props()?.role === 'version') {
      // Read once: nothing here starts the boards or redraws other copies.
      cx.spawn(async cx => {
        this.version = await readVersion()
        if (this.version) cx.notify()
      })
      return
    }
    if (props()?.role === 'agents') {
      // The sort menu is a popup of this same mod: it needs neither the boards nor the list's state.
      this.agentsList = new AgentsList()
      if (props()?.sortMenu) return
      this.boards = new Boards()
      this.boards.start(cx, cx => this.drawnChanged() && cx.notify())
      this.agentsList.init(cx)
      return
    }
    this.boards = new Boards()
    if (props()?.role === 'pins') {
      // The drop panel and the popover get their pins in props(), so the first draw has its content; their one board is
      // watched only so a pin resolved meanwhile leaves. `gone` are the pins Done here, hidden at once.
      this.gone = new Set()
      this.popup = makePopupState(cx)
      this.watchAges(cx)
      this.drawnChanged() // the props' list is what the first draw shows
      this.boards.startOne(cx, props().session, null, cx => {
        if (!this.drawnChanged()) return
        if (pinsOverlayEmpty(props(), this.pinsBoard(), this.gone)) closePinsOverlay()
        else cx.notify()
      })
      return
    }
    if (props()?.role === 'board') {
      this.popup = makePopupState(cx)
      // The pop-up shows the board the strip picked (props().session), so it needs no focus logic of its own.
      this.boards.startOne(cx, props().session, props().board, cx => this.drawnChanged() && cx.notify())
      this.drawnChanged() // the board the strip passed is what the first draw shows
      return
    }
    this.last = null
    this.pin = new PinCtl()
    const pinbarCopy = props()?.role === 'pinbar'
    // Once per app run: overlays stay open across a layout switch, and a Done asked for on `main` waits for this copy.
    if (pinbarCopy && firstThisRun('hrd.pinbarStarted')) clearStaleOverlays(shared, setShared)
    // The card has an Outbox of its own: it settles it here, or a failed send would never show.
    this.card = props()?.role === 'card' ? makeCardState(cx) : null
    this.sheet = props()?.role === 'sheet' ? makeSheetState(cx) : null
    // The strip keeps arrival times and the owner's seen tabs, and listens for ctrl-cmd-1..6.
    this.part = props()?.role === 'strip' ? new StripState() : null
    this.beating = pinbarCopy
    this.boards.start(cx, cx => {
      onBoardsChanged({ pinbar: pinbarCopy, pin: this.pin, card: this.card ?? this.sheet, strip: this.part }, this.boards.list(), cx, () =>
        this.drawnChanged(),
      )
      // The first read says which coordinators are live: tell the plugin now, not 30 s later.
      if (this.beating && !this.started) {
        this.started = true
        this.beat(cx)
      }
    })
    // A data timer, no cx.notify: it must not redraw the window. One writer per window: the pin bar copy only.
    if (pinbarCopy) cx.timer.every(HEARTBEAT_MS, cx => this.beat(cx))
    this.part?.listen(cx)
    if (pinbarCopy) this.pin.listen(cx)
    if (props()?.role !== 'strip') this.watchAges(cx) // the strip draws no ages
  }

  /** Ages on screen move with the clock, not with a board write. A look at the time: no process, no read, and a redraw only
   *  when one would read differently. The agents list has its own timer. */
  watchAges(cx) {
    this.ages = new AgeClock()
    cx.timer.every(AGE_TICK_MS, cx => {
      if (this.ages.moved(this.agedTimes(), Date.now())) cx.notify()
    })
  }

  agedTimes() {
    const role = props()?.role
    return agedTimes(role, {
      boards: this.boards.list(),
      open: role === 'card' ? shared('hrd.open') : role === 'sheet' ? shared('hrd.sheet') : null,
      pinAt: this.pin?.shownAt,
      pins: role === 'pins' ? { ...props(), list: stillOpen(props().list ?? [], this.pinsBoard()) } : null,
      gone: this.gone,
    })
  }

  /** The board a pins overlay was opened on, once read. */
  pinsBoard() {
    return this.boards.list().find(b => b.session === props()?.session)
  }

  /** What was just drawn is what the next tick compares with. */
  drewAges(el) {
    this.ages?.drawn(this.agedTimes(), Date.now())
    return el
  }

  /** Whether what this copy draws from the boards changed since it last asked. */
  drawnChanged() {
    const role = props()?.role
    const open = role === 'sheet' ? shared('hrd.sheet') : role === 'pins' ? props()?.list : null
    const key = drawnKey(role, this.boards.list(), props()?.session, open)
    if (key === this.drawn) return false
    this.drawn = key
    return true
  }

  beat(cx) {
    cx.spawn(async () => {
      try {
        await beat(this.boards.list(), terminals())
      } catch {
        // the plugin keeps its band when the file goes stale
      }
    })
  }

  async close() {
    if (this.popup) releasePopup(this.popup)
    if (this.beating) await clearBeat()
  }

  render(cx) {
    if (props()?.role === 'version') return versionView(this.version)
    if (this.agentsList) return this.agentsList.render(cx, this.boards)
    if (props()?.role === 'pins') return this.drewAges(pinsView(this.gone, this.popup, this.pinsBoard()))
    if (props()?.role === 'board')
      return popupView(
        this.boards.list().find(b => b.session === props().session),
        this.popup,
      )
    const draw = roles[props()?.role]
    if (!draw) return div()
    // Resolved while drawing, so it follows focus with no polling.
    const found = resolveBoard(this.boards.list(), terminals(), focused(), this.last)
    this.last = found.pick
    if (this.part) this.part.board = found.board
    return this.drewAges(
      draw(found.board, {
        pin: this.pin,
        card: this.card,
        sheet: this.sheet,
        cx,
        strip: { part: this.part, boards: this.boards.list(), terminals: terminals() },
      }),
    )
  }
}
