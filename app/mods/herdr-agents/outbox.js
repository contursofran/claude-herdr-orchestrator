// Actions that wait for undo before they go out. No `herdr` import: `send`, `notify` and `store` come from outside, so it can be tested.
import { FAIL_LINE_MS, UNDO_MS, actionFile, cancelAction, hiddenKeys, queueAction, readKey, settleSent, takeDue } from './model.js'

/** How long past its due time a waiting action may be before it counts as stuck, ms. */
export const OVERDUE_MS = 5000

const EMPTY = { queue: [], sent: [], failed: [] }

/** The lists kept in shared "hrd.outbox" (`get`/`set` are shared/setShared). Every Outbox given this store is the same one:
 *  what one copy queues, the others show, undo and refuse to queue again, so there is no second record to go stale. All copies
 *  run on one JS thread (seen live), so a change here is whole. */
export const sharedOutbox = (get, set) => ({ get: () => get('hrd.outbox') ?? EMPTY, set: lists => set('hrd.outbox', lists) })

/** The lists of one copy alone. */
function ownOutbox() {
  let lists = EMPTY
  return {
    get: () => lists,
    set: next => {
      lists = next
    },
  }
}

/**
 * Actions wait UNDO_MS, then go out through send(session, action, id). An action goes into `sent` before send() is awaited,
 * so the item stays hidden the whole time; a failed send takes it out at once, into `failed`.
 * It stays in `sent` until the board shows its outcome, the item closed, or SENT_HIDE_MS passed.
 * The timer belongs to the copy that queued (`surface` names it) and stops when that copy reloads or its layout goes, so each
 * copy calls release() when it starts: an action of its last run that never went out is not sent by itself later (it could be
 * stale), it moves to `failed` and shows as "not sent" with retry. The same goes for an action found overdue (sweep()). What
 * was sent stays.
 */
export class Outbox {
  constructor({ send, notify, now = Date.now, store = ownOutbox(), surface = null }) {
    this.send = send
    this.notify = notify
    this.now = now
    this.store = store
    this.surface = surface
  }

  get queue() {
    return this.store.get().queue
  }

  get sent() {
    return this.store.get().sent
  }

  /** Sends that failed, for the quiet line: {session, key, action, at}. */
  get failed() {
    return this.store.get().failed
  }

  /** Change some of the lists in one write; failures past FAIL_LINE_MS go, as nothing shows them. */
  update(change) {
    const lists = { ...this.store.get(), ...change }
    this.store.set({ ...lists, failed: lists.failed.filter(f => this.now() - f.at < FAIL_LINE_MS) })
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
   *  Returns its id, or null when an action for the same item already waits or went out: an item is answered once. */
  schedule(cx, session, action) {
    this.sweep()
    if (action.key && this.hidden().has(readKey(session, action.key))) return null
    const id = actionFile(this.now(), Math.random().toString(36).slice(2, 8))
    this.update({
      queue: queueAction(this.queue, { id, session, action, now: this.now(), surface: this.surface }),
      failed: this.failed.filter(f => !(f.session === session && f.key === action.key)), // a new try replaces the old failure
    })
    cx.timer.after(UNDO_MS + 50, cx => this.flush(cx))
    return id
  }

  undo(id) {
    this.update({ queue: cancelAction(this.queue, id) })
  }

  /** Move actions that will not go out by themselves to `failed` ("not sent", with retry), and tell the owner once. */
  strand(queue, sent = []) {
    const lost = [...queue, ...sent]
    if (!lost.length) return
    const ids = new Set(lost.map(q => q.id))
    this.update({
      queue: this.queue.filter(q => !ids.has(q.id)),
      sent: this.sent.filter(s => !ids.has(s.id)),
      failed: [...this.failed, ...lost.map(({ session, key, action }) => ({ session, key, action, at: this.now() }))],
    })
    this.notify({ title: 'Not sent', body: 'An answer did not go out in time. Retry it from the board.', level: 'error' })
  }

  /** A copy of this surface starts: the last one's timers are gone, so what it queued, or claimed and did not start sending,
   *  would never go out. */
  release() {
    this.strand(
      this.queue.filter(q => q.surface === this.surface),
      this.sent.filter(s => s.waiting && s.surface === this.surface),
    )
  }

  /** Actions past their due time by more than OVERDUE_MS had a timer that died: they are not sent late, they fail. */
  sweep() {
    this.strand(this.queue.filter(q => this.now() - q.due > OVERDUE_MS))
  }

  flush(cx) {
    const { due, rest } = takeDue(this.queue, this.now())
    if (!due.length) return
    const entries = due.map(q => ({
      id: q.id,
      session: q.session,
      key: q.key,
      action: q.action,
      at: this.now(),
      surface: q.surface,
      waiting: true,
    }))
    this.update({ queue: rest, sent: [...this.sent, ...entries] }) // in one write, so no other copy's timer sends them too
    cx.spawn(async cx => {
      for (const entry of entries) {
        try {
          this.update({ sent: this.sent.map(s => (s.id === entry.id ? { ...s, waiting: false } : s)) }) // starting: from here it may be out
          await this.send(entry.session, entry.action, entry.id)
        } catch (e) {
          const { session, key, action } = entry
          this.update({
            sent: this.sent.filter(s => s.id !== entry.id),
            failed: [...this.failed, { session, key, action, at: this.now() }],
          })
          this.notify({ title: 'Could not send', body: String(e?.message ?? e), level: 'error' })
        }
      }
      cx.notify()
    })
  }

  /** Call when the boards change: forget what the boards settled and report failures. Returns true when anything changed. */
  settle(boards) {
    this.sweep()
    const { sent, failed } = settleSent(this.sent, boards)
    if (sent.length === this.sent.length) return false
    const lost = failed.map(f => this.sent.find(s => s.id === f.id))
    this.update({
      sent,
      failed: [...this.failed, ...lost.map(({ session, key, action }) => ({ session, key, action, at: this.now() }))],
    })
    for (const f of failed) this.notify({ title: 'Action failed', body: f.message, level: 'error' })
    return true
  }
}
