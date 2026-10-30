// Actions that wait for undo before they go out. No `herdr` import: `send` and `notify` come from outside, so it can be tested.
import { UNDO_MS, actionFile, cancelAction, hiddenKeys, queueAction, settleSent, takeDue } from './model.js'

/**
 * Actions wait UNDO_MS, then go out through send(session, action, id). An unsent one is lost if the mod reloads.
 * An action goes into `sent` before send() is awaited, so the item stays hidden the whole time; a failed send takes it out.
 * It stays in `sent` until the board shows its outcome, the item closed, or SENT_HIDE_MS passed.
 */
export class Outbox {
  constructor({ send, notify, now = Date.now }) {
    this.send = send
    this.notify = notify
    this.now = now
    this.queue = []
    this.sent = []
    this.failed = [] // sends that failed, for the quiet line of another item: {session, key, action, at}
  }

  /** Read keys to leave out of the lists: waiting or sent and not yet gone from the board. */
  hidden() {
    return hiddenKeys(this.queue, this.sent, this.now())
  }

  /** Waiting actions of one board, for the undo row. */
  waiting(session) {
    return this.queue.filter(q => q.session === session)
  }

  /** Queue an action; it goes out after UNDO_MS unless undo() is called first. `cx` is the caller's own.
   *  Returns its id, or null when an action for the same item already waits (two presses before a redraw). */
  schedule(cx, session, action) {
    if (action.key && this.queue.some(q => q.session === session && q.key === action.key)) return null
    this.failed = this.failed.filter(f => !(f.session === session && f.key === action.key)) // a new try replaces the old failure
    const id = actionFile(this.now(), Math.random().toString(36).slice(2, 8))
    this.queue = queueAction(this.queue, { id, session, action, now: this.now() })
    cx.timer.after(UNDO_MS + 50, cx => this.flush(cx))
    return id
  }

  undo(id) {
    this.queue = cancelAction(this.queue, id)
  }

  flush(cx) {
    const { due, rest } = takeDue(this.queue, this.now())
    this.queue = rest
    if (!due.length) return
    cx.spawn(async cx => {
      for (const q of due) {
        const entry = { id: q.id, session: q.session, key: q.key, action: q.action, at: this.now() }
        this.sent.push(entry)
        try {
          await this.send(q.session, q.action, q.id)
        } catch (e) {
          this.sent = this.sent.filter(s => s !== entry)
          this.failed.push({ session: q.session, key: q.key, action: q.action, at: this.now() })
          this.notify({ title: 'Could not send', body: String(e?.message ?? e), level: 'error' })
        }
      }
      cx.notify()
    })
  }

  /** Call when the boards change: forget what the boards settled and report failures. Returns true when anything changed. */
  settle(boards) {
    const { sent, failed } = settleSent(this.sent, boards)
    for (const f of failed) {
      const was = this.sent.find(s => s.id === f.id)
      if (was) this.failed.push({ session: was.session, key: was.key, action: was.action, at: this.now() })
    }
    const changed = sent.length !== this.sent.length
    this.sent = sent
    for (const f of failed) this.notify({ title: 'Action failed', body: f.message, level: 'error' })
    return changed
  }
}
