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
 * Files or Changes the owner picked stay: the board only comes back over a Changes this code moved to (`last.moved`). A worker's
 * tab leaves the panel alone until it has its own view.
 * `state` is `panelState`. `width` is the strip's: null until measured, when nothing is decided yet. `held`: the owner closed the
 * board, so arriving no longer opens it.
 */
export function panelMove(focus, board, terminals, state, width, last = null, held = false) {
  if (!focus?.tab || !Number.isFinite(width)) return { key: last?.key ?? null, moved: last?.moved === true, commands: [] }
  const name = (terminals ?? []).find(t => t?.address === focus.terminal)?.name
  const worker = Boolean(name) && (board?.workers ?? []).some(w => w?.name === name)
  const kind = onOrchestrator(board, focus) ? 'orchestrator' : worker ? 'worker' : 'shell'
  const key = `${focus.tab}|${kind}|${width >= PANEL_MIN_WORK_PX}`
  const moved = state === 'changes' && last?.moved === true
  if (key === last?.key) return { key, moved, commands: [] }
  if (kind === 'orchestrator' && width >= PANEL_MIN_WORK_PX && !held && (state === 'closed' || moved)) {
    return { key, moved: false, commands: PANEL_OPEN }
  }
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
