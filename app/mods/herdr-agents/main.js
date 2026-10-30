import { View, div } from 'gpui-kit'
import { focused, props, terminals } from 'herdr'
import { Boards } from './board.js'
import { resolveBoard } from './model.js'
import { pinbar } from './pinbar.js'
import { strip } from './strip.js'

// One mod, one file per part; props().role says which part this copy draws.
// Roles still to come (card, board, sheet, pins) draw nothing.
const roles = { pinbar, strip }

export default class HerdrAgents extends View {
  init(_props, cx) {
    this.boards = new Boards()
    this.last = null
    this.boards.start(cx, cx => cx.notify())
  }

  render() {
    const draw = roles[props()?.role]
    if (!draw) return div()
    // Resolved while drawing, so it follows focus with no polling.
    const found = resolveBoard(this.boards.list(), terminals(), focused(), this.last)
    this.last = found.pick
    return draw(found.board)
  }
}
