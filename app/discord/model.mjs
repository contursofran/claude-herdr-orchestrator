// What the Discord bot posts: board changes as messages, with no network or files here. Issue #251, step 1: post only.

export const CHANNELS = ['decisions', 'to-do', 'updates', 'metrics']

const MAX = 1900
const DAY = 24 * 3600 * 1000
const MONTH = 30 * DAY

export const clip = (text, n = MAX) => {
  const s = String(text ?? '')
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

const folderName = board =>
  String(board.cwd ?? '')
    .split('/')
    .filter(Boolean)
    .at(-1) ?? 'unknown'

/** Whether a board's folder may post. No `only` list means every folder. */
export function allowed(cwd, only, home) {
  if (!Array.isArray(only)) return true
  const expand = p => (p.startsWith('~/') ? `${home}/${p.slice(2)}` : p).replace(/\/+$/, '')
  return only.map(expand).some(p => cwd === p || String(cwd).startsWith(`${p}/`))
}

function options(need) {
  if (!need.options?.length) return ''
  const lines = need.options.map((o, i) => `${i + 1}. ${o}${need.recommended === i ? ' (recommended)' : ''}`)
  return `\n${lines.join('\n')}`
}

/** An open decision or to-do. Discord's limit is 2000 characters. */
export function needText(need, board, owner) {
  const head = `${owner ? `<@${owner}> ` : ''}**${need.key} · ${need.title}** (${folderName(board)}${need.from ? `, ${need.from}` : ''})`
  const link = need.url ? `\n${need.url}` : ''
  const tail = `${options(need)}${link}`
  return `${head}\n${clip(need.text, MAX - head.length - tail.length - 2)}${tail}`
}

/** The same item once closed: no mention, so an edit alerts nobody. */
export function closedText(need, board) {
  const end = need?.end ? `: ${need.end}` : ''
  return clip(`✓ ~~${need?.key ?? ''} · ${need?.title ?? ''}~~ (${folderName(board)})${end}`)
}

const taskText = (task, board) =>
  clip(`Merged in ${folderName(board)}: **${task.label}** ${task.title ?? ''}${task.url ? `\n<${task.url}>` : ''}`)

const WORKER_WORDS = { blocked: 'is blocked', reported: 'finished', done: 'finished' }

const workerText = (worker, board) =>
  clip(`Worker **${worker.name}** ${WORKER_WORDS[worker.state]} in ${folderName(board)}${worker.note ? `: ${worker.note}` : ''}`)

const recent = (at, now) => typeof at === 'number' && now - at < DAY

/**
 * What changed on one board since `seen` (id -> { message, channel, open, at }).
 * Returns `post` and `edit` actions in order, and `mark` for ids to remember with no message. `first` is the bot's very
 * first look: everything already there is only remembered. Something older than a day is never posted, so a long sleep or a
 * revived old board floods nothing.
 */
export function diffBoard(board, seen, { now, owner, first = false }) {
  const actions = []
  const consider = (id, at, make) => {
    if (seen[id]) return
    if (first || !recent(at, now)) actions.push({ type: 'mark', id, at: now })
    else actions.push({ ...make(), id, at: now })
  }
  const prefix = `${board.session}:`
  const needs = Array.isArray(board.needs) ? board.needs : []
  for (const need of needs) {
    const id = `${prefix}${need.key}`
    const track = seen[id]
    if (need.isOpen) {
      consider(id, need.at, () =>
        need.kind === 'know'
          ? { type: 'post', channel: 'updates', content: clip(`**${need.title}** (${folderName(board)})\n${need.text ?? ''}`) }
          : {
              type: 'post',
              channel: need.kind === 'ask' ? 'decisions' : 'to-do',
              content: needText(need, board, owner),
              open: true,
              mention: true,
            },
      )
    } else if (track?.open && track.message) {
      actions.push({ type: 'edit', id, channel: track.channel, message: track.message, content: closedText(need, board) })
    } else if (!track) {
      actions.push({ type: 'mark', id, at: now })
    }
  }
  // A closed item that left the board (clear done) still closes its message.
  const keys = new Set(needs.map(n => `${prefix}${n.key}`))
  for (const [id, track] of Object.entries(seen)) {
    if (id.startsWith(prefix) && track.open && track.message && !keys.has(id) && /^[A-Z]+\d+$/.test(id.slice(prefix.length))) {
      const key = id.slice(prefix.length)
      actions.push({
        type: 'edit',
        id,
        channel: track.channel,
        message: track.message,
        content: closedText({ key, title: 'closed' }, board),
      })
    }
  }
  for (const task of Array.isArray(board.tasks) ? board.tasks : []) {
    if (!task.isMerged) continue
    consider(`${prefix}task:${task.key}`, task.mergedAt, () => ({ type: 'post', channel: 'updates', content: taskText(task, board) }))
  }
  for (const worker of Array.isArray(board.workers) ? board.workers : []) {
    if (!WORKER_WORDS[worker.state]) continue
    const word = WORKER_WORDS[worker.state]
    consider(`${prefix}worker:${worker.name}:${word}`, worker.since ?? worker.endedAt ?? worker.startedAt, () => ({
      type: 'post',
      channel: 'updates',
      content: workerText(worker, board),
    }))
  }
  return actions
}

/** Drops what is closed and a month old, so the state file doesn't grow for ever. */
export function pruneSeen(seen, now) {
  return Object.fromEntries(Object.entries(seen).filter(([, t]) => t.open || now - (t.at ?? 0) < MONTH))
}

const money = n => `$${Number(n ?? 0).toFixed(2)}`

/** The day's summary from `hrd-metrics.py --days 1 --json`. */
export function metricsText(m) {
  const models = Object.entries(m.workers?.by_model ?? {})
  const cost = models.reduce((sum, [, v]) => sum + (v.cost ?? 0), 0)
  const lines = [`**Last 24 hours**`, `Workers: ${m.workers?.sessions ?? 0} sessions, ${money(cost)}`]
  for (const [name, v] of models) lines.push(`- ${name}: ${v.sessions} sessions, ${money(v.cost)}`)
  for (const repo of m.github?.repos ?? []) {
    const runs = (repo.workflows ?? []).reduce((a, w) => ({ runs: a.runs + (w.runs ?? 0), failures: a.failures + (w.failures ?? 0) }), {
      runs: 0,
      failures: 0,
    })
    const merged = `${repo.prs?.merged ?? 0}${repo.prs?.capped ? '+' : ''}`
    lines.push(`${repo.repo}: ${merged} PRs merged, ${runs.runs}${repo.runs_capped ? '+' : ''} CI runs, ${runs.failures} failed`)
  }
  return clip(lines.join('\n'))
}

/** Whether the day's summary is due: once a day, from `hour` on. */
export function metricsDue(lastDay, date, hour = 9) {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return lastDay !== day && date.getHours() >= hour ? day : null
}
