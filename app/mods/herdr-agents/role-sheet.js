import { focused, terminals } from 'herdr'
import { Boards } from './board.js'
import { makeSheetState, sheetBlock } from './sheet.js'
import { onBoardsChanged } from './cardstate.js'
import { resolveBoard } from './model.js'
import { BoardsRole } from './role-base.js'

export default class SheetRole extends BoardsRole {
  init(cx) {
    this.boards = new Boards()
    this.last = null
    // The sheet settles its Outbox here, or a failed send would never show.
    this.sheet = makeSheetState(cx)
    this.boards.start(cx, cx => {
      onBoardsChanged({ pin: null, card: this.sheet, strip: null }, this.boards.list(), cx, () => this.drawnChanged())
    })
    this.watchAges(cx)
  }

  render(cx) {
    const found = resolveBoard(this.boards.list(), terminals(), focused(), this.last)
    this.last = found.pick
    return this.drewAges(sheetBlock(this.boards.list(), this.sheet, cx))
  }
}
