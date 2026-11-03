import { Boards } from './board.js'
import { floatView } from './panel.js'
import { makePopupState, popupView, releasePopup } from './popup.js'
import { BoardsRole } from './role-base.js'

export default class BoardRole extends BoardsRole {
  init(cx) {
    this.boards = new Boards()
    this.popup = makePopupState(cx)
    // The pop-up shows the board the strip picked (this.props.session), so it needs no focus logic of its own.
    this.boards.startOne(cx, this.props.session, this.props.board, cx => this.drawnChanged() && cx.notify())
    this.drawnChanged() // the board the strip passed is what the first draw shows
    this.watchAges(cx) // the merge ages of its rows
  }

  render() {
    const board = this.boards.list().find(b => b.session === this.props.session)
    if (this.props?.float) return this.drewAges(floatView(board, this.popup, Date.now(), (this.panelUi ??= { open: new Set() })))
    return this.drewAges(popupView(board, this.popup))
  }

  async close() {
    if (this.popup) releasePopup(this.popup)
  }
}
