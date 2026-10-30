// The mod's logic, with no gpui-kit or herdr imports so node can test it (app/test).

/** The board id (the session id) for a path the folder watcher reports, or null for anything else
 *  (a .tmp file, a file in <session>.actions/, another folder). */
export function boardId(dir, path) {
  const base = dir.replace(/\/+$/, '')
  if (!path.startsWith(`${base}/`)) return null
  const rest = path.slice(base.length + 1)
  const m = /^([^/]+)\.json$/.exec(rest)
  return m ? m[1] : null
}

/** The boards after one file changed. `text` is the file's new content, or null when it is gone.
 *  A file that does not parse keeps the last good copy; a removed file drops the board. */
export function applyFile(boards, id, text) {
  const next = { ...boards }
  if (text === null || text === undefined) {
    delete next[id]
    return next
  }
  try {
    const board = JSON.parse(text)
    if (!board || typeof board !== 'object' || Array.isArray(board)) return boards
    next[id] = board
    return next
  } catch {
    return boards
  }
}

/** The value of one label on a terminal; core terminals carry `labels` as an object (`labels["herdr.space"]`). */
export function labelOf(terminal, key) {
  const labels = terminal?.labels
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return null
  const v = labels[key]
  return v === undefined || v === null ? null : String(v)
}

const live = t => t && t.state === 'live' && t.program?.agent === true

function choose(candidates, last) {
  if (candidates.length === 0) return null
  const kept = last && candidates.find(b => b.session === last.session)
  if (kept) return kept
  return [...candidates].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || String(a.session).localeCompare(String(b.session)))[0]
}

/**
 * Which board the pin bar and strip show now.
 *   boards    every board read, an array
 *   terminals terminals() from herdr
 *   focus     focused() from herdr
 *   last      the pick map {space: session} returned by the last call, or null
 * Returns {board, via, pick}: via is 2, 3, 4 or null; `pick` is the map to pass as `last` next time.
 *
 * Several boards can match (a /clear or resume leaves two session files for one terminal, a plain `claude`
 * started by hand in a coordinator's terminal inherits its HC_TERMINAL_ID and writes a board of its own, and a
 * space can hold two coordinators). The board shown in a space stays shown, whatever rule found it, while its
 * file exists and still matches; otherwise the newest `at` wins, and equal ones go by session id.
 * Without that, boards rewritten every 3 s would swap places on every write.
 */
export function resolveBoard(boards, terminals, focus, last = null) {
  const picks = last ?? {}
  const byAddress = new Map((terminals ?? []).map(t => [t.address, t]))
  // 1. A board counts only while its coordinator terminal is live and runs an agent; boards without the field are ignored.
  const alive = (boards ?? []).filter(b => {
    const address = b?.coordinator?.terminal
    return typeof address === 'string' && live(byAddress.get(address))
  })
  const none = { board: null, via: null, pick: picks }
  if (!focus) return none
  const space = focus.space ?? null
  const remembered = space === null ? null : { session: picks[space] }
  const found = (board, via) => ({ board, via, pick: space === null ? picks : { ...picks, [space]: board.session } })

  // 2. The focused terminal is a board's coordinator.
  if (focus.terminal) {
    const board = choose(
      alive.filter(b => b.coordinator.terminal === focus.terminal),
      remembered,
    )
    if (board) return found(board, 2)
    // 3. The focused terminal is one of a board's workers, by name.
    const name = byAddress.get(focus.terminal)?.name
    if (name) {
      const worker = choose(
        alive.filter(b => (b.workers ?? []).some(w => w.name === name)),
        remembered,
      )
      if (worker) return found(worker, 3)
    }
  }

  // 4. A board whose coordinator sits in the focused space.
  if (space) {
    const inSpace = alive.filter(b => labelOf(byAddress.get(b.coordinator.terminal), 'herdr.space') === space)
    const board = choose(inSpace, remembered)
    if (board) return found(board, 4)
  }
  // 5. Nothing.
  return none
}

/** Open items on a board: needs still waiting for the owner. */
export function openNeeds(board) {
  return (board?.needs ?? []).filter(n => n.isOpen === true)
}

/** The one line the pin bar and strip draw in this slice: `<cwd> · N open`; empty without a board. */
export function debugLine(board) {
  if (!board) return ''
  return `${board.cwd ?? ''} · ${openNeeds(board).length} open`
}

// ---- Pin bar (S4) ----

/** The key the read marks use: one per board and item. */
export const readKey = (session, key) => `${session}:${key}`

/** How long Done × waits for undo before the action file is written, ms. */
export const UNDO_MS = 5000

function textParts(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  return { first: lines[0] ?? '', rest: lines.slice(1).join(' ') }
}

/**
 * The pins on a board: open items of kind `know`, in board order.
 *   read    {"<session>:<key>": true}
 *   hidden  a Set of read keys to leave out (a Done × waiting to be sent, or sent and not yet gone from the board)
 * Fields from #83/#84 are used when present: title (else the first line of text, else the key), summary (else, with a
 * title, the text; without one, the rest of the text after its first line), tag, who (`from`).
 */
