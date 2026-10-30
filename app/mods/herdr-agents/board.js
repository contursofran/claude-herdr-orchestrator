// Reads the boards the plugin writes (~/.herdr-agents/board/<session>.json) and keeps them current.
import { exec, home, notify, readTextFile, watchFolder, writeTextFile } from 'herdr'
import { UNDO_MS, actionFile, applyFile, boardId, cancelAction, hiddenKeys, queueAction, settleSent, takeDue } from './model.js'

export const boardDir = () => `${home()}/.herdr-agents/board`
export const outgoingDir = () => `${home()}/.herdr-agents/outgoing`

export class Boards {
  constructor() {
    this.files = {}
  }

  list() {
    return Object.values(this.files)
  }

  /** One full read, then only the files the watcher reports. No timers: the plugin writes on its own 3 s tick. */
  start(cx, onChange) {
    cx.spawn(async cx => {
      const dir = boardDir()
      await exec('mkdir', ['-p', dir])
      // Ask to be told before the first read, so a write between the two is not missed.
      let changed = watchFolder(dir)
      const listed = await exec('ls', ['-1', dir])
      for (const name of listed.stdout.split('\n')) {
        const id = boardId(dir, `${dir}/${name}`)
        if (id) await this.load(dir, id)
      }
      onChange(cx)
      for (;;) {
        const paths = await changed
        changed = watchFolder(dir)
        const ids = new Set(paths.map(p => boardId(dir, p)).filter(Boolean))
        for (const id of ids) await this.load(dir, id)
        if (ids.size) onChange(cx)
      }
    })
  }

  async load(dir, id) {
    let text = null
    try {
      text = await readTextFile(`${dir}/${id}.json`)
    } catch {
      return // unreadable right now: keep what we have
    }
    this.files = applyFile(this.files, id, text)
  }
}

/**
 * Writes one action file for a board: into outgoing/ first, then `mv` into <session>.actions/ so the plugin never reads a
 * half-written file. Returns the file name, which is the id the board reports the outcome under (`board.actions`).
 */
export async function send(session, action, id = actionFile(Date.now(), Math.random().toString(36).slice(2, 8))) {
  const out = outgoingDir()
  const dest = `${boardDir()}/${session}.actions`
  await exec('mkdir', ['-p', out, dest])
  await writeTextFile(`${out}/${id}`, JSON.stringify(action), null)
  const moved = await exec('mv', [`${out}/${id}`, `${dest}/${id}`])
  if (moved.code !== 0) throw new Error(moved.stderr.trim() || 'mv failed')
  return id
}

/**
 * Actions that wait UNDO_MS for undo, then go out through send(). An unsent one is lost if the mod reloads.
 * After sending, an action stays in `sent` until the board shows its outcome or the item closed, so the item stays hidden.
 * Used for Done × now; the card's answers (S5) use it too.
 */
export class Outbox {
  constructor() {
    this.queue = []
    this.sent = []
  }

  /** Read keys to leave out of the lists: waiting or sent and not yet gone from the board. */
  hidden() {
    return hiddenKeys(this.queue, this.sent)
  }

  /** Waiting actions of one board, for the undo row. */
  waiting(session) {
    return this.queue.filter(q => q.session === session)
  }

  /** Queue an action; it goes out after UNDO_MS unless undo() is called first. `cx` is the caller's own. */
  schedule(cx, session, action) {
    const id = actionFile(Date.now(), Math.random().toString(36).slice(2, 8))
    this.queue = queueAction(this.queue, { id, session, action, now: Date.now() })
    cx.timer.after(UNDO_MS + 50, cx => this.flush(cx))
    return id
  }

  undo(id) {
    this.queue = cancelAction(this.queue, id)
  }

  flush(cx) {
    const { due, rest } = takeDue(this.queue, Date.now())
    this.queue = rest
    if (!due.length) return
    cx.spawn(async cx => {
      for (const q of due) {
        try {
          await send(q.session, q.action, q.id)
          this.sent.push({ id: q.id, session: q.session, key: q.key })
        } catch (e) {
          notify({ title: 'Could not send', body: String(e?.message ?? e), level: 'error' })
        }
      }
      cx.notify()
    })
  }

  /** Call when the boards change: forget what the boards settled and report failures. Returns true when anything changed. */
  settle(boards) {
    const { sent, failed } = settleSent(this.sent, boards)
    const changed = sent.length !== this.sent.length
    this.sent = sent
    for (const f of failed) notify({ title: 'Action failed', body: f.message, level: 'error' })
    return changed
  }
}
