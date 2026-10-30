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

/** The value of one label on a terminal; core terminals carry `labels` as an object, a list of "k=v" or a list of {key, value}. */
export function labelOf(terminal, key) {
  const labels = terminal?.labels
  if (!labels) return null
  if (Array.isArray(labels)) {
    for (const l of labels) {
      if (typeof l === 'string') {
        const i = l.indexOf('=')
        if (i > 0 && l.slice(0, i) === key) return l.slice(i + 1)
      } else if (l && (l.key ?? l.name) === key) return String(l.value)
    }
    return null
  }
  const v = labels[key]
  return v === undefined || v === null ? null : String(v)
}

const live = t => t && t.state === 'live' && Boolean(t.agent)

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
 *   last      the {space, session} that rule 2 or 3 last picked, or null
 * Returns {board, via, pick}: via is 2, 3, 4 or null; `pick` is the value to pass as `last` next time.
 *
 * Several boards can match (a /clear or resume leaves two session files for one terminal, and a plain `claude`
 * started by hand in a coordinator's terminal inherits its HC_TERMINAL_ID and writes a board of its own).
 * The one picked last stays picked while its file exists; otherwise the newest `at` wins, and equal ones go by session id.
 * Without that, two boards rewritten every 3 s would swap places on every write.
 */
export function resolveBoard(boards, terminals, focus, last = null) {
  const byAddress = new Map((terminals ?? []).map(t => [t.address, t]))
  // 1. A board counts only while its coordinator terminal is live and runs an agent; boards without the field are ignored.
  const alive = (boards ?? []).filter(b => {
    const address = b?.coordinator?.terminal
    return typeof address === 'string' && live(byAddress.get(address))
  })
  const none = { board: null, via: null, pick: last }
  if (!focus) return none
  const space = focus.space ?? null

  // 2. The focused terminal is a board's coordinator.
  if (focus.terminal) {
    const board = choose(
      alive.filter(b => b.coordinator.terminal === focus.terminal),
      last,
    )
    if (board) return { board, via: 2, pick: { space, session: board.session } }
    // 3. The focused terminal is one of a board's workers, by name.
    const name = byAddress.get(focus.terminal)?.name
    if (name) {
      const worker = choose(
        alive.filter(b => (b.workers ?? []).some(w => w.name === name)),
        last,
      )
      if (worker) return { board: worker, via: 3, pick: { space, session: worker.session } }
    }
  }

  // 4. A board whose coordinator sits in the focused space.
  if (space) {
    const inSpace = alive.filter(b => labelOf(byAddress.get(b.coordinator.terminal), 'herdr.space') === space)
    const sticky = last && last.space === space ? last : null
    const board = choose(inSpace, sticky)
    if (board) return { board, via: 4, pick: last }
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
