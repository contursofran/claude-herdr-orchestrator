import { View, div } from 'gpui-kit'
import { focused, props, terminals } from 'herdr'
import { Boards } from './board.js'
import { resolveBoard } from './model.js'
import { pinbar } from './pinbar.js'
import { PinCtl } from './pinctl.js'
import { strip } from './strip.js'

// One mod, one file per part; props().role says which part this copy draws.
// Roles still to come (card, board, sheet, pins) draw nothing.
const roles = { pinbar: (board, ctl, cx) => pinbar(board, ctl.ui(board, cx)), strip: board => strip(board) }

export default class HerdrAgents extends View {
  init(_props, cx) {
    this.boards = new Boards()
    this.last = null
    this.pin = new PinCtl()
    const pinbarCopy = props()?.role === 'pinbar'
    this.boards.start(cx, cx => {
      if (pinbarCopy) this.pin.onBoards(this.boards.list())
      cx.notify()
    })
  }

  render(cx) {
    const draw = roles[props()?.role]
    if (!draw) return div()
    // Resolved while drawing, so it follows focus with no polling.
    const found = resolveBoard(this.boards.list(), terminals(), focused(), this.last)
    this.last = found.pick
    return draw(found.board, this.pin, cx)
  }
}
