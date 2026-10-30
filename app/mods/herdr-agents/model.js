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
 *   sorted    the agents in the list's own order (after the sort view)
 *   boards, terminals   as for orchestratorSection
 *   pins      the pinned addresses, in pin order
 * An orchestrator is in the first part only, pinned or not; pins that match no agent are skipped.
 * Returns {orchestrators, pinned, rest, list}; `list` is the three joined.
 */
export function listOrder(sorted, boards, terminals, pins = []) {
  const { orchestrators } = orchestratorSection(sorted, boards, terminals)
  const orch = new Set(orchestrators.map(a => a.address))
  const others = (sorted ?? []).filter(a => !orch.has(a.address))
  const pinned = pins.map(p => others.find(a => a.address === p)).filter(Boolean)
  const rest = others.filter(a => !pins.includes(a.address))
  return { orchestrators, pinned, rest, list: [...orchestrators, ...pinned, ...rest] }
}