export function pins(board, read = {}, hidden = new Set()) {
  if (!board) return []
  return (board.needs ?? [])
    .filter(n => n.kind === 'know' && n.isOpen === true)
    .map(n => {
      const id = readKey(board.session, n.key)
      const { first, rest } = textParts(n.text)
      const title = (typeof n.title === 'string' && n.title.trim()) || first || n.key
      const hasTitle = typeof n.title === 'string' && n.title.trim() !== ''
      const summary = (typeof n.summary === 'string' && n.summary.trim()) || (hasTitle ? [first, rest].filter(Boolean).join(' ') : rest)
      return {
        id,
        key: n.key,
        title,
        summary,
        tag: typeof n.tag === 'string' && n.tag.trim() ? n.tag.trim() : null,
        who: n.from ?? '',
        at: typeof n.at === 'number' ? n.at : 0,
        unread: read?.[id] !== true,
      }
    })
    .filter(p => !hidden.has(p.id))
}

/** The newest of some pins; the later one in board order when `at` is equal. */
export function newestPin(list) {
  let best = null
  for (const p of list) if (!best || p.at >= best.at) best = p
  return best
}

/** The pin the full bar shows: the one picked by the owner (`sel`, an id) while it exists, else the newest unread, else null. */
export function currentPin(list, sel = null) {
  const picked = sel && list.find(p => p.id === sel)
  if (picked) return picked
  return newestPin(list.filter(p => p.unread))
}

/** 'empty' (no pins: the row stays, blank), 'full' (a pin to show) or 'slim' (pins, all read). */
export function pinbarMode(list, sel = null) {
  if (list.length === 0) return 'empty'
  return currentPin(list, sel) ? 'full' : 'slim'
}

/** The slim line: `N pins · nothing new · last: <title>`. */
export function slimLine(list) {
  const last = newestPin(list)
  if (!last) return ''
  return `${list.length} ${list.length === 1 ? 'pin' : 'pins'} · nothing new · last: ${last.title}`
}

/** The segments: one per pin, in board order, with the kind the bar draws (current, unread, read). */
export function segments(list, current) {
  return list.map(p => ({ id: p.id, kind: current && p.id === current.id ? 'current' : p.unread ? 'unread' : 'read' }))
}

/** Pin ids in `list` that were not in `prev` (a Set, or null on the first call, when nothing is new). */
export function newPinIds(prev, list) {
  if (!prev) return []
  return list.map(p => p.id).filter(id => !prev.has(id))
}

/** `5m`, `2h`, `3d` from a time in ms; `now` under a minute; empty without a time. */
export function ageText(at, now) {
  if (!at || !now || now < at) return at ? 'now' : ''
  const s = Math.floor((now - at) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** The read marks without entries of sessions that have no board; the same object when nothing goes. */
export function pruneRead(read, boards) {
  const live = new Set((boards ?? []).map(b => b.session))
  const out = {}
  let dropped = false
  for (const [k, v] of Object.entries(read ?? {})) {
    const session = k.slice(0, Math.max(k.lastIndexOf(':'), 0))
    if (live.has(session)) out[k] = v
    else dropped = true
  }
  return dropped ? out : read
}

/** The read marks with one more. */
export const markRead = (read, id) => (read?.[id] === true ? read : { ...(read ?? {}), [id]: true })

// ---- Sending (S4): an action waits UNDO_MS in the mod, then is written to the board's actions folder ----

/** `{action:"done", key}`: an open to-do is done; an open know is dismissed. */
export const doneAction = key => ({ action: 'done', key })

/** A file name that sorts by time: `<ms>-<random>.json`. */
export const actionFile = (ms, rand) => `${String(ms).padStart(13, '0')}-${rand}.json`

/** The queue with one more action that goes out at now + UNDO_MS. `id` is its action file name. */
export function queueAction(queue, { id, session, action, now }) {
  return [...queue, { id, session, action, key: action.key ?? null, due: now + UNDO_MS }]
}

/** The queue without the action (undo). */
export const cancelAction = (queue, id) => queue.filter(q => q.id !== id)

/** {due, rest}: what is ready to send at `now`, in queue order, and what keeps waiting. */
export function takeDue(queue, now) {
  return { due: queue.filter(q => q.due <= now), rest: queue.filter(q => q.due > now) }
}

/** Read keys of items whose action waits or was sent and still shows open on the board. */
export function hiddenKeys(queue, sent) {
  return new Set([...queue, ...sent].filter(q => q.key).map(q => readKey(q.session, q.key)))
}

/**
 * Sent actions after the boards moved on: {sent, failed}. One is settled (dropped) when its board is gone, when the board
 * reports its outcome, or when its item is no longer open. A reported `ok:false` goes to `failed` with the message.
 */
export function settleSent(sent, boards) {
  const keep = []
  const failed = []
  for (const s of sent) {
    const board = (boards ?? []).find(b => b.session === s.session)
    if (!board) continue
    const outcome = (board.actions ?? []).find(a => a.id === s.id)
    if (outcome) {
      if (outcome.ok === false) failed.push({ id: s.id, message: outcome.message ?? '' })
      continue
    }
    const open = (board.needs ?? []).some(n => n.key === s.key && n.isOpen === true)
    if (open) keep.push(s)
  }
  return { sent: keep, failed }
}
