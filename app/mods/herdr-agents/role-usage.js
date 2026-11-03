import { exec } from 'herdr'
import { POLL_MS, UsageTracker, usageView } from './usage.js'

export default class UsageRole {
  init(cx) {
    this.usage = new UsageTracker(exec)
    this.pollUsage(cx)
  }

  /** One timer for the next read; a redraw only when what is shown changed. */
  pollUsage(cx) {
    cx.spawn(async cx => {
      await this.usage.poll(() => cx.notify())
    })
    cx.timer.after(POLL_MS, cx => this.pollUsage(cx))
  }

  render() {
    return usageView(this.usage)
  }

  close() {}
}
