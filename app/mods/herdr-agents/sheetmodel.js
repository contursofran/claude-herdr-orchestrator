// The context sheet's logic (S9), with no gpui-kit or herdr imports so node can test it (app/test).
import { ageText, answerAction, atZoom, doneAction, liveSent, openNeeds, stripItems } from './model.js'

const firstLine = text =>
  String(text ?? '')
    .split('\n')[0]
    .trim()

const text = v => (typeof v === 'string' ? v : '')

/** Whether a mod command name means "open or close the sheet" (`herdr-agents.sheet`). */
export const isSheetCommand = name => /(?:^|\.)sheet$/.test(String(name))

/** The sheet is at most this tall, as wide as the window allows, and keeps the strip and prompt clear while the window has room. */
export const SHEET_W = 1000
export const SHEET_MIN_W = 300
export const SHEET_SIDE = 170
export const SHEET_MAX_H = 470
export const SHEET_MIN_H = 220
export const SHEET_LEAST_H = 100
// Under this width the header has no room for the meta: the id, the title's start, the pager and esc stay.
export const SHEET_META_W = 420
// The rows around the terminal (tabs, pin bar, strip, status bar) and a prompt's worth of room that stay visible.
const SHEET_CLEAR = 42 + 38 + 34 + 28 + 118
// The most it can have: the app cuts a floating block off at the bottom of the main block (those rows, the block's margins
// and the frame's, as measured at zoom 1 and 1.2). A short window gives up the prompt first, so options stay in reach.
const SHEET_ROWS = 42 + 38 + 34 + 28 + 40

/**
 * The sheet's size from the window `viewport` ({width, height}): up to SHEET_W by SHEET_MAX_H, narrower when the window
 * is (clear of the sidebars, as the card is) and shorter when it is short, so the strip and the prompt stay visible
 * and the body scrolls. Without a viewport it keeps its full size. All of it is in the px the app scales by `zoom`.
 */
export function sheetSize(viewport, zoom = 1) {
  const vw = atZoom(viewport?.width, zoom)
  const vh = atZoom(viewport?.height, zoom)
  const w = vw > 0 ? Math.max(SHEET_MIN_W, Math.min(SHEET_W, Math.floor(vw - 2 * SHEET_SIDE))) : SHEET_W
  const least = Math.max(SHEET_LEAST_H, Math.min(SHEET_MIN_H, Math.floor(vh - SHEET_ROWS)))
  const h = vh > 0 ? Math.max(least, Math.min(SHEET_MAX_H, Math.floor(vh - SHEET_CLEAR))) : SHEET_MAX_H
  return { w, h, narrow: w < 760, meta: w >= SHEET_META_W }
}

/** The open items the sheet pages over: every open need, in board order. */
export const sheetItems = board => openNeeds(board).map(n => ({ key: n.key, kind: n.kind }))

/**
 * Where `key` sits among the open items: {i, n, prev, next}. `i` is 1-based, or 0 when `key` is not open any more (an
 * answered item stays on the sheet until it is paged away); `prev`/`next` wrap, and are null with nothing else to page to.
 */
export function sheetPage(board, key) {
  const keys = sheetItems(board).map(i => i.key)
  const at = keys.indexOf(key)
  if (keys.length === 0) return { i: 0, n: 0, prev: null, next: null }
  if (at < 0) return { i: 0, n: keys.length, prev: keys[keys.length - 1], next: keys[0] }
  const step = d => keys[(at + d + keys.length) % keys.length]
  return { i: at + 1, n: keys.length, prev: keys.length > 1 ? step(-1) : null, next: keys.length > 1 ? step(1) : null }
}

/** The item ⌘J opens on: the one the card shows (`cardKey`) if it is an open item here, else the first decision, then
 *  the first to-do, then the first note. null when nothing is open. */
export function sheetTarget(board, cardKey = null) {
  const keys = sheetItems(board)
  if (cardKey && keys.some(i => i.key === cardKey)) return cardKey
  const first = kind => keys.find(i => i.kind === kind)?.key
  return stripItems(board).find(i => i.kind !== 'blocked')?.key ?? first('know') ?? null
}

const taskLine = t => [t.label, firstLine(t.title)].filter(Boolean).join(' ')

/** The tasks (not slots that joined another row) whose `item` is `key`. */
export const tasksWaiting = (board, key) => (board?.tasks ?? []).filter(t => t && !t.joined && t.item === key)

/** The "waiting on" line: the tasks that wait on this item, or that none does. */
export function waitingOn(board, key) {
  const lines = tasksWaiting(board, key).map(taskLine).filter(Boolean)
  return lines.length ? `Waiting on this: ${lines.join(' · ')}` : 'Nothing waits on this'
}

