// What the right panel (#274) shows and when it moves. Pure, apart from the layout commands it hands back to run.
import { workRows } from './model.js'

/** The right panel's lists. `work` is everything that can still need a look, including a merged task with a test waiting on
 *  the owner; `merged` is history, newest first. */
export function panelSections(board) {
  const rows = workRows(board)
  const settled = r => r.isMerged && r.who.text === 'merged'
  return {
    work: rows.filter(r => !r.isFinished && !settled(r)),
    merged: rows.filter(r => r.isMerged && (r.isFinished || settled(r))).sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0)),
  }
}

/** The worker the focused terminal belongs to on this board, by its tab's name, else null. */
export function focusedWorker(board, terminals, focus) {
  const name = (terminals ?? []).find(t => t?.address === focus?.terminal)?.name
  return (name && (board?.workers ?? []).find(w => w?.name === name)) || null
}

/** The row a worker is on: the one naming it, the running one over a finished one. Null when no task names it. */
export function workerRow(board, worker) {
  const name = worker?.name
  const rows = workRows(board).filter(r => r.tab === name || r.workers.includes(name))
  return rows.find(r => !r.isFinished) ?? rows[0] ?? null
}

/** The stage names a row goes through: plan only when it was planned, as the design has it. */
export const rowStageNames = (row, names) => names.filter((_, i) => i > 0 || (row?.stages?.[0] ?? 'none') !== 'none')

/** How many rows of the merged list show until the owner asks for all of them. */
export const PANEL_HISTORY = 3

/** The stack child that draws the board, in `panel-body`. */
export const PANEL_CHILD = 'hrd-panel'
/** The strip spans the work column: a 1300 px window less the 268 px sidebar. Narrower, the panel would crowd the terminal. */
export const PANEL_MIN_WORK_PX = 1032

/** What opens the panel on the board. */
export const PANEL_OPEN = [
  ['layout.select', { stack: 'panel-body', child: PANEL_CHILD }],
  ['layout.show', { id: 'panel' }],
]

/** The panel in the shown layout, from herdr's `layout()`: 'closed', 'board', the stack child it shows ('files', 'changes'), or
 *  null when this layout has no panel. */
export function panelState(root) {
  const find = (node, id) => {
    if (node?.id === id) return node
    for (const child of node?.children ?? []) {
      const found = find(child, id)
      if (found) return found
    }
    return null
  }
  const panel = find(root, 'panel')
  if (!panel) return null
  if (panel.hidden === true) return 'closed'
  const active = find(root, 'panel-body')?.active ?? null
  return active === PANEL_CHILD ? 'board' : active
}

/** Whether the focused terminal is this board's coordinator. */
export const onOrchestrator = (board, focus) => Boolean(focus?.terminal) && board?.coordinator?.terminal === focus.terminal

/**
 * What the right panel does for the tab in focus. It moves once per arrival (`last.key`), so a terminal is resized at most once
 * for it. An orchestrator's tab opens a closed panel on the board, and a shell's goes back to Changes if the board was showing.
 * Files or Changes the owner picked stay: our view only comes back over a Changes this code moved to (`last.moved`), which a
 * worker's tab does too. Otherwise a worker's tab leaves the panel as it is, and when open on our view it draws that worker.
 * `state` is `panelState`. `width` is the strip's: null until measured, when nothing is decided yet. `held`: the owner closed the
 * board, so arriving no longer opens it.
 */
export function panelMove(focus, board, terminals, state, width, last = null, held = false) {
  if (!focus?.tab || !Number.isFinite(width)) return { key: last?.key ?? null, moved: last?.moved === true, commands: [] }
  const worker = focusedWorker(board, terminals, focus)
  const kind = onOrchestrator(board, focus) ? 'orchestrator' : worker ? 'worker' : 'shell'
  const key = `${focus.tab}|${kind}|${width >= PANEL_MIN_WORK_PX}`
  // A draw can land before the move to Changes does, with the board still showing, and that doesn't end it.
  const moved = last?.moved === true && (state === 'changes' || (state === 'board' && key === last.key))
  if (key === last?.key) return { key, moved, commands: [] }
  if (kind === 'orchestrator' && width >= PANEL_MIN_WORK_PX && !held && (state === 'closed' || moved)) {
    return { key, moved: false, commands: PANEL_OPEN }
  }
  if (kind === 'worker' && moved) return { key, moved: false, commands: PANEL_OPEN }
  if (kind === 'shell' && state === 'board') {
    return { key, moved: true, commands: [['layout.select', { stack: 'panel-body', child: 'changes' }]] }
  }
  return { key, moved, commands: [] }
}

/** The bottom row's way in: `panel` reopens a closed panel where there is room for it (D43), nothing while an orchestrator's board
 *  is already open, and otherwise the `board` pop-up. Below the width limit the pop-up stays until the panel can float (#276). */
export function bottomPill(state, width, orchestrator) {
  if (state === 'closed' && Number.isFinite(width) && width >= PANEL_MIN_WORK_PX) return 'panel'
  return state === 'board' && orchestrator ? null : 'board'
}
