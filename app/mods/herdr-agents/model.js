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
 * Without that, boards rewritten every 3 s would swap places on every write.
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

/** 'empty' (no pins: the row stays, with a quiet line), 'full' (a pin to show) or 'slim' (pins, all read). */
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

/** The pin bar's memory between draws: the picked pin, the board it was on, the pins seen, the pins already flashed. */
export const newBarState = () => ({ session: null, sel: null, seen: null, flashed: new Set() })

/**
 * One draw of the pin bar, pure. `waiting` are the queued actions ({id, session, key}) and `hidden` the keys to leave out.
 * Returns {state, view, list, flashStart}: the next state, the data pinbar() draws (without handlers), and the pin id
 * whose flash starts now (once per pin), else null.
 */
export function deriveBar(prev, board, { read = {}, hidden = new Set(), waiting = [], now = 0 } = {}) {
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

  const mode = pinbarMode(list, sel)
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
      slim: slimLine(list),
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

// --- S5: the answer card, a hidden panel row below the terminal ---

/** The card block's id in the layout. */
export const CARD_ID = 'hrd-card'

/** The `answer` action file body for one decision. */
export const answerAction = (key, answer) => ({ action: 'answer', key, answer })

/** Panel height in px for a face (`ask`, `do`, `resolved`, `blocked`) and an option count: border 2 + padding 28, the
 *  header 20, a gap of 12 before each row, a question or note 40 (two lines), a row of buttons 28 with 6 between, and
 *  the key hint under them (a gap of 12 and a line of 16). */
export function cardHeight(face, options = 0) {
  const base = 30 + 20 + 12 + 16
  const rows = Math.min(Math.max(Number(options) || 0, 1), 6)
  if (face === 'ask') return base + 12 + 40 + 12 + rows * 28 + (rows - 1) * 6
  if (face === 'do') return base + 12 + 40 + 12 + 28
  if (face === 'blocked') return base + 12 + 20 + 12 + 28
  return base + 12 + 28 // resolved
}

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
export const openState = (current, session, key, back, seq = 0) => ({ session, key, back: current?.back ?? back ?? null, seq })

/** The height the panel needs to show `key` of `board` right now (`now` as for cardView: an old sent answer is not counted). */
export function openHeight(board, key, ctx) {
  const view = cardView(board, key, ctx)
  return cardHeight(view?.face, view?.options?.length)
}