/** Which source the "Why it asks" box uses: the board's excerpt, else the item's text, else the asker's RESULT.md. */
export function whySource(need) {
  if (text(need?.source?.excerpt).trim()) return 'excerpt'
  if (text(need?.text).trim()) return 'text'
  if (text(need?.source?.file).trim()) return 'file'
  return null
}

/** The path of the RESULT.md to read for `need` (null unless the box uses it); a relative one is the board's folder's. */
export function whyFile(board, need) {
  if (whySource(need) !== 'file') return null
  const file = need.source.file.trim()
  return file.startsWith('/') || !board?.cwd ? file : `${board.cwd.replace(/\/+$/, '')}/${file}`
}

/** "Why it asks": `source.excerpt`, else `text`, else `fileText` (what reading `source.file` gave). '' when there is none. */
export function whyText(need, fileText = null) {
  const source = whySource(need)
  if (source === 'excerpt') return need.source.excerpt.trim()
  if (source === 'text') return need.text.trim()
  if (source === 'file') return text(fileText).trim()
  return ''
}

/** The lines of the box, at most `max` of them (a long RESULT.md is cut; the box scrolls anyway). */
export function whyLines(value, max = 200) {
  const lines = String(value ?? '').split('\n')
  return lines.length > max ? [...lines.slice(0, max), '…'] : lines
}

const PR_REF = /^(?:PR\s*)?#(\d+)$/i

/**
 * The files and PRs to list: the item's `refs` (strings, or {label, url}) and the PR of each task waiting on it. A PR
 * with a known address opens the browser; a file is shown as text. Each is {label, url}; no duplicates.
 */
export function sheetRefs(board, need) {
  const waiting = tasksWaiting(board, need?.key)
  const refs = []
  const add = (label, url = null) => {
    if (label && !refs.some(r => r.label === label)) refs.push({ label, url: url || null })
  }
  for (const r of Array.isArray(need?.refs) ? need.refs : []) {
    if (typeof r === 'string') {
      const m = PR_REF.exec(r.trim())
      if (!m) {
        add(r.trim())
        continue
      }
      const n = Number(m[1])
      const task = waiting.find(t => t.pr === n && t.url) ?? waiting.find(t => t.repo)
      const url = waiting.find(t => t.pr === n && t.url)?.url ?? (task?.repo ? `https://github.com/${task.repo}/pull/${n}` : null)
      add(`PR #${n}`, url)
    } else if (r && typeof r === 'object') {
      add(text(r.label).trim(), typeof r.url === 'string' ? r.url : null)
    }
  }
  for (const t of waiting) if (Number.isInteger(t.pr)) add(`PR #${t.pr}`, t.url)
  return refs
}

/** The terminal `Ask principal` goes to: the coordinator's, or null (the button is left out). */
export const askTarget = board =>
  typeof board?.coordinator?.terminal === 'string' && board.coordinator.terminal ? board.coordinator.terminal : null

/**
 * What the sheet draws for item `key` of `board`, pure. `queue` are actions waiting out their undo time and `sent` the
 * ones sent and not yet settled ({id, session, key, action}); `fileText` is the RESULT.md read for the "Why" box.
 * face: `ask`, `do` or `know` for an open item with its buttons; `resolved` after an action waits or went out (the
 * options stay, the chosen one marked, with `undoId` while it waits) or when the item is closed; `gone` without a board.
 */
