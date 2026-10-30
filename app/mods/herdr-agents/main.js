import { View, div } from 'gpui-kit'
import { focused, props, terminals } from 'herdr'
import { AgentsList } from './agents.js'
import { Boards, beat, clearBeat } from './board.js'
import { card, makeCardState } from './card.js'
import { onBoardsChanged } from './cardstate.js'
import { HEARTBEAT_MS, resolveBoard } from './model.js'
import { pinbar, pinsView } from './pinbar.js'
import { popupView } from './popup.js'
import { PinCtl } from './pinctl.js'
import { StripState, strip } from './strip.js'

// One mod, one file per part; props().role says which part this copy draws.
// Role `agents` is the agents list (agents.js), which keeps state of its own. Roles still to come (board,
// sheet, pins) draw nothing. Each role takes what it needs from the same bag.
const roles = {
  pinbar: (board, x) => pinbar(board, x.pin.ui(board, x.cx)),
  strip: (board, x) => strip(board, x.strip),
  card: (_board, x) => card(x.strip.boards, x.card, x.cx),
}

export default class HerdrAgents extends View {
  init(_props, cx) {
    if (props()?.role === 'agents') {
      // The sort menu is a popup of this same mod: it needs neither the boards nor the list's state.
      this.agentsList = new AgentsList()
      if (props()?.sortMenu) return
      this.boards = new Boards()
      this.boards.start(cx, cx => cx.notify())
      this.agentsList.init(cx)
      return
    }
    this.boards = new Boards()
    if (props()?.role === 'pins') {
      // The drop panel and the popover: a pop-up of this mod, over the boards; `gone` are the pins Done here, hidden at once.
      this.gone = new Set()
      this.boards.start(cx, cx => cx.notify())
      return
    }
    if (props()?.role === 'board') {
      // The pop-up shows the board the strip picked (props().session), so it needs no focus logic of its own.
      this.boards.start(cx, cx => cx.notify())
      return
    }
    this.last = null
    this.pin = new PinCtl()
    const pinbarCopy = props()?.role === 'pinbar'
    // The card has an Outbox of its own: it settles it here, or a failed send would never show.
    this.card = props()?.role === 'card' ? makeCardState(cx) : null
    // The strip keeps arrival times and the owner's seen tabs, and listens for ctrl-cmd-1..6.
    this.part = props()?.role === 'strip' ? new StripState() : null
    this.beating = pinbarCopy
    this.boards.start(cx, cx => {
      onBoardsChanged({ pinbar: pinbarCopy, pin: this.pin, card: this.card, strip: this.part }, this.boards.list(), cx)
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
    if (this.beating) await clearBeat()
  }

  render(cx) {
    if (this.agentsList) return this.agentsList.render(cx, this.boards)
    if (props()?.role === 'pins')
      return pinsView(
        this.boards.list().find(b => b.session === props().session),
        this.gone,
      )
    if (props()?.role === 'board') return popupView(this.boards.list().find(b => b.session === props().session))
    const draw = roles[props()?.role]
    if (!draw) return div()
    // Resolved while drawing, so it follows focus with no polling.
    const found = resolveBoard(this.boards.list(), terminals(), focused(), this.last)
    this.last = found.pick
    if (this.part) this.part.board = found.board
    return draw(found.board, {
      pin: this.pin,
      card: this.card,
      cx,
      strip: { part: this.part, boards: this.boards.list(), terminals: terminals() },
    })
  }
}
