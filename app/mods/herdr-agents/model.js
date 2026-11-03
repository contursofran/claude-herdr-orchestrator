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
const liveKey = a => [a?.command, a?.commandAt, a?.outputAt]

export function drawnKey(role, boards, session, open = null) {
  const list = boards ?? []
  if (role === 'agents')
    return JSON.stringify(
      list.map(b => [
        b.session,
        b.coordinator?.terminal,
        liveKey(b.coordinator),
        (b.workers ?? []).map(w => [w?.name, w?.state, w?.note, w?.since, liveKey(w)]),
      ]),
    )
  if (role === 'panel')
    return JSON.stringify(
      list.map(b => [b.session, b.coordinator?.terminal, liveKey(b.coordinator), b.cwd, b.stageNames, b.tasks, b.workers, counts(b)]),
    )
  if (role === 'board') {
    const { at: _at, ...board } = list.find(b => b.session === session) ?? {}
    return JSON.stringify(board)
  }
  if (role === 'sheet') return open ? JSON.stringify(list.map(({ at: _at, ...b }) => b)) : ''
  return JSON.stringify(list.map(({ at: _at, tasks, ...b }) => ({ ...b, rows: (tasks ?? []).map(t => t?.key) })))
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

// A remembered board gives way to one written this much later: terminal ids restart with herdr, so a dead session's file
// can match a live terminal again (#272: a three-day-old board with the old 150k limit kept winning).
const STALE_MS = 30 * 60 * 1000

function choose(candidates, last) {
  if (candidates.length === 0) return null
  const newest = [...candidates].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || String(a.session).localeCompare(String(b.session)))[0]
  const kept = last && candidates.find(b => b.session === last.session)
  if (kept && (newest.at ?? 0) - (kept.at ?? 0) < STALE_MS) return kept
  return newest
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
 * The pins on a board: open items of kind `know`, in board order. `ask` and `do` are the strip's.
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

/** `5m`, `2h`, `3d` from a time in ms; `now` under a minute; empty without a time. */
export function ageText(at, now) {
  if (!at || !now || now < at) return at ? 'now' : ''
  const s = Math.floor((now - at) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** How long an agent says nothing mid-turn before its row says so: the longest real thought measured was 63 s (#171). */
export const QUIET_SHOW_MS = 2 * 60_000
/** And when that turns amber. */
export const QUIET_WARN_MS = 5 * 60_000

/** What an agent's row says it is doing, from a board's worker or coordinator; null when nothing is worth a line. `short` leaves the
 *  time out of a running command, as the board's rows do. The board has these fields only mid-turn, so an idle agent gets no warning. */
export function liveLine(agent, now) {
  if (typeof agent?.command === 'string' && agent.command) {
    const short = `running ${agent.command}`
    const age = ageText(agent.commandAt, now)
    return { text: age && age !== 'now' ? `${short} · ${age}` : short, short, quiet: false, warn: false }
  }
  if (!Number.isFinite(agent?.outputAt) || now - agent.outputAt < QUIET_SHOW_MS) return null
  const text = `no output · ${ageText(agent.outputAt, now)}`
  return { text, short: text, quiet: true, warn: now - agent.outputAt >= QUIET_WARN_MS }
}

/** The line for the row a work row's worker runs on: its working worker's, if it has one. */
export function rowLive(board, row, now) {
  const working = (board?.workers ?? []).find(w => w?.state === 'working' && (w.name === row.tab || row.workers?.includes(w.name)))
  return working ? liveLine(working, now) : null
}

/** The line for a terminal in the agents list: a worker's by its tab's name, or a coordinator's by its terminal. */
export function agentLive(boards, terminals, address, now) {
  const name = (terminals ?? []).find(t => t.address === address)?.name
  for (const b of boards ?? []) {
    if (b.coordinator?.terminal === address) return liveLine(b.coordinator, now)
    const w = name && (b.workers ?? []).find(x => x?.name === name && x.state === 'working')
    if (w) return liveLine(w, now)
  }
  return null
}

/** The mode of a board: `orchestrating`, `solo`, or null when the board doesn't say (an older one). */
export function modeText(board) {
  const o = board?.coordinator?.orchestrating
  return o === true ? 'orchestrating' : o === false ? 'solo' : null
}

/** The mode of the orchestrator on a terminal, found by the board's coordinator terminal. */
export function agentMode(boards, address) {
  const b = (boards ?? []).find(x => x.coordinator?.terminal === address)
  return b ? modeText(b) : null
}

/** What an Interrupt button in the agents list presses: a worker on its board, or an orchestrator's terminal. */
export function interruptTarget(boards, terminals, address) {
  const name = (terminals ?? []).find(t => t.address === address)?.name
  for (const b of boards ?? []) {
    if (b.coordinator?.terminal === address) return { terminal: address }
    if (name && (b.workers ?? []).some(x => x?.name === name)) return { session: b.session, worker: name }
  }
  return null
}

/** How often a copy that draws ages looks at them. */
export const AGE_TICK_MS = 60_000

/** The times behind the ages a copy has on screen; [] when it shows none (a closed card or sheet, other roles).
 *   boards  every board read       session  the pop-up's board       open  hrd.open or hrd.sheet, for the card and the sheet */
export function agedTimes(role, { boards = [], open = null, session = null } = {}) {
  const known = at => (at ? [at] : [])
  // The clocks of a board's agents, which move on their own, and of its merged rows.
  const liveTimes = b => [b?.coordinator, ...(b?.workers ?? [])].flatMap(w => [...known(w?.commandAt), ...known(w?.outputAt)])
  const mergeTimes = b => workRows(b).flatMap(r => (r.isMerged ? known(r.mergedAt) : []))
  if (role === 'board') {
    const board = boards.find(b => b.session === session)
    return [...mergeTimes(board), ...liveTimes(board)]
  }
  // The right panel: every board, since which it shows follows focus.
  if (role === 'panel') return boards.flatMap(b => [...mergeTimes(b), ...liveTimes(b)])
  if ((role === 'strip' || role === 'sheet') && open) {
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

// ---- Sending (S4): an action waits UNDO_MS in the mod, then is written to the board's actions folder ----

/** `{action:"done", key}`: an open to-do is done; an open know is dismissed. */
export const doneAction = key => ({ action: 'done', key })

/** A file name that sorts by time: `<ms>-<random>.json`. */
export const actionFile = (ms, rand) => `${String(ms).padStart(13, '0')}-${rand}.json`

/** The queue with one more action that goes out at now + UNDO_MS. `id` is its action file name, `surface` the copy that queued it. */
export function queueAction(queue, { id, session, action, now, surface = null }) {
  return [...queue, { id, session, action, key: action.key ?? null, due: now + UNDO_MS, surface }]
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

// --- S5: the answer card, floating over the terminal above the tab it opened from ---

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
export function cardHint(face, { options = 0, url = false, copy = false } = {}) {
  const n = Math.min(Math.max(Number(options) || 0, 0), 3)
  const c = copy ? ' · c copies' : ''
  if (face === 'ask' && n) return `${n === 1 ? '1' : `1-${n}`} answers${c} · esc or any other key closes, and that key is lost`
  if (face === 'do') return `${url ? '1 done · 2 opens the link' : '1 done'}${c} · esc or any other key closes, and that key is lost`
  if (copy) return 'c copies · esc or any other key closes, and that key is lost'
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

/** How long a failed send stays on the quiet line of another item, ms. The error notice has already shown. */
export const FAIL_LINE_MS = 60000

/**
 * The quiet line for an action on ANOTHER item than `key` of `board`, shown on the card or sheet the owner moved on to:
 * the latest action still waiting out its undo time first ({kind: 'waiting', key, verb, detail, undoId}), else a failed send
 * ({kind: 'failed', key, verb, detail}, to retry by opening that item). null when there is none. `failed` entries are
 * {session, key, action, at}; `queue` as for cardView.
 */
export function quietLine(board, key, state = {}) {
  return quietLines(board, key, state)[0] ?? null
}

/** Every quiet line, the waiting action's undo first (it lasts seconds) and a failed send after it, so the failure never hides
 *  an undo. A failed send is also shown on its own item, first among failures, while that item is open; its line has the
 *  `action`, to send it again. [] when there is none. As quietLine otherwise. */
export function quietLines(board, key, { queue = [], failed = [], now = 0 } = {}) {
  if (!board) return []
  const other = q => q.session === board.session && q.key && q.key !== key
  const say = q => {
    const answered = q.action?.action === 'answer'
    return { key: q.key, verb: answered ? 'answer' : 'done', detail: answered ? String(q.action.answer ?? '') : '' }
  }
  const isOpen = k => (board.needs ?? []).some(n => n.key === k && n.isOpen === true)
  const fails = failed.filter(f => f.session === board.session && isOpen(f.key) && now - f.at < FAIL_LINE_MS)
  const bad = fails.filter(f => f.key === key).pop() ?? fails.pop()
  const waiting = queue.filter(other).pop()
  return [
    ...(waiting ? [{ kind: 'waiting', ...say(waiting), undoId: waiting.id }] : []),
    ...(bad ? [{ kind: 'failed', ...say(bad), undoId: null, action: bad.action }] : []),
  ]
}

/** Whether the card's status face has `next ›`: a choice made here moves on at once, so only an item closed from elsewhere
 *  (verb `closed`) keeps it, and only with another item to go to. */
export const showNext = (view, more) => Boolean(more) && view?.verb === 'closed'

const MODIFIER_KEYS = new Set(['shift', 'control', 'ctrl', 'alt', 'option', 'cmd', 'meta', 'super', 'fn', 'capslock'])

/**
 * What a key does while the card has the keyboard (`keystroke` is the event's whole chord, e.g. `1` or `ctrl-1`).
 * `1`-`3` answer (a decision) or press Done / Open link (a to-do), Esc closes, a modifier alone is ignored, and any
 * other key closes the card and is lost. A key held down (`held`) is ignored, so an answer is not followed by a close.
 * Returns {type: 'answer', index} | {type: 'done'} | {type: 'link'} | {type: 'close'} | {type: 'ignore'}.
 */
export function cardKeyAction(face, keystroke, { options = 0, url = false, held = false, copy = null, settling = false } = {}) {
  if (held) return { type: 'ignore' }
  // The whole chord (`keystroke`), not the bare key: ctrl-1 or alt-1 is not `1`.
  const k = String(keystroke ?? '').toLowerCase()
  if (MODIFIER_KEYS.has(k)) return { type: 'ignore' }
  if (k === 'escape') return { type: 'close' }
  if (copy) return { type: 'copy', chord: copy }
  const n = /^[1-3]$/.test(k) ? Number(k) : 0
  // Just after a move (ROWS_SETTLE_MS): a repeated 1-3 was aimed at the old item and does nothing, not even close or open a link.
  if (n && settling) return { type: 'ignore' }
  if (face === 'ask' && n && n <= options) return { type: 'answer', index: n - 1 }
  if (face === 'do' && n === 1) return { type: 'done' }
  if (face === 'do' && n === 2 && url) return { type: 'link' }
  return { type: 'close' }
}

/**
 * The shared("hrd.open") value after opening `key` on `session`: keeps the terminal to give back, else takes `back`.
 * `seq` is a counter bumped on every open, so the card takes the keyboard on each open, even of the same item.
 */
export const openState = (current, session, key, back, seq = 0, space = null, at = null) => ({
  session,
  key,
  back: current?.back ?? back ?? null,
  space: current?.back ? (current.space ?? null) : space,
  seq,
  at: at ?? current?.at ?? 0,
})

/** Whether closing the card may hand the keyboard to `open.back`: only while the owner is still in the space it was
 *  opened from (focusing it from another space would jump there). */
export const canRefocus = (open, space) => Boolean(open?.back) && (open.space ?? null) === (space ?? null)

/** Whether the card, sheet, board pop-up or pins overlay is open (`get` is shared). */
export const surfaceOpen = get => ['hrd.open', 'hrd.sheet', 'hrd.popup', 'hrd.pins'].some(key => Boolean(get(key)))

/**
 * After the last item closed the surface at once, the keyboard goes back to the terminal only after ROWS_SETTLE_MS, so a
 * repeated key cannot type there. `closed` is the open state the surface had; `now` = {holding, focusedTerminal, space, open}:
 * what is true when the hold ends. `holding`: the surface's handle still has the keyboard, so nothing else took it (a terminal,
 * an overlay, a dialog). `focusedTerminal` stays on `closed.back` through a close (seen live) and is null on a mod pane, so
 * another terminal or a null both mean the owner went elsewhere. Anything but all of this leaves the keyboard alone.
 */
export function holdRefocus(closed, now) {
  if (!canRefocus(closed, now.space)) return false
  if (now.open) return false
  return Boolean(now.holding) && now.focusedTerminal === closed.back
}

/** How long a note of a dismissing press stays good, in ms. One press reaches its button at once; this only outlives a slow draw. */
export const DISMISS_MS = 500

/** Is `press` the one that left `note` (outside.js)? Same place and button, and the same click count, so a quick second click
 *  on the same spot is a press of its own. */
export function samePress(note, press, now) {
  const close = (a, b) => Math.abs(Number(a) - Number(b)) <= 1
  return (
    Boolean(note && press?.position) &&
    now - note.at >= 0 &&
    now - note.at < DISMISS_MS &&
    close(note.x, press.position.x) &&
    close(note.y, press.position.y) &&
    note.button === press.button &&
    note.clicks === press.click_count
  )
}

/** Herdr's frame around a floating block, in window px past the mod's root: 5 above and below (its docs give no side
 *  padding), plus its 1 px border. */
export const FLOAT_FRAME = 6

/** on_mouse_down_out also fires on the frame Herdr draws around a floating block, which is still the surface. True when the
 *  press is past the frame; true too when the event has no place for it.
 *  Only above and below: the sides have none. The frame is window px, so it is divided by the zoom as the other sizes are. */
export function pastFrame(press, zoom = 1) {
  const at = press?.local_position
  const box = press?.bounds
  if (!at || !box) return true
  const frame = atZoom(FLOAT_FRAME, zoom)
  return at.x < 0 || at.y < -frame || at.x > box.width || at.y > box.height + frame
}

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
 * The work rows of the one board, top to bottom.
 * A row is {key, label, title, who: {text, kind}, stages: [5 icon names or null], item, tab}.
 */
export function workRows(board) {
  return (board?.tasks ?? [])
    .filter(t => t && typeof t === 'object')
    .map(t => ({
      key: String(t.key),
      label: t.label ?? '',
      title: t.title ?? '',
      who: { text: t.who?.text ?? '', kind: t.who?.kind ?? 'dim' },
      stages: Array.from({ length: 5 }, (_, i) => stageIcon(t.stages?.[i])),
      item: t.item ?? null,
      tab: t.tab ?? null,
      workers: Array.isArray(t.workers) ? t.workers : [],
      now: t.now ?? '',
      link: prLink(t),
      isMerged: t.isMerged === true,
      isFinished: t.isFinished === true,
      mergedAt: Number.isFinite(t.mergedAt) && t.mergedAt > 0 ? t.mergedAt : null,
      conflictsWith: typeof t.conflictsWith === 'string' && t.conflictsWith ? t.conflictsWith : null,
      shares: sharesText(t.shares),
      review: reviewOf(t.review),
      ciFailure: ciFailureOf(t),
    }))
}

/** A task's failed CI as the panel draws it, or null: `summary` for the board row (`CI failed · 2 tests`), the rest for a worker's view.
 *  Anything the board leaves out (an older plugin, a log that could not be read) is left out of the lines too. */
function ciFailureOf(t) {
  const f = t.ciFailure
  if (!f || typeof f !== 'object' || typeof f.job !== 'string') return null
  const count = n => (Number.isInteger(n) && n >= 0 ? n : null)
  const tests = (Array.isArray(f.tests) ? f.tests : []).filter(x => typeof x === 'string' && x)
  const failed = count(f.failed) ?? (tests.length || null)
  const passed = count(f.passed)
  // The worker's view shows only the first test, so every other failure is "more" (the board's `more` counts only those past the named ones).
  const more = tests.length && failed ? Math.max(0, failed - 1) : 0
  const secs = Number.isFinite(f.seconds) && f.seconds >= 0 ? f.seconds : null
  return {
    summary: failed ? `CI failed · ${failed} test${failed === 1 ? '' : 's'}` : 'CI failed',
    url: typeof f.url === 'string' && /^https?:\/\//.test(f.url) ? f.url : null,
    counts: failed ? `${failed} failed${passed === null ? '' : ` · ${passed} passed`}` : '',
    job: secs === null ? f.job : `${f.job} · ${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}`,
    first: tests[0] ?? '',
    more: more ? `+${more} more failing test${more === 1 ? '' : 's'}` : '',
  }
}

/** A worker's context fill as the panel says it (`ctx 41%`), or '' when the board has none (an older plugin, or a worker without this mod). */
export function ctxText(worker) {
  const n = worker?.context
  return Number.isInteger(n) && n >= 0 && n <= 100 ? `ctx ${n}%` : ''
}

/** A worker's branch against its base as the panel draws it, or null when the board has none: `title` (`Branch vs main`), `total`
 *  (`+142 −31`) and a row per file with git's status letter and its `delta`, `more` for the files the board left out. */
export function branchDiff(worker) {
  const d = worker?.diff
  if (!d || typeof d !== 'object' || typeof d.base !== 'string' || !Array.isArray(d.files)) return null
  const count = n => (Number.isInteger(n) && n >= 0 ? n : 0)
  const delta = f => `+${count(f.add)} \u2212${count(f.del)}`
  const files = d.files
    .filter(f => f && typeof f.path === 'string')
    .map(f => ({ path: f.path, status: String(f.status ?? 'M').slice(0, 1), delta: delta(f) }))
  const more = count(d.more)
  return {
    title: `Branch vs ${d.base}`,
    total: delta(d),
    files,
    more: more ? `+${more} more file${more === 1 ? '' : 's'}` : '',
  }
}

/** The board's Next list as rows the panel draws like its work rows: the issue's link, its plan mark, and `ready`, the first one
 *  `ready · next in line`. [] for a board without one (an older plugin). */
export function nextRows(board) {
  return (Array.isArray(board?.next) ? board.next : [])
    .filter(x => x && typeof x === 'object' && Number.isInteger(x.issue) && typeof x.title === 'string')
    .map((x, i) => ({
      key: `next-${x.key ?? x.issue}`,
      label: '',
      title: x.title,
      who: { text: i === 0 ? 'ready · next in line' : 'ready', kind: 'dim' },
      stages: [x.planned === true ? 'done' : null, null, null, null, null],
      item: null,
      tab: null,
      workers: [],
      now: '',
      link: typeof x.url === 'string' && /^https?:\/\//.test(x.url) ? { text: `issue #${x.issue}`, url: x.url, onLabel: false } : null,
      isMerged: false,
      isFinished: false,
      mergedAt: null,
      conflictsWith: null,
      shares: '',
    }))
}

/** A task's newest review: {from, verdict: 'approve' | 'changes', blockers: [short lines], text} where `text` is
 *  `changes needed · 2 blockers` or `approved`. null when it has none, or when its verdict is not one we know. */
function reviewOf(r) {
  if (!r || typeof r !== 'object' || (r.verdict !== 'approve' && r.verdict !== 'changes')) return null
  const blockers = (Array.isArray(r.blockers) ? r.blockers : []).filter(b => typeof b === 'string' && b.trim()).map(b => b.trim())
  const n = blockers.length
  const text = r.verdict === 'approve' ? 'approved' : n ? `changes needed · ${n} blocker${n === 1 ? '' : 's'}` : 'changes needed'
  return { from: typeof r.from === 'string' ? r.from : '', verdict: r.verdict, blockers, text }
}

/** `touches pin-panel.ts like #215`, from a task's `shares`; `+2` for further files, and every PR they are shared with. '' when none. */
function sharesText(shares) {
  const list = (Array.isArray(shares) ? shares : []).filter(s => Number.isInteger(s?.pr) && typeof s?.file === 'string' && s.file)
  if (!list.length) return ''
  const more = list[0].count > 1 ? ` +${list[0].count - 1}` : ''
  return `touches ${list[0].file.split('/').pop()}${more} like ${list.map(s => `#${s.pr}`).join(', ')}`
}

/** The row's PR link: its number and where it opens, only for a task that has a PR and a web address for it.
 *  `onLabel` when the row's own label already reads `#<pr>`, so that label is the link and nothing is added. */
function prLink(t) {
  if (!Number.isInteger(t.pr) || typeof t.url !== 'string' || !/^https?:\/\//.test(t.url)) return null
  const text = `#${t.pr}`
  return { text, url: t.url, onLabel: t.label === text }
}

/** What a merged row says about when: `merged 2h`, or just `merged` when the board has no merge time (an older plugin). */
export function mergedText(row, now) {
  if (!row?.isMerged) return ''
  return ['merged', ageText(row.mergedAt, now)].filter(Boolean).join(' ')
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
export function popupSpot(viewW, viewH, height, width = POPUP_W) {
  return { x: Math.max(0, viewW - width - 8), y: Math.max(0, viewH - STATUS_PX - STRIP_PX - height - 4) }
}

/** Whether a mod command name means "open the board pop-up" (`herdr-agents.board`). */
export const isBoardCommand = name => /(?:^|\.)board$/.test(String(name))

// ---- Sound and notification (S10) ----

/**
 * New `know`, `do` and `ask` items on one board (a `do` is a strip tab, not a pin; it sounds like a question). `prevKeys` is the Set
 * this returned last time for the board, or null the first time the board is seen (then nothing is new). Blocked workers are not items here: Herdr sounds for those itself.
 * Returns {keys, fresh}: every open know/do/ask key now, and the items in it that were not in `prevKeys` ({key, kind, text}).
 */
export function newArrivals(prevKeys, board) {
  const items = openNeeds(board).filter(n => n.kind === 'know' || n.kind === 'do' || n.kind === 'ask')
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
    return { title: one.kind === 'ask' ? 'New question' : one.kind === 'do' ? 'New to-do' : 'New pin', body: one.text, terminal }
  }
  const asks = all.filter(i => i.kind === 'ask').length
  const dos = all.filter(i => i.kind === 'do').length
  const pinsN = all.length - asks - dos
  const parts = []
  if (asks) parts.push(`${asks} ${asks === 1 ? 'question' : 'questions'}`)
  if (dos) parts.push(`${dos} ${dos === 1 ? 'to-do' : 'to-dos'}`)
  if (pinsN) parts.push(`${pinsN} ${pinsN === 1 ? 'pin' : 'pins'}`)
  return { title: `${all.length} new items`, body: parts.join(', '), terminal }
}

/** How long after the popover's rows change a press on a row is ignored: a press already on its way was meant for the old row. */
export const ROWS_SETTLE_MS = 500

/** Whether a press now can only be meant for the row under it. */
export const rowsSteady = (seen, now) => seen.movedAt === undefined || now - seen.movedAt >= ROWS_SETTLE_MS

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
  // The folder names whose session the number is; a board without a folder shows the bare numbers.
  const folder = typeof board.cwd === 'string' ? board.cwd.split('/').filter(Boolean).pop() : ''
  const text = `ctx ${Math.round(tokens / 1000)}k / ${Math.round(limit / 1000)}k${folder ? ` · ${folder}` : ''}${level === 'error' ? ' · resets soon' : ''}`
  return { text, level }
}
