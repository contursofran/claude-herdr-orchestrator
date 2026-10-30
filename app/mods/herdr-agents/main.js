import { View, div } from 'gpui-kit'
import { focused, props, terminals } from 'herdr'
import { Boards } from './board.js'
import { resolveBoard } from './model.js'
import { pinbar } from './pinbar.js'
import { StripState, strip } from './strip.js'

// One mod, one file per part; props().role says which part this copy draws.
// Roles still to come (card, board, sheet, pins) draw nothing.
const roles = { pinbar, strip }

export default class HerdrAgents extends View {
  init(_props, cx) {
    this.boards = new Boards()
    this.last = null
    // The strip keeps arrival times and the owner's seen tabs, and listens for cmd-shift-1..6.
    this.part = props()?.role === 'strip' ? new StripState() : null
    this.boards.start(cx, cx => {
      this.part?.observe(cx, this.boards.list())
      cx.notify()
    })
    this.part?.listen(cx)
  }

  render() {
    const draw = roles[props()?.role]
    if (!draw) return div()
    // Resolved while drawing, so it follows focus with no polling.
    const found = resolveBoard(this.boards.list(), terminals(), focused(), this.last)
    this.last = found.pick
    if (this.part) this.part.board = found.board
    return draw(found.board, { part: this.part, boards: this.boards.list(), terminals: terminals() })
  }
}
