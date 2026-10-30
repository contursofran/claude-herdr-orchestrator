// The mod's logic, with no gpui-kit or herdr imports so node can test it (app/test).

/** True when the watcher's `paths` include the board file of `session` (either spelling of the folder: /tmp may be
 *  reported as /private/tmp, so only the file name is compared). Files in <session>.actions/ and .tmp files do not count. */
export function touchesBoard(session, paths) {
  return (paths ?? []).some(p => String(p).endsWith(`/${session}.json`))
}

/** The board id (the session id) for a path the folder watcher reports, or null for anything else
 *  (a .tmp file, a file in <session>.actions/, another folder). */
export function boardId(dir, path) {
  const base = dir.replace(/\/+$/, '')
  if (!path.startsWith(`${base}/`)) return null
  const rest = path.slice(base.length + 1)
  const m = /^([^/]+)\.json$/.exec(rest)
  return m ? m[1] : null
}

/** boardId against several spellings of the same folder (the one asked for and its resolved path,
 *  as the watcher may report either when the folder is reached through a link such as /tmp). */
export function boardIdIn(dirs, path) {
  for (const dir of dirs) {
    const id = boardId(dir, path)
    if (id) return id
  }
  return null
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

/** What one copy of the mod draws from the boards, as text: a board change that leaves this the same needs no redraw, and every
 *  redraw of a mod redraws the whole window (#151). `at` is left out everywhere: it says only that the file was written.
 *  The agents list draws coordinators and parked workers; the pop-up its own board; the sheet task rows too (the tasks waiting on
 *  an item), only while open (`open`, its hrd.sheet). The pin bar, strip and card draw no task rows, but the strip sizes the pop-up from how many there are, so the rows'
 *  keys count and their text (a minute clock) does not. */
export function drawnKey(role, boards, session, open = null) {
  const list = boards ?? []
  if (role === 'agents')
    return JSON.stringify(
      list.map(b => [b.session, b.coordinator?.terminal, (b.workers ?? []).map(w => [w?.name, w?.state, w?.note, w?.since])]),
    )
  if (role === 'board') {
    const { at: _at, ...board } = list.find(b => b.session === session) ?? {}
    return JSON.stringify(board)
  }
  if (role === 'pins')
    return JSON.stringify(
      stillOpen(
        open ?? [],
        list.find(b => b.session === session),
      ).map(p => p.id),
    )
  if (role === 'sheet') return open ? JSON.stringify(list.map(({ at: _at, ...b }) => b)) : ''
  return JSON.stringify(list.map(({ at: _at, tasks, ...b }) => ({ ...b, rows: (tasks ?? []).map(t => [t?.key, t?.joined]) })))
}

/** The value of one label on a terminal; core terminals carry `labels` as an object (`labels["herdr.space"]`). */
export function labelOf(terminal, key) {
  const labels = terminal?.labels
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return null
  const v = labels[key]
  return v === undefined || v === null ? null : String(v)
}

// A terminal the coordinator started as a worker is never a coordinator, whatever a leftover board says
// (terminal ids may restart with the core); terminals() carries the label (seen in the app).
const live = t => t && t.state === 'live' && t.program?.agent === true && labelOf(t, 'herdr-agents.role') !== 'worker'

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
 * Without that, boards rewritten side by side would swap places on every write.
 */
export function resolveBoard(boards, terminals, focus, last = null) {
  const picks = last ?? {}
  const byAddress = new Map((terminals ?? []).map(t => [t.address, t]))
  // 1. A board counts only while its coordinator terminal is live and runs an agent; boards without the field are ignored.
  const alive = aliveBoards(boards, terminals)
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
      const given = typeof n.title === 'string' ? n.title.trim() : ''
      // The plugin sends title = text today (#84): a title equal to the whole text counts as no title.
      const hasTitle = given !== '' && given !== String(n.text ?? '').trim()
      const title = (hasTitle ? textParts(given).first : first) || n.key
      const summary = (typeof n.summary === 'string' && n.summary.trim()) || (hasTitle ? [first, rest].filter(Boolean).join(' ') : rest)
      return {
        id,
        key: n.key,
        title,
        summary,
        tag: typeof n.tag === 'string' && n.tag.trim() ? n.tag.trim() : null,
        who: n.from ?? '',
        text: String(n.text ?? '').trim(),
        at: typeof n.at === 'number' ? n.at : 0,
        unread: read?.[id] !== true,
      }
    })
    .filter(p => !hidden.has(p.id))
}

/** Those of `list` (an overlay's pins) still open on `board`. With no board read yet, all of them. */
export function stillOpen(list, board) {
  if (!board) return list
  const open = new Set(pins(board).map(p => p.id))
  return list.filter(p => open.has(p.id))
}

