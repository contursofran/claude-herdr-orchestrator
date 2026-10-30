import { View, div } from 'gpui-kit'
import { focused, props, terminals } from 'herdr'
import { AgentsList } from './agents.js'
import { Boards } from './board.js'
import { resolveBoard } from './model.js'
import { pinbar } from './pinbar.js'
import { PinCtl } from './pinctl.js'
import { StripState, strip } from './strip.js'

// One mod, one file per part; props().role says which part this copy draws.
// Role `agents` is the agents list (agents.js), which keeps state of its own. Roles still to come (card, board,
// sheet, pins) draw nothing. Each role takes what it needs from the same bag.
const roles = {
  pinbar: (board, x) => pinbar(board, x.pin.ui(board, x.cx)),
  strip: (board, x) => strip(board, x.strip),
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
    this.last = null
    this.pin = new PinCtl()
    const pinbarCopy = props()?.role === 'pinbar'
    // The strip keeps arrival times and the owner's seen tabs, and listens for ctrl-cmd-1..6.
    this.part = props()?.role === 'strip' ? new StripState() : null
    this.boards.start(cx, cx => {
      if (pinbarCopy) this.pin.onBoards(this.boards.list())
      this.part?.observe(cx, this.boards.list())
      cx.notify()
    })
    this.part?.listen(cx)
  }

  render(cx) {
    if (this.agentsList) return this.agentsList.render(cx, this.boards)
    const draw = roles[props()?.role]
    if (!draw) return div()
    // Resolved while drawing, so it follows focus with no polling.
    const found = resolveBoard(this.boards.list(), terminals(), focused(), this.last)
    this.last = found.pick
    if (this.part) this.part.board = found.board
    return draw(found.board, {
      pin: this.pin,
      cx,
      strip: { part: this.part, boards: this.boards.list(), terminals: terminals() },
    })
  }
}
