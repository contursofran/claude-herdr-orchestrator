import { AgentsList } from './agents.js'
import { Boards } from './board.js'
import { BoardsRole } from './role-base.js'

export default class AgentsRole extends BoardsRole {
  init(cx) {
    // The sort menu is a popup of this same mod: it needs neither the boards nor the list's state.
    this.agentsList = new AgentsList()
    if (this.props?.sortMenu) return
    this.boards = new Boards()
    this.boards.start(cx, cx => this.drawnChanged() && cx.notify())
    this.agentsList.init(cx)
  }

  render(cx) {
    return this.agentsList.render(cx, this.boards)
  }
}
