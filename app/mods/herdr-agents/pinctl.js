import { notify, setShared, shared } from 'herdr'
import { send } from './board.js'
import { Outbox, sharedOutbox } from './outbox.js'
import { pruneRead } from './model.js'

/**
 * What is left of the pin bar's state: the Outbox of its surface ('bar') and the read marks. The bar is gone, but an action it queued
 * before an upgrade may still be in the shared queue, so the strip's copy releases and settles it as the bar's copy did.
 * The read marks live in shared("hrd.read"); the "know" pins they belong to stay in the board data.
 */
export class PinCtl {
  constructor() {
    this.outbox = new Outbox({ send, notify, store: sharedOutbox(shared, setShared), surface: 'bar' })
    this.pruned = false
  }

  /** Called with the boards after each change. Drops read marks of boards that are gone, once; settles sent actions. */
  onBoards(boards) {
    if (!this.pruned) {
      this.pruned = true
      const cur = shared('hrd.read') ?? {}
      const next = pruneRead(cur, boards)
      if (next !== cur) setShared('hrd.read', next)
    }
    return this.outbox.settle(boards)
  }
}