export function sheetView(board, key, { queue = [], sent = [], now = 0, fileText = null } = {}) {
  if (!board) {
    return {
      face: 'gone',
      key,
      id: key,
      title: 'This board has ended',
      meta: '',
      pos: sheetPage(null, key),
      waitingOn: 'Nothing waits on this',
      why: '',
      whyFile: null,
      source: '',
      refs: [],
      ask: null,
      undoId: null,
      options: [],
    }
  }
  const mine = q => q.session === board.session && q.key === key
  const waiting = queue.filter(mine).pop()
  const out = waiting ?? liveSent(sent, now).filter(mine).pop()
  const need = (board.needs ?? []).find(n => n.key === key)
  const pos = sheetPage(board, key)
  const tasks = tasksWaiting(board, key)
  const base = {
    key,
    id: key,
    title: firstLine(need?.title) || firstLine(need?.text) || key,
    meta: [
      tasks
        .map(t => t.label)
        .filter(Boolean)
        .join(' '),
      need?.from,
      ageText(need?.at, now),
    ]
      .filter(Boolean)
      .join(' · '),
    pos,
    waitingOn: waitingOn(board, key),
    why: whyText(need, fileText),
    whyFile: whyFile(board, need),
    source: [need?.from, { excerpt: 'excerpt', file: 'RESULT.md' }[whySource(need)], ageText(need?.at, now)].filter(Boolean).join(' · '),
    refs: sheetRefs(board, need),
    ask: askTarget(board),
  }
  if (!need) return { ...base, face: 'resolved', verb: 'closed', detail: '', sent: true, undoId: null, options: [] }

  const impacts = Array.isArray(need.impacts) ? need.impacts : []
  const list = (() => {
    if (need.kind === 'ask') {
      const rec = Number.isInteger(need.recommended) ? need.recommended : -1
      return (Array.isArray(need.options) ? need.options : [])
        .filter(o => typeof o === 'string')
        .map((label, i) => ({ label, impact: text(impacts[i]), rec: i === rec, action: answerAction(key, label), url: null }))
    }
    if (need.kind === 'do') {
      const url = typeof need.url === 'string' && need.url ? need.url : null
      const done = { label: 'Done', impact: text(impacts[0]), rec: true, action: doneAction(key), url: null }
      return url ? [done, { label: 'Open link', impact: text(impacts[1]), rec: false, action: null, url }] : [done]
    }
    return [{ label: 'Dismiss', impact: text(impacts[0]), rec: true, action: doneAction(key), url: null }]
  })()

  if (out || need.isOpen !== true) {
    const answered = out?.action?.action === 'answer'
    const chosen = out ? list.findIndex(o => o.action && JSON.stringify(o.action) === JSON.stringify(out.action)) : -1
    return {
      ...base,
      face: 'resolved',
      verb: !out ? 'closed' : answered ? 'answer' : need.kind === 'know' ? 'dismissed' : 'done',
      detail: answered ? out.action.answer : '',
      sent: !waiting,
      undoId: waiting ? waiting.id : null,
      options: list.map((o, i) => ({ ...o, picked: i === chosen })),
    }
  }
  return { ...base, face: need.kind === 'ask' ? 'ask' : need.kind === 'do' ? 'do' : 'know', options: list }
}

/**
 * What a key does while the sheet has the keyboard. `keystroke` is the event's whole chord. Esc closes, left and right
 * page, `1`-`3` press that option when there is one (`options`); anything else is left alone, so the sheet takes
 * nothing it has no use for. A held key is ignored. Returns {type: 'close' | 'prev' | 'next' | 'option', index?} or {type: 'ignore'}.
 */
export function sheetKeyAction(keystroke, { options = 0, held = false } = {}) {
  if (held) return { type: 'ignore' }
  const k = String(keystroke ?? '').toLowerCase()
  if (k === 'escape') return { type: 'close' }
  if (k === 'left') return { type: 'prev' }
  if (k === 'right') return { type: 'next' }
  const n = /^[1-3]$/.test(k) ? Number(k) : 0
  if (n && n <= options) return { type: 'option', index: n - 1 }
  return { type: 'ignore' }
}

/** The line under the options of a resolved item: only what happened, so a closed item never claims it was sent. */
export const sheetDoneLine = view =>
  view.verb === 'closed' ? 'closed' : [view.verb, view.detail, view.sent ? 'sent' : 'sending'].filter(Boolean).join(' · ')

const LINE_H = 18
const CHAR_W = 7
const textRows = (value, width) =>
  String(value ?? '')
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil((line.length * CHAR_W) / width)), 0)

/**
 * Whether the sheet's scrolling part holds more than shows at `size`, so the hint can say so. An estimate from the text
 * (the app cannot measure here): the options column in a wide window, the whole scrolling column in a narrow one.
 */
export function sheetMore(view, size) {
  const width = size.narrow ? size.w - 40 : 420
  const options = view.options.reduce((sum, o) => sum + 44 + (o.impact ? 4 + LINE_H * textRows(o.impact, width) : 0), 0)
  const done = view.face === 'resolved' ? 8 + LINE_H : 0
  // Above and below the scrolling part: padding, header and gaps, then the waiting line, column label and actions if outside.
  if (!size.narrow) return options + done > size.h - 176
  const why = 24 + LINE_H * textRows(view.why || ' ', width - 28)
  return LINE_H * 3 + 24 + options + done + why > size.h - 102
}

/** The line under the sheet: which keys do what, and first of all (it may be cut) that there is more to scroll to. */
export function sheetHint({ options = 0, paged = false, more = false } = {}) {
  const n = Math.min(Math.max(Number(options) || 0, 0), 3)
  return [more ? 'scroll for more' : '', n ? `${n === 1 ? '1' : `1-${n}`} choose` : '', paged ? '← → page' : '', 'esc closes']
    .filter(Boolean)
    .join(' · ')
}
