import { focused, terminals } from 'herdr'
import { Boards } from './board.js'
import { resolveBoard } from './model.js'
import { panelFor } from './panel.js'
import { BoardsRole } from './role-base.js'

export default class PanelRole extends BoardsRole {
  init(cx) {
    this.boards = new Boards()
    // Which board follows focus when drawing. The strip's copy says when this block shows.
    this.last = null
    this.panelUi = { open: new Set() } // the history lists opened with `all N`
    this.boards.start(cx, cx => this.drawnChanged() && cx.notify())
    this.watchAges(cx) // the merge ages of its rows
  }

  render() {
    const found = resolveBoard(this.boards.list(), terminals(), focused(), this.last)
    this.last = found.pick
    return this.drewAges(panelFor(found.board, focused(), Date.now(), this.panelUi))
  }
}
