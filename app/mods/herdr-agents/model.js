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
