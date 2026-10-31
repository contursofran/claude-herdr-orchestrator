// What the Discord bot posts and what a tap on its buttons does, with no network or files here. Issue #251.

export const CHANNELS = ['decisions', 'to-do', 'review', 'updates', 'metrics']

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

// Questions about these stay in Herdr: a stray tap on a phone should not ship anything.
const HERDR_ONLY = /\b(deploy\w*|releas\w*|promot\w*|production|prod|rollback|roll back|force[- ]push\w*)\b/i

export const herdrOnly = need => HERDR_ONLY.test([need.title, need.text, ...(need.options ?? [])].join(' '))

const ID_PREFIX = 'hrd'
const STALE_BOARD_MS = 3 * 60 * 1000

/** The buttons of an open item: one per option, or Done. None for what must be answered in Herdr. */
export function buttons(need, board) {
  if (herdrOnly(need)) return []
  const list =
    need.kind === 'do'
      ? [{ type: 2, style: 3, label: 'Done', custom_id: `${ID_PREFIX}|d|${board.session}|${need.key}` }]
      : need.kind === 'ask'
        ? (need.options ?? []).slice(0, 25).map((option, i) => ({
            type: 2,
            style: need.recommended === i ? 1 : 2,
            label: clip(`${i + 1}. ${option}`, 80),
            custom_id: `${ID_PREFIX}|a|${board.session}|${need.key}|${i}`,
          }))
        : []
  const rows = []
  for (let i = 0; i < list.length; i += 5) rows.push({ type: 1, components: list.slice(i, i + 5) })
  return rows
}

const inHerdrNote = need => (need.kind === 'know' ? false : herdrOnly(need) || (need.kind === 'ask' && !need.options?.length))

/** A tap's custom_id, or null when it isn't one of ours. */
export function parseTap(id) {
  const [prefix, kind, session, key, index] = String(id).split('|')
  if (prefix !== ID_PREFIX || !/^[\w-]+$/.test(session ?? '') || !/^[A-Z]+\d+$/.test(key ?? '')) return null
  if (kind === 'd') return { kind, session, key }
  if (kind === 'a' && /^\d+$/.test(index ?? '')) return { kind, session, key, index: Number(index) }
  return null
}

/**
 * What a tap does. `null`: not ours to answer, another copy of the bot may be. `{ say }`: tell only the person who tapped.
 * `{ action, content }`: write the action file and show `content` on the message. `{ gone }` also takes the buttons away.
 */
export function planTap(tap, { interaction, config, seen, board, now }) {
  const parsed = parseTap(tap)
  if (!parsed) return null
  const id = `${parsed.session}:${parsed.key}`
  const track = seen[id]
  if (!track?.message || track.message !== interaction.message?.id) return null
  const user = interaction.member?.user?.id ?? interaction.user?.id
  if (user !== config.ownerId || interaction.guild_id !== config.guildId) return { say: 'Only the owner of this server can answer.' }
  if (track.pending) return { say: 'Already sent. Waiting for the coordinator.' }
  const need = board?.needs?.find(n => n.key === parsed.key)
  if (!need?.isOpen) return { say: 'This one is already closed.', gone: true }
  if (herdrOnly(need)) return { say: 'Answer this one in Herdr.', gone: true }
  if (!(now - board.at < STALE_BOARD_MS)) return { say: "That coordinator isn't running, so nothing was sent. Try again once it's back." }
  const title = `**${need.key} · ${need.title}** (${folderName(board)})`
  if (parsed.kind === 'd') {
    if (need.kind !== 'do') return { say: 'This one has changed. Answer it in Herdr.', gone: true }
    return {
      action: { action: 'done', key: need.key },
      content: `${title}
→ Done, sent to the coordinator`,
    }
  }
  const answer = need.kind === 'ask' ? need.options?.[parsed.index] : undefined
  if (answer === undefined) return { say: 'This one has changed. Answer it in Herdr.', gone: true }
  return { action: { action: 'answer', key: need.key, answer }, content: clip(`${title}\n→ ${answer}, sent to the coordinator`) }
}

/** An open decision or to-do. Discord's limit is 2000 characters. */
export function needText(need, board, owner) {
  const head = `${owner ? `<@${owner}> ` : ''}**${need.key} · ${need.title}** (${folderName(board)}${need.from ? `, ${need.from}` : ''})`
  const link = need.url ? `\n${need.url}` : ''
  const note = inHerdrNote(need) ? '\n*Answer this one in Herdr.*' : ''
  const tail = `${options(need)}${link}${note}`
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
          ? {
              type: 'post',
              channel: 'updates',
              content: clip(`**${need.title}** (${folderName(board)})
${need.text ?? ''}`),
              images: need.images,
            }
          : {
              type: 'post',
              channel: need.images?.length ? 'review' : need.kind === 'ask' ? 'decisions' : 'to-do',
              images: need.images,
              content: needText(need, board, owner),
              components: buttons(need, board),
              open: true,
              mention: true,
            },
      )
      // The plugin refused a tap's answer: the buttons come back, with why.
      const outcome = track?.pending && board.actions?.find?.(a => a.id === track.pending)
      if (outcome && !outcome.ok) {
        actions.push({
          type: 'edit',
          id,
          channel: track.channel,
          message: track.message,
          keepOpen: true,
          content: clip(`${needText(need, board, null)}\n*That didn't go through: ${outcome.message}*`),
          components: buttons(need, board),
        })
      }
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

const MEDIA = /\.(png|jpe?g|gif|webp|mp4|mov|webm)$/i
const MAX_FILES = 10
// The most one message can carry on a server with no boosts.
const MAX_BYTES = 10 * 1024 * 1024

/**
 * Which files go on a message. `sizeOf` gives a file's size, or null if it can't be read. What is left out comes back with why,
 * so the message says so instead of quietly showing less.
 */
export function pickImages(paths, sizeOf) {
  const files = []
  const left = []
  let total = 0
  for (const path of (paths ?? []).slice(0, 25)) {
    const name = path.split('/').at(-1)
    const size = MEDIA.test(path) ? sizeOf(path) : null
    if (size === null) left.push(`${name} (not found)`)
    else if (files.length >= MAX_FILES || total + size > MAX_BYTES) left.push(`${name} (too big)`)
    else {
      files.push({ path, name })
      total += size
    }
  }
  return { files, note: left.length ? `\n*Not attached: ${left.join(', ')}*` : '' }
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
