// What the right panel (#274) shows and when it moves. Pure, apart from the layout commands it hands back to run.
import { workRows } from './model.js'

/** The right panel's lists. `look` is what is stuck until someone acts: a blocked worker's row, once however many workers share it,
 *  or a PR that conflicts with its base with no worker on it; such a row leaves the other lists. `work` is everything else that can still need a look, including a merged task with a test
 *  waiting on the owner; `merged` is history, newest first. */
export function panelSections(board) {
  const look = new Map()
  for (const worker of board?.workers ?? []) {
    if (worker?.state !== 'blocked') continue
    const r = workerRow(board, worker) ?? {
      key: `worker-${worker.name}`,
      label: '',
      title: worker.name,
      who: { text: worker.name, kind: 'dim' },
      stages: [],
      tab: worker.name,
      link: null,
    }
    if (!look.has(r.key)) look.set(r.key, { ...r, blocked: worker.note || 'waiting' })
  }
  const running = new Set((board?.workers ?? []).filter(w => w?.state !== 'reported').map(w => w?.name))
  for (const r of workRows(board)) {
    if (!r.conflictsWith || look.has(r.key) || running.has(r.tab) || r.workers.some(w => running.has(w))) continue
    look.set(r.key, { ...r, unattended: `conflicts with ${r.conflictsWith} · no worker on it` })
  }
  const rows = workRows(board).filter(r => !look.has(r.key))
  const settled = r => r.isMerged && r.who.text === 'merged'
  return {
    look: [...look.values()],
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

/** The bottom row's way in: `panel` whenever the panel is closed (D43), nothing while an orchestrator's board is already open,
 *  and otherwise the `board` pop-up. Unmeasured it stays the pop-up, which works at any width. */
export function bottomPill(state, width, orchestrator) {
  if (state === 'closed' && Number.isFinite(width)) return 'panel'
  return state === 'board' && orchestrator ? null : 'board'
}

/** Whether `panel ▴` reopens the panel in place, or floats it over the terminal where there is no room to. */
export const panelFloats = width => !(width >= PANEL_MIN_WORK_PX)

/** The design's panel width, which it keeps when floating. */
export const PANEL_FLOAT_W = 380
// What the floating panel leaves clear of the window's height: top bar, pin bar, strip, status bar and a little air.
const PANEL_FLOAT_CLEAR = 42 + 38 + 34 + 28 + 16
const PANEL_FLOAT_MIN_H = 240

/** The floating panel's height, from the window's. */
export const panelFloatHeight = viewH => Math.max(PANEL_FLOAT_MIN_H, Math.floor(viewH - PANEL_FLOAT_CLEAR))
