import { shared } from 'herdr'
import { AGE_TICK_MS, AgeClock, agedTimes, drawnKey } from './model.js'

/** What the roles that show boards share: the merge-age clock and the "did what I draw change" key. */
export class BoardsRole {
  /** Ages on screen move with the clock, not with a board write. A look at the time: no process, no read, and a redraw only
   *  when one would read differently. The agents list has its own timer. */
  watchAges(cx) {
    this.ages = new AgeClock()
    cx.timer.every(AGE_TICK_MS, cx => {
      if (this.ages.moved(this.agedTimes(), Date.now())) cx.notify()
    })
  }

  agedTimes() {
    const role = this.props?.role
    return agedTimes(role, {
      boards: this.boards.list(),
      open: role === 'strip' ? shared('hrd.open') : role === 'sheet' ? shared('hrd.sheet') : null,
      session: this.props?.session,
    })
  }

  /** What was just drawn is what the next tick compares with. */
  drewAges(el) {
    this.ages?.drawn(this.agedTimes(), Date.now())
    return el
  }

  /** Whether what this copy draws from the boards changed since it last asked. */
  drawnChanged() {
    const role = this.props?.role
    const open = role === 'sheet' ? shared('hrd.sheet') : null
    const key = drawnKey(role, this.boards.list(), this.props?.session, open)
    if (key === this.drawn) return false
    this.drawn = key
    return true
  }

  close() {}
}