/** Whether a pins overlay has nothing left to show: its pin, or every pin, was resolved or Done. */
export function pinsOverlayEmpty({ view, id, list = [] }, board, gone = new Set()) {
  const left = stillOpen(list, board).filter(p => !gone.has(p.id))
  return view === 'panel' ? !left.some(p => p.id === id) : left.length === 0
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

/** 'empty' (no pins: the row stays, with a quiet line), 'full' (a pin to show) or 'slim' (pins, all read, or `slim`
 *  asked for while the sheet is open: the row keeps its height). */
export function pinbarMode(list, sel = null, slim = false) {
  if (list.length === 0) return 'empty'
  if (slim) return 'slim'
  return currentPin(list, sel) ? 'full' : 'slim'
}

/** The slim line: `N pins · nothing new · last: <title>`; with `showNew` (the sheet forced the row slim) unread pins are
 *  counted instead: `N pins · M new · last: <title>`. */
export function slimLine(list, showNew = false) {
  const last = newestPin(list)
  if (!last) return ''
  const unread = showNew ? list.filter(p => p.unread).length : 0
  return `${list.length} ${list.length === 1 ? 'pin' : 'pins'} · ${unread ? `${unread} new` : 'nothing new'} · last: ${last.title}`
}

/** The segments: one per pin, in board order, with the kind the bar draws (current, unread, read). */
export function segments(list, current) {
  return list.map(p => ({ id: p.id, title: p.title, kind: current && p.id === current.id ? 'current' : p.unread ? 'unread' : 'read' }))
}

/** The id of the pin `dir` (1 next, -1 previous) from `current`, wrapping round; null with fewer than 2 pins. */
export function stepPin(list, current, dir) {
  if (list.length < 2) return null
  const at = Math.max(
    0,
    list.findIndex(p => p.id === current?.id),
  )
  return list[(at + dir + list.length) % list.length].id
}

/**
 * A step by key or button from what the row last showed: `shown` is {mode, list, current}. Does nothing (null) unless the
 * row shows a full or slim pin bar. From the slim row it starts at the newest pin, the one a click on the row opens.
 * Otherwise {sel, shown}: the pin moved to (marked read through `mark`), and `shown` as the row will be drawn next,
 * so a second press before the redraw moves on again.
 */
export function keyStep(shown, dir, mark) {
  if (!shown || (shown.mode !== 'full' && shown.mode !== 'slim')) return null
  const from = shown.mode === 'slim' ? newestPin(shown.list) : shown.current
  const sel = stepPin(shown.list, from, dir)
  if (!sel) return null
  mark(sel)
  return { sel, shown: { ...shown, mode: 'full', current: shown.list.find(p => p.id === sel) } }
}

/** 1 for `herdr-agents.nextpin`, -1 for `herdr-agents.prevpin`, else null. */
export function pinStepDir(name) {
  const m = /(?:^|\.)(next|prev)pin$/.exec(String(name))
  return m ? (m[1] === 'next' ? 1 : -1) : null
}

/** The empty row's line: `No pins`, then `· 2 working` from the board's summary (zeros and missing left out). */
export function emptyLine(board) {
  const busy = board?.summary?.busy
  return typeof busy === 'number' && busy > 0 ? `No pins · ${busy} working` : 'No pins'
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

/** How often a copy that draws ages looks at them. */
export const AGE_TICK_MS = 60_000

/** The times behind the ages a copy has on screen; [] when it shows none (a closed card or sheet, no pin, other roles).
 *   boards  every board read       open  hrd.open or hrd.sheet, for the card and the sheet
 *   pinAt   the pin bar's current pin's time       pins  props() of a pins copy       gone  the pins it has hidden */
export function agedTimes(role, { boards = [], open = null, pinAt = null, pins = null, gone = new Set() } = {}) {
  const known = at => (at ? [at] : [])
  if (role === 'pinbar') return known(pinAt)
  if (role === 'pins') {
    const list = (pins?.list ?? []).filter(p => !gone.has(p.id))
    return (pins?.view === 'panel' ? list.filter(p => p.id === pins.id) : list).flatMap(p => known(p.at))
  }
  if ((role === 'card' || role === 'sheet') && open) {
    const board = boards.find(b => b.session === open.session)
    // The sheet stays on an answered item until the owner closes it; the card only draws open ones.
    const needs = role === 'sheet' ? board?.needs : board && openNeeds(board)
    return known(needs?.find(n => n.key === open.key)?.at)
  }
  return []
}

/** Asks for a redraw only when an age on screen would read differently: `drawn` after each draw, `moved` on each tick. */
export class AgeClock {
  constructor() {
    this.key = ''
  }

  drawn(times, now) {
    this.key = times.map(at => ageText(at, now)).join()
  }

  moved(times, now) {
    const before = this.key
    this.drawn(times, now)
    return this.key !== before
  }
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

/** How long a sent action keeps its item hidden while the board shows no outcome (the plugin may have stopped), ms. */
export const SENT_HIDE_MS = 60000

/** The sent actions that still count: with `now`, those sent less than SENT_HIDE_MS ago (no `now`, all of them). */
export const liveSent = (sent, now = null) => sent.filter(s => !now || s.at === undefined || now - s.at < SENT_HIDE_MS)

/**
 * Read keys of items whose action waits or was sent and still shows open on the board. A sent action older than
 * SENT_HIDE_MS (when `now` is given) no longer hides its item.
 */
export function hiddenKeys(queue, sent, now = null) {
  const live = liveSent(sent, now)
  return new Set([...queue, ...live].filter(q => q.key).map(q => readKey(q.session, q.key)))
}

/**
 * Sent actions after the boards moved on: {sent, failed}. One is settled (dropped) when its board is gone, when the board
 * reports its outcome, or when its item is no longer open. A reported `ok:false` goes to `failed` with the message,
 * unless it is a Done on an item the board shows closed: the plugin refuses that, and what the owner asked for is true.
 */
export function settleSent(sent, boards) {
  const keep = []
  const failed = []
  for (const s of sent) {
    const board = (boards ?? []).find(b => b.session === s.session)
    if (!board) continue
    const open = (board.needs ?? []).some(n => n.key === s.key && n.isOpen === true)
    const outcome = (board.actions ?? []).find(a => a.id === s.id)
    if (outcome) {
      if (outcome.ok === false && (s.action?.action !== 'done' || open)) failed.push({ id: s.id, message: outcome.message ?? '' })
      continue
    }
    if (open) keep.push(s)
  }
  return { sent: keep, failed }
}

/** The pin bar's memory between draws: the picked pin, the board it was on, the pins seen, the pins already flashed. */
export const newBarState = () => ({ session: null, sel: null, seen: null, flashed: new Set() })

/**
 * One draw of the pin bar, pure. `waiting` are the queued actions ({id, session, key}) and `hidden` the keys to leave out.
 * Returns {state, view, list, flashStart}: the next state, the data pinbar() draws (without handlers), and the pin id
 * whose flash starts now (once per pin), else null.
 */
export function deriveBar(prev, board, { read = {}, hidden = new Set(), waiting = [], now = 0, slim = false } = {}) {
  if (!board) return { state: prev, view: { mode: 'empty', waiting: [] }, list: [], flashStart: null }
  const list = pins(board, read, hidden)
  let { session, sel, seen, flashed } = prev
  if (session !== board.session) {
    session = board.session
    sel = null
    seen = null
  }
  if (newPinIds(seen, list).length) sel = null // a new pin takes the bar back from a picked one
  seen = new Set(list.map(p => p.id))

  const mode = pinbarMode(list, sel, slim)
  const current = currentPin(list, sel)
  let flashStart = null
  if (mode === 'full' && current.unread && !flashed.has(current.id)) {
    flashStart = current.id
    flashed = new Set(flashed).add(current.id)
  }
  const all = pins(board, read)
  return {
    state: { session, sel, seen, flashed },
    list,
    flashStart,
    view: {
      mode,
      current,
      many: list.length > 1,
      empty: emptyLine(board),
      segments: segments(list, current),
      slim: slimLine(list, slim),
      meta: current ? [current.who, ageText(current.at, now)].filter(Boolean).join(' · ') : '',
      waiting: waiting
        .filter(q => q.session === board.session)
        .map(q => ({ id: q.id, title: all.find(p => p.key === q.key)?.title ?? q.key })),
    },
  }
}

// --- S12: the agents list's Orchestrators section ---

/** Rule 1 of the resolver: the boards whose coordinator terminal exists, is live and runs an agent
 *  (boards without the field are ignored). `terminals` is terminals() from herdr. */
export function aliveBoards(boards, terminals) {
  const byAddress = new Map((terminals ?? []).map(t => [t.address, t]))
  return (boards ?? []).filter(b => {
    const address = b?.coordinator?.terminal
    return typeof address === 'string' && live(byAddress.get(address))
  })
}

/**
 * Splits the agents list into the orchestrators (the first section) and the rest.
 *   agents    agents() from herdr, in the order the list shows them
 *   boards    every board read
 *   terminals terminals() from herdr
 * An agent is an orchestrator when its `address` equals `coordinator.terminal` of a board that passes rule 1.
 * Both use the core's address form: `t4` for a local terminal, `machine/t4` for another machine's, so a board
 * (written by a local session) matches local agents only. Order inside is the list's own, never by state.
 * Returns {orchestrators}: the section's agents, in the order given.
 */
export function orchestratorSection(agents, boards, terminals) {
  const coordinators = new Set(aliveBoards(boards, terminals).map(b => b.coordinator.terminal))
  return { orchestrators: (agents ?? []).filter(a => coordinators.has(a.address)) }
}

/**
 * The order the agents list draws and hands to setAgentOrder: orchestrators, then pinned, then the rest.
 *   sorted    the agents in the sort view's order (the order of pinned and rest)
 *   boards, terminals   as for orchestratorSection
 *   pins      the pinned addresses, in pin order
 *   natural   agents() order (space, tab, pane), the order of the orchestrators; defaults to `sorted`
 * An orchestrator is in the first part only, pinned or not, always in `natural` order so rows don't jump when
 * a state changes; pins that match no agent are skipped.
 * Returns {orchestrators, pinned, rest, list}; `list` is the three joined.
 */
export function listOrder(sorted, boards, terminals, pins = [], natural = sorted) {
  const { orchestrators } = orchestratorSection(natural, boards, terminals)
  const orch = new Set(orchestrators.map(a => a.address))
  const others = (sorted ?? []).filter(a => !orch.has(a.address))
  const pinned = pins.map(p => others.find(a => a.address === p)).filter(Boolean)
  const rest = others.filter(a => !pins.includes(a.address))
  return { orchestrators, pinned, rest, list: [...orchestrators, ...pinned, ...rest] }
}

/**
 * What a worker parked on WAIT.json waits for, for the agents list: what the board row's note says after the elapsed time ("02:13 · PR checks" gives "PR checks"), or null.
 * `address` is the agent's terminal; the worker is found by its terminal's name on any live board. Only a row whose
 * state is `waiting` counts, so a finished or blocked worker shows nothing here.
 */
export function parkedNote(boards, terminals, address) {
  const name = (terminals ?? []).find(t => t.address === address)?.name
  if (!name) return null
  for (const b of boards ?? []) {
    const w = (b.workers ?? []).find(x => x?.name === name && x.state === 'waiting')
    if (w) {
      const line = String(w.note ?? '')
        .split('\n')[0]
        .trim()
      // Only a board from before `since` has a clock in front of its note.
      return (typeof w.since === 'number' ? line : line.replace(/^(\d{1,2}:\d{2}|\d+h\d{2}) · /, '')) || 'waiting'
    }
  }
  return null
}

// ---- S3: the strip --------------------------------------------------------------------------------

/** First line of a text, trimmed. */
const firstLine = text =>
  String(text ?? '')
    .split('\n')[0]
    .trim()

/**
 * What the strip draws, in order: workers that are blocked, then open asks, then open dos, each in board order.
 * (`know` items belong to the pin bar.) An item is {key, id, kind: 'blocked' | 'ask' | 'do', label, terminal?}:
 * `id` is the bold part of the tab (the worker's name, or D7 / T12), `label` the short text after it, `key` is
 * unique on the board.
 */
export function stripItems(board) {
  if (!board) return []
  const blocked = (board.workers ?? [])
    .filter(w => w?.state === 'blocked')
    .map(w => ({ key: `w:${w.name}`, id: w.name, kind: 'blocked', label: firstLine(w.note) || 'stuck' }))
  const open = kind =>
    openNeeds(board)
      .filter(n => n.kind === kind)
      .map(n => ({ key: n.key, id: n.key, kind: kind === 'ask' ? 'ask' : 'do', label: firstLine(n.title) || firstLine(n.text) }))
  return [...blocked, ...open('ask'), ...open('do')]
}

/** The tab a `pick1`..`pick6` key means: the Nth item, or null (a 7th and later are reached by scrolling). */
export function pickAt(items, n) {
  if (!Number.isInteger(n) || n < 1 || n > 6) return null
  return items[n - 1] ?? null
}

/** How many workers are working, waiting and blocked. */
export function counts(board) {
  const out = { working: 0, waiting: 0, blocked: 0 }
  for (const w of board?.workers ?? []) if (w?.state in out) out[w.state] += 1
  return out
}

/**
 * Open items on the other live boards, for `N in other ›`: {count, terminal}. A terminal counts once, by the board
 * that is newest there (a /clear or a stray session leaves a second file for one terminal), and the shown board's
 * own terminal is not "other". `terminal` is the coordinator `N in other ›` goes to: the next other terminal with
 * open items after the shown one, in address order, wrapping (null when none). It keeps no state: the shown board
 * follows focus, so each click moves on to the next.
 */
export function otherCount(boards, terminals, current) {
  const byAddress = new Map((terminals ?? []).map(t => [t.address, t]))
  const mine = current?.coordinator?.terminal
  const newest = new Map()
  for (const b of boards ?? []) {
    const address = b?.coordinator?.terminal
    if (typeof address !== 'string' || address === mine || !live(byAddress.get(address))) continue
    const had = newest.get(address)
    if (!had || (b.at ?? 0) > (had.at ?? 0) || ((b.at ?? 0) === (had.at ?? 0) && String(b.session) < String(had.session))) {
      newest.set(address, b)
    }
  }
  const others = [...newest.entries()]
    .map(([address, board]) => ({ address, n: stripItems(board).length }))
    .filter(o => o.n > 0)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
  const next = others.find(o => typeof mine === 'string' && o.address > mine) ?? others[0]
  return { count: others.reduce((sum, o) => sum + o.n, 0), terminal: next?.address ?? null }
}

/** A new item's tab flashes for 4 swings of 0.9 s. */
export const FLASH_MS = 3600

/** Whether the tab for `key` is flashing: it first showed up at `firstSeenAt` (ms), now is `now`. */
export function flashing(key, firstSeenAt, now) {
  if (!key || typeof firstSeenAt !== 'number') return false
  const age = now - firstSeenAt
  return age >= 0 && age < FLASH_MS
}

/**
 * When each item was first seen, as {"<session>:<key>": ms}. `known` is the last result, or null for the first
 * load: what is there at the start is stamped 0 (long ago), so only items that arrive later flash. Only a new
 * blocked worker gets a time; asks and dos are stamped 0, so they never flash or turn unseen. Items that are gone
 * are dropped.
 */
export function observeArrivals(known, boards, now) {
  const next = {}
  for (const b of boards ?? []) {
    for (const item of stripItems(b)) {
      const id = `${b.session}:${item.key}`
      next[id] = known === null || known === undefined ? 0 : (known[id] ?? (item.kind === 'blocked' ? now : 0))
    }
  }
  return next
}

/** After the flash an item stays in a static "unseen" style until the owner selects it. */
export function isUnseen(id, known, seen) {
  return (known?.[id] ?? 0) > 0 && !seen?.has(id)
}

/** Whether any stamp in `known` is still flashing at `now`. */
export function anyFlashing(known, now) {
  return Object.entries(known ?? {}).some(([id, at]) => flashing(id, at, now))
}

/** The 1..6 a command name means (`herdr-agents.pick3` -> 3), or null. */
export function pickNumber(name) {
  const m = /(?:^|\.)pick([1-6])$/.exec(String(name))
  return m ? Number(m[1]) : null
}

/**
 * The pick after choosing `key` on `session`. `current` is the pick now ({session, key} or null). A click
 * (`toggle`) on the selected tab deselects it; a key never does.
 */
export function nextPick(current, session, key, toggle) {
  if (toggle && current?.session === session && current?.key === key) return null
  return { session, key }
}

// --- S5: the answer card, a floating block over the terminal ---

/** The `answer` action file body for one decision. */
export const answerAction = (key, answer) => ({ action: 'answer', key, answer })

/**
 * What the card draws for item `key` of `board`, pure. `queue` are actions waiting out their undo time, `sent` the ones
 * sent and not yet settled (both with {id, session, key, action}); `terminals` is terminals(), for a blocked worker's tab.
 * face: `resolved` when an action for it waits or went out, or when it is no longer open on the board;
 * `blocked` for a worker (key `w:<name>`); `ask` and `do` for open needs.
 */
export function cardView(board, key, { queue = [], sent = [], terminals = [], now = 0 } = {}) {
  if (!board || !key) return null
  const mine = q => q.session === board.session && q.key === key
  const waiting = queue.filter(mine).pop()
  const out = waiting ?? liveSent(sent, now).filter(mine).pop()
  const need = openNeeds(board).find(n => n.key === key && (n.kind === 'ask' || n.kind === 'do'))
  const named = (board.needs ?? []).find(n => n.key === key)
  const worker = key.startsWith('w:') ? (board.workers ?? []).find(w => w.name === key.slice(2)) : null
  const title = firstLine(need?.title ?? named?.title) || firstLine(need?.text ?? named?.text) || (worker ? firstLine(worker.note) : '')
  if (out) {
    const answered = out.action?.action === 'answer'
    return {
      face: 'resolved',
      key,
      id: worker ? worker.name : key,
      title,
      verb: answered ? 'answer' : 'done',
      detail: answered ? out.action.answer : '',
      sent: !waiting,
      undoId: waiting ? waiting.id : null,
    }
  }
  if (worker && worker.state === 'blocked') {
    return {
      face: 'blocked',
      key,
      id: worker.name,
      title: firstLine(worker.note) || 'stuck',
      terminal: (terminals ?? []).find(t => t.name === worker.name)?.address ?? null,
    }
  }
  if (!need) return { face: 'resolved', key, id: worker ? worker.name : key, title, verb: 'closed', detail: '', sent: true, undoId: null }
  const options = (Array.isArray(need.options) ? need.options : []).filter(o => typeof o === 'string')
  const impacts = Array.isArray(need.impacts) ? need.impacts.map(i => (typeof i === 'string' ? i : '')) : []
  return {
    face: need.kind,
    key,
    id: key,
    title,
    text: String(need.text ?? ''),
    options,
    recommended: Number.isInteger(need.recommended) ? need.recommended : -1,
    impacts,
    url: typeof need.url === 'string' && need.url ? need.url : null,
    meta: [need.from, ageText(need.at, now)].filter(Boolean).join(' · '),
  }
}

/**
 * What the card draws for `open` (shared "hrd.open": {session, key}) among `boards`: null when nothing is open, the item's
 * view, or face `gone` when its board is no longer there (the session ended, or the app restarted). `gone` is still
 * drawn, with a way to close: a shown panel the owner cannot close would leave the terminal short for good.
 */
export function cardFor(boards, open, ctx = {}) {
  if (!open) return null
  const board = (boards ?? []).find(b => b.session === open.session)
  const view = board ? cardView(board, open.key, ctx) : null
  if (view) return view
  return { face: 'gone', key: open.key, id: open.key, title: 'This board has ended' }
}

/** The line under the keys: which keys answer, and that any other one closes the card and is lost. */
export function cardHint(face, { options = 0, url = false } = {}) {
  const n = Math.min(Math.max(Number(options) || 0, 0), 3)
  if (face === 'ask' && n) return `${n === 1 ? '1' : `1-${n}`} answers · esc or any other key closes, and that key is lost`
  if (face === 'do') return `${url ? '1 done · 2 opens the link' : '1 done'} · esc or any other key closes, and that key is lost`
  return 'esc or any key closes'
}

/** The open item after `key` on the strip's list, wrapping, leaving out items whose action waits or went out
 *  (`hidden`, a Set of read keys). null when no other is left. */
export function nextItem(board, key, hidden = new Set()) {
  const items = stripItems(board).filter(i => i.key === key || !hidden.has(readKey(board.session, i.key)))
  const at = items.findIndex(i => i.key === key)
  const rest = at < 0 ? items : [...items.slice(at + 1), ...items.slice(0, at)]
  return rest.find(i => i.key !== key) ?? null
}

const MODIFIER_KEYS = new Set(['shift', 'control', 'ctrl', 'alt', 'option', 'cmd', 'meta', 'super', 'fn', 'capslock'])

/**
 * What a key does while the card has the keyboard (`keystroke` is the event's whole chord, e.g. `1` or `ctrl-1`).
 * `1`-`3` answer (a decision) or press Done / Open link (a to-do), Esc closes, a modifier alone is ignored, and any
 * other key closes the card and is lost. A key held down (`held`) is ignored, so an answer is not followed by a close.
 * Returns {type: 'answer', index} | {type: 'done'} | {type: 'link'} | {type: 'close'} | {type: 'ignore'}.
 */
export function cardKeyAction(face, keystroke, { options = 0, url = false, held = false } = {}) {
  if (held) return { type: 'ignore' }
  // The whole chord (`keystroke`), not the bare key: ctrl-1 or alt-1 is not `1`.
  const k = String(keystroke ?? '').toLowerCase()
  if (MODIFIER_KEYS.has(k)) return { type: 'ignore' }
  if (k === 'escape') return { type: 'close' }
  const n = /^[1-3]$/.test(k) ? Number(k) : 0
  if (face === 'ask' && n && n <= options) return { type: 'answer', index: n - 1 }
  if (face === 'do' && n === 1) return { type: 'done' }
  if (face === 'do' && n === 2 && url) return { type: 'link' }
  return { type: 'close' }
}

/**
 * The shared("hrd.open") value after opening `key` on `session`: keeps the terminal to give back, else takes `back`.
 * `seq` is a counter bumped on every open, so the card takes the keyboard on each open, even of the same item.
 */
export const openState = (current, session, key, back, seq = 0, space = null) => ({
  session,
  key,
  back: current?.back ?? back ?? null,
  space: current?.back ? (current.space ?? null) : space,
  seq,
})

/** Whether closing the card may hand the keyboard to `open.back`: only while the owner is still in the space it was
 *  opened from (focusing it from another space would jump there). */
export const canRefocus = (open, space) => Boolean(open?.back) && (open.space ?? null) === (space ?? null)

/** Which terminal gets the keyboard when the pop-up goes (`from`: {back, space} saved at open), or null. Null when a row
 *  already chose (`leaving`), in another space, or when the owner clicked another terminal to dismiss it. */
export function popupRefocus(from, now, leaving) {
  if (leaving || !canRefocus(from, now?.space)) return null
  return now?.terminal && now.terminal !== from.back ? null : from.back
}

/** The pop-up's keys: Esc closes; a key held down and every other key do nothing. */
export const popupKeyAction = (key, held) => (!held && String(key ?? '').toLowerCase() === 'escape' ? 'close' : 'ignore')

/** A window length in the px a mod writes: the app draws those, and the layout's rows and sidebars, `zoom` times as big,
 *  while `viewport_size` is not scaled. */
export const atZoom = (px, zoom) => Number(px) / (zoom > 0 ? zoom : 1)

/** The card floats over the main block, so it is sized from the window: `CARD_W` at most, and clear of the sidebars
 *  (`SIDE` px each side) when the window is narrow; at most `CARD_MAX_H_PCT`% of the window's height, the rest scrolls.
 *  `viewport` is {width, height}; without one the card keeps its full width and a modest height. */
export const CARD_W = 560
export const CARD_MIN_W = 220
export const CARD_SIDE = 170
export const CARD_MAX_H_PCT = 70
export function cardSize(viewport, zoom = 1) {
  const vw = atZoom(viewport?.width, zoom)
  const vh = atZoom(viewport?.height, zoom)
  const w = vw > 0 ? Math.max(CARD_MIN_W, Math.min(CARD_W, Math.floor(vw - 2 * CARD_SIDE))) : CARD_W
  const maxH = vh > 0 ? Math.floor((vh * CARD_MAX_H_PCT) / 100) : 400
  return { w, maxH }
}

// --- S7: the board pop-up (the work table from `board ▴`) ---

/** The pop-up is this wide; the status bar and the strip are the rows under it. */
export const POPUP_W = 620
export const POPUP_ROW = 26
const POPUP_CHROME = 2 + 10 + 24 + 8 // border, top padding, header row, bottom padding
const POPUP_MAX_ROWS = 12
const STATUS_PX = 28
const STRIP_PX = 34

/** The icon name a stage cell shows (a file in icons/), or null for an empty cell. `ask` is drawn as the white decide disc. */
const STAGE_ICONS = { done: 'done', run: 'working', wait: 'waiting', ask: 'decide', todo: 'do', block: 'blocked' }
export const stageIcon = stage => STAGE_ICONS[stage] ?? null

/**
 * The work rows of the one board, in their slots, top to bottom. A slot whose task joined another row is left out.
 * A row is {key, label, title, who: {text, kind}, stages: [5 icon names or null], item, tab}.
 */
export function workRows(board) {
  return (board?.tasks ?? [])
    .filter(t => t && typeof t === 'object' && !t.joined)
    .map(t => ({
      key: String(t.key),
      label: t.label ?? '',
      title: t.title ?? '',
      who: { text: t.who?.text ?? '', kind: t.who?.kind ?? 'dim' },
      stages: Array.from({ length: 5 }, (_, i) => stageIcon(t.stages?.[i])),
      item: t.item ?? null,
      tab: t.tab ?? null,
    }))
}

/** The Herdr space the board's coordinator runs in (its terminal's `herdr.space` label), or null when unknown. */
export function boardSpace(board, terminals) {
  const t = (terminals ?? []).find(x => x?.address === board?.coordinator?.terminal)
  return labelOf(t, 'herdr.space')
}

/** The project the pop-up names in its header: the last part of the coordinator's folder. */
export function projectName(board) {
  const parts = String(board?.cwd ?? '')
    .split('/')
    .filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/**
 * What a click on a row does. A task whose tab is a live terminal of this board's space: focus it (workers are named by
 * worker only, so two projects can each have a `build-1`). Otherwise, a task with an `item`: open that item's card.
 * Otherwise nothing. {type: 'focus', terminal} | {type: 'card', item} | null. `space` is boardSpace().
 */
export function rowAction(row, terminals, space = null) {
  const t = row?.tab ? (terminals ?? []).find(x => x?.name === row.tab && x.state === 'live' && labelOf(x, 'herdr.space') === space) : null
  if (t) return { type: 'focus', terminal: t.address }
  if (row?.item) return { type: 'card', item: row.item }
  return null
}

/**
 * What opening an overlay does to the others: one at a time. `open` is what is up now ({popup, card, pins, sheet}: booleans).
 * The card and the sheet take the keyboard, so whichever of them is closed for another overlay hands it back (`refocus`).
 * A second open of the same kind replaces the first.
 */
export function overlayPlan(kind, open) {
  const popup = Boolean(open?.popup)
  const card = Boolean(open?.card)
  const pins = Boolean(open?.pins)
  const sheet = Boolean(open?.sheet)
  if (kind === 'card') return { closePopup: popup, closeCard: false, closePins: pins, closeSheet: sheet, refocus: sheet }
  if (kind === 'sheet') return { closePopup: popup, closeCard: card, closePins: pins, closeSheet: false, refocus: card }
  return { closePopup: popup, closeCard: card, closePins: pins, closeSheet: sheet, refocus: card || sheet }
}

/** The action file for the header's wrap up / keep going: `on` is the state to set. */
export const wrapUpAction = on => ({ action: 'wrapUp', on })

/** The header's button: its text and the action it sends (the opposite of what the board has now). */
export function wrapUpButton(board) {
  const on = board?.summary?.wrapUp !== true
  return { text: on ? 'wrap up' : 'keep going', action: wrapUpAction(on) }
}

/** The pop-up's height in px for `n` rows: fixed, because a popup whose root has no size draws nothing. */
export const popupHeight = n => POPUP_CHROME + POPUP_ROW * Math.min(Math.max(n, 1), POPUP_MAX_ROWS)

/** Window coordinates of the pop-up's top left: right aligned, its bottom just above the strip. */
export function popupSpot(viewW, viewH, height) {
  return { x: Math.max(0, viewW - POPUP_W - 8), y: Math.max(0, viewH - STATUS_PX - STRIP_PX - height - 4) }
}

/** Whether a mod command name means "open the board pop-up" (`herdr-agents.board`). */
export const isBoardCommand = name => /(?:^|\.)board$/.test(String(name))

// ---- Sound and notification (S10) ----

/**
 * New `know` and `ask` items on one board. `prevKeys` is the Set this returned last time for the board, or null the first
 * time the board is seen (then nothing is new). Blocked workers are not items here: Herdr sounds for those itself.
 * Returns {keys, fresh}: every open know/ask key now, and the items in it that were not in `prevKeys` ({key, kind, text}).
 */
export function newArrivals(prevKeys, board) {
  const items = openNeeds(board).filter(n => n.kind === 'know' || n.kind === 'ask')
  const keys = new Set(items.map(n => n.key))
  if (!prevKeys) return { keys, fresh: [] }
  const fresh = items
    .filter(n => !prevKeys.has(n.key))
    .map(n => ({ key: n.key, kind: n.kind, text: firstLine(n.title) || firstLine(n.text) || n.key }))
  return { keys, fresh }
}

/**
 * The one notification for what arrived across boards: `arrivals` is [{terminal, fresh}] (boards with nothing new left
 * out). One item names it; several give a count. `terminal` is where a click goes: the first board's coordinator.
 * Returns {title, body, terminal} or null when nothing arrived.
 */
export function arrivalNotice(arrivals) {
  const list = (arrivals ?? []).filter(a => a?.fresh?.length)
  if (!list.length) return null
  const all = list.flatMap(a => a.fresh)
  const terminal = list.find(a => typeof a.terminal === 'string')?.terminal ?? null
  if (all.length === 1) {
    const [one] = all
    return { title: one.kind === 'ask' ? 'New question' : 'New pin', body: one.text, terminal }
  }
  const asks = all.filter(i => i.kind === 'ask').length
  const pinsN = all.length - asks
  const parts = []
  if (asks) parts.push(`${asks} ${asks === 1 ? 'question' : 'questions'}`)
  if (pinsN) parts.push(`${pinsN} ${pinsN === 1 ? 'pin' : 'pins'}`)
  return { title: `${all.length} new items`, body: parts.join(', '), terminal }
}

// ---- The pin drop panel and the all-pins popover (S8) ----

export const PINS_ALL_W = 470
export const PINS_ALL_ROW_TEXT = 3 // lines of a row's summary
const PINS_ALL_ROW = 122 // padding 10 + 8, title 18, text 3 x 18, buttons 24, gaps 4 + 4
const PINS_ALL_ROWS = 4 // more than this scroll
const PINS_ALL_CHROME = 2 + 20 + 24 + 4 // border, padding, header, gap
const PANEL_CHAR_W = 7.8 // a 13 px mono character
const PANEL_MAX_LINES = 12
const PANEL_FALLBACK_TOP = 80 // tabs 42 + pin bar 38, when the bar's own bounds are not known
const PANEL_FALLBACK_SIDE = CARD_SIDE
const PINS_MIN_H = 120 // an overlay never gets smaller than this, however small the window
const PINS_WINDOW_GAP = 8 // kept free between an overlay and the window's bottom edge

/** Unread first, then read; the newest first within each (board order when equal). Does not change `list`. */
export function orderPins(list) {
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Number(b.p.unread) - Number(a.p.unread) || b.p.at - a.p.at || a.i - b.i)
    .map(x => x.p)
}

/** The read marks with every pin of `list` marked; the same object when none was unread. */
export const markAllRead = (read, list) => list.reduce((r, p) => markRead(r, p.id), read)

/** A pin's drop panel is this tall for `text` at `width`: fixed, because a popup whose root has no size draws nothing. */
export function panelHeight(text, width) {
  const per = Math.max(10, Math.floor((Number(width) - 16 - 39) / PANEL_CHAR_W))
  const lines = String(text ?? '')
    .split('\n')
    .reduce((n, l) => n + Math.max(1, Math.ceil(l.length / per)), 0)
  return 1 + 14 + Math.min(Math.max(lines, 1), PANEL_MAX_LINES) * 20 + 12 + 18 + 12 + 28 + 14
}

/** The drop panel's context line: who, age and tag, as far as the pin has them. */
export const pinContext = (pin, now) => [pin.who, ageText(pin.at, now), pin.tag].filter(Boolean).join(' · ')

/** `height`, limited to what fits below `y` in the window, so the buttons stay reachable and the content scrolls. The app
 *  scales an overlay's size by the zoom but not its position, so what is left below `y` is divided by it. */
export function fitHeight(height, y, viewport, zoom = 1) {
  const vh = Number(viewport?.height)
  if (!(vh > 0)) return height
  return Math.min(height, Math.max(PINS_MIN_H, (vh - y - PINS_WINDOW_GAP) / (zoom > 0 ? zoom : 1)))
}

/** The all-pins popover's height for `n` pins. */
export const allPinsHeight = n => PINS_ALL_CHROME + (PINS_ALL_ROW + 4) * Math.min(Math.max(n, 1), PINS_ALL_ROWS)

/**
 * The pin bar's place, worked out from the layout tree: `x` and `right` are what fixed blocks take on its left and right,
 * `y` is its bottom edge. The app multiplies a layout's px by the zoom. Null with no pin bar in the tree, or when a block
 * sized by weight comes before it or beside it, which the tree alone cannot place.
 */
export function barArea(root, zoom = 1) {
  const scale = zoom > 0 ? zoom : 1
  const isBar = node => node?.type === 'block' && node.content?.props?.role === 'pinbar'
  const walk = node => {
    if (isBar(node)) return Number(node.size?.px) > 0 ? { x: 0, y: Number(node.size.px), right: 0 } : null
    const kids = node?.children ?? []
    for (let i = 0; i < kids.length; i++) {
      if (kids[i]?.hidden) continue
      const inner = walk(kids[i])
      if (!inner) continue
      const fixed = list => {
        const shown = list.filter(c => !c?.hidden)
        return shown.every(c => Number(c?.size?.px) >= 0) ? shown.reduce((sum, c) => sum + Number(c.size.px), 0) : null
      }
      const before = fixed(kids.slice(0, i))
      if (node.type === 'row') {
        const after = fixed(kids.slice(i + 1))
        return before === null || after === null ? null : { ...inner, x: inner.x + before, right: inner.right + after }
      }
      if (node.type === 'column') return before === null ? null : { ...inner, y: inner.y + before }
      return inner
    }
    return null
  }
  const area = walk(root)
  return area && { x: area.x * scale, y: area.y * scale, right: area.right * scale }
}

/**
 * Where the overlay goes. `bar` is the pin bar's bounds in the window ({x, y, width, height}) as a click reported them;
 * without them `area` (barArea) places it, and with neither the work area is taken to lie between the sidebars. The panel is as wide as the bar, right under it; the
 * popover is right aligned under it.
 * `x` and `y` are window px, the overlay's width is drawn at the zoom: without bounds, the width is divided by it.
 * The bar's bounds keep their numbers: a drawn window has to confirm their units first.
 */
export function pinsSpot(view, bar, viewport, area = null, zoom = 1) {
  const ok = Number(bar?.width) > 0
  const x = ok ? bar.x : (area?.x ?? PANEL_FALLBACK_SIDE)
  const y = ok ? bar.y + bar.height : (area?.y ?? PANEL_FALLBACK_TOP)
  const side = area ? area.x + area.right : 2 * PANEL_FALLBACK_SIDE
  const width = ok ? bar.width : Math.max(CARD_MIN_W, atZoom(Number(viewport?.width) - side, zoom) || CARD_W)
  if (view === 'panel') return { x, y, width }
  const scale = !ok && zoom > 0 ? zoom : 1
  return { x: Math.max(0, x + (width - PINS_ALL_W) * scale - 8), y: y + 4, width: PINS_ALL_W }
}

/** Done from the overlay: a list of requests in shared("hrd.doneReq"), so two in one tick both stay; the pin bar copy empties
 *  it and turns each into the same queued, undoable action as its own Done ×. These are the usable ones of `list`. */
export function doneRequests(list) {
  if (!Array.isArray(list)) return []
  return list.filter(r => r?.session && r?.key).map(r => ({ session: r.session, key: r.key }))
}

// --- S6: the band steps aside ---

/** How often the pin bar copy says it is running, and how old the file may be before the plugin ignores it. */
export const HEARTBEAT_MS = 30_000

/** The coordinators this machine's plugin sessions run in: live boards' `coordinator.terminal`, without the other
 *  machines' (`machine/t4`: a plugin there reads its own `t4`, which would match the wrong terminal). */
export function localCoordinators(boards, terminals) {
  const out = aliveBoards(boards, terminals).map(b => b.coordinator.terminal)
  return [...new Set(out.filter(a => !a.includes('/')))]
}

/** The text of ~/.herdr-agents/app-mod.json. `core` is the hc core's id (`hc server status`), left out when unknown, so
 *  a second core on the same HOME (its own `t1`) is told apart from this one. With `drawing` false (a part failed to draw)
 *  it lists no terminal, which every plugin version reads as "keep your band". */
export function heartbeat(boards, terminals, now, core = '', drawing = true) {
  return JSON.stringify({ at: now, terminals: drawing ? localCoordinators(boards, terminals) : [], ...(core ? { core } : {}) })
}

/** The core id out of `hc server status --json` output, or '' when it does not say. */
export function coreIdOf(text) {
  try {
    const id = JSON.parse(text)?.core?.id
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

/** The strip's context line for `board.summary.context`, with the band's text and thresholds: `warning` from 80% of the
 *  limit, `error` from 95%. null without usable data. */
export function contextLine(board) {
  const { tokens, limit } = board?.summary?.context ?? {}
  if (!Number.isFinite(tokens) || !Number.isFinite(limit) || limit <= 0) return null
  const level = tokens >= limit * 0.95 ? 'error' : tokens >= limit * 0.8 ? 'warning' : null
  const text = `ctx ${Math.round(tokens / 1000)}k / ${Math.round(limit / 1000)}k${level === 'error' ? ' · resets soon' : ''}`
  return { text, level }
}
