import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Pr, SideItem, SideView } from '../types'
import { appModShown } from './appmod'
import { readBoard } from './board'
import { ciOf, type Check } from './ci'
import { toggleWrapUp } from './coordinator'
import { SIDE_RECENT_MS, SIDE_WORK_ROWS } from './defaults'
import { linker, type LinkFn } from './links'
import { answered, choose, decisionTitle, openQuestions, pinnedItems, tick } from './owner'
import { session } from './session'
import { jobs } from './state'
import { groupTasks, labelOf, STAGES, type ItemRef, type Task } from './tasks'

// What the Herdr app draws: the work by issue or PR and what needs the person, kept in slots, as plain data
// (written out by bridge.ts, format in docs/board-schema.json), and the actions the app sends back.

const side = atom(
  { plugin: 'herdr-agents', key: 'side' } as const,
  {
    items: [],
    tasks: [],
    answers: {},
    cleared: {},
    prs: {},
  } as SideView,
)

export type Joined = { key: string; label: string; into: Task }
export const isJoined = (r: Task | Joined): r is Joined => 'into' in r

// The rows the sidebar draws: the needs-you items and the tasks, each in its slot, with
// what closed items ended as and the open decisions and to-dos they come from.
export async function gather($: EngineInterface, link: LinkFn) {
  const v = await read($, side)
  const board = await readBoard($)
  const now = await $.clock.now()
  const open = await openQuestions($)
  const todos = await pinnedItems($)
  const settled = await answered($)
  const live: SideItem[] = [
    ...todos.map(t => ({ key: `T${t.id}`, kind: t.kind, title: t.text, text: t.text, from: t.from, at: t.at })),
    ...open.map(d => ({ key: `D${d.id}`, kind: 'ask' as const, title: decisionTitle(d), text: d.question, from: d.from, at: d.at })),
  ].sort((x, y) => x.at - y.at)
  const isLive = new Set(live.map(it => it.key))
  const kept = new Set(v.items.map(it => it.key))
  const newItems = live.filter(it => !kept.has(it.key))
  const items = [...v.items, ...newItems]
  // How a closed item ended: the person's answer here, the coordinator's, or only that it closed.
  const endOf = (it: SideItem) => {
    const mine = v.answers[it.key]
    if (mine) return mine
    const s = settled.find(x => `D${x.id}` === it.key)
    if (s) return `${s.answer} (${s.by})`
    return it.kind === 'ask' ? 'answered' : it.kind === 'do' ? 'done' : 'dismissed'
  }

  const links = await linker($, board.rows, link)
  const refs: ItemRef[] = items.map(it => ({
    key: it.key,
    kind: it.kind,
    from: it.from,
    text: it.text,
    refs: links.refsIn(`${it.from} ${it.text}`, links.repoOf(it.from)),
    isOpen: isLive.has(it.key),
  }))
  const all = groupTasks({
    jobs: Object.values(await jobs($)),
    rows: board.rows,
    items: refs,
    prs: v.prs,
    now,
    repoOf: j => links.repoIn(j.brief ?? '', j.cwd),
  })
  const byKey = new Map(all.map(t => [t.key, t]))
  // The task a slot's key names now: its own, or the one it joined (a reviewer's PR row
  // once the builder's report links that PR to the issue).
  const owner = (k: string) => byKey.get(k) ?? all.find(t => t.refKeys.includes(k) || t.jobs.some(j => j.name === k))
  // A task joins the table while it runs or waits on the person, or when it finished
  // lately; one Clear done removed comes back only with a new worker or a new question.
  const lastAt = (t: Task) => Math.max(...t.jobs.map(j => j.endedAt ?? now))
  const joins = (t: Task) => {
    const c = v.cleared[t.key]
    if (c !== undefined && t.jobs.length <= c && t.isFinished) return false
    return !t.isFinished || now - lastAt(t) < SIDE_RECENT_MS
  }
  // Each slot keeps its row. One whose task joined a task drawn in another slot says so;
  // one whose task joined a task not drawn yet shows that task. `moved` is what each stored
  // key becomes (null: gone), `added` the tasks that take the next free slots.
  const own = new Set(v.tasks.filter(k => byKey.has(k)))
  const placed = new Set(own)
  const rows: (Task | Joined)[] = []
  const moved = new Map<string, string | null>()
  for (const k of v.tasks) {
    const t = owner(k)
    if (!t) moved.set(k, null)
    else if (own.has(k)) rows.push(t)
    else if (placed.has(t.key)) rows.push({ key: k, label: labelOf(k), into: t })
    else {
      placed.add(t.key)
      moved.set(k, t.key)
      rows.push(t)
    }
  }
  const added = all.filter(t => !placed.has(t.key) && joins(t))
  rows.push(...added)
  const tasks = rows.filter((r): r is Task => !isJoined(r))
  return { v, board, now, open, todos, items, newItems, isLive, endOf, rows, tasks, owner, moved, added, links }
}

// The GitHub state of the open PRs the table lists: merged, and its checks. One poll at a
// time; when gh fails for all of them the status line says so.
let polling = false
export async function pollPrs($: EngineInterface) {
  // Polls with the sidebar open, and while the app mod draws the boards (its pop-up's CI column reads the same PRs).
  if (polling || (!(await read($, side)).isOpen && !(await appModShown($)))) return
  polling = true
  try {
    const { v, tasks, now } = await gather($, (_, text) => text)
    const listed = new Set(tasks.filter(t => t.pr && t.repo).map(t => `${t.repo}#${t.pr}`))
    // A merged PR is asked once more when it has no merge time yet (one stored before `mergedAt`); null (gh gave none) is an answer.
    const want = [...listed].filter(k => v.prs[k]?.state !== 'CLOSED' && (v.prs[k]?.state !== 'MERGED' || v.prs[k]?.mergedAt === undefined))
    const got: Record<string, Pr> = {}
    let failed = ''
    for (const k of want.slice(0, SIDE_WORK_ROWS)) {
      const [repo = '', n = ''] = k.split('#')
      try {
        const ran = await $.process.run(['gh', 'pr', 'view', n, '-R', repo, '--json', 'state,mergedAt,statusCheckRollup'], {
          timeoutMs: 20_000,
        })
        if (ran.exitCode !== 0) {
          failed = ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`
          continue
        }
        const pr = JSON.parse(ran.stdout) as { state: Pr['state']; mergedAt?: string | null; statusCheckRollup?: Check[] }
        const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN
        got[k] = { state: pr.state, ci: ciOf(pr.statusCheckRollup ?? []), at: now, mergedAt: Number.isFinite(mergedAt) ? mergedAt : null }
      } catch (err) {
        failed = String(err)
      }
    }
    const isStale = Object.keys(v.prs).some(k => !listed.has(k))
    const allFailed = failed && Object.keys(got).length === 0
    if (!Object.keys(got).length && !isStale && !allFailed) return
    // Only the PRs the table still lists are kept.
    await update($, side, s => ({
      ...s,
      prs: Object.fromEntries(Object.entries({ ...s.prs, ...got }).filter(([k]) => listed.has(k))),
      ...(allFailed ? { status: `PR checks: gh failed: ${failed.slice(0, 60)}` } : {}),
    }))
  } finally {
    polling = false
  }
}

// What the snapshot below is built from, cheap to read: when it and the minute are the
// same, so is the snapshot (rows age out of the table by the minute).
export async function boardInputs($: EngineInterface) {
  const b = await readBoard($)
  return JSON.stringify([
    Math.floor((await $.clock.now()) / 60_000),
    b.rows,
    b.wrapUp,
    b.target,
    b.context,
    await read($, side),
    await openQuestions($),
    await pinnedItems($),
    await answered($),
    await jobs($),
  ])
}

// The board as the sidebar draws it, as plain data for an app outside Claude Code (see
// bridge.ts and docs/board-schema.json): the same rows in the same slots.
export async function boardSnapshot($: EngineInterface) {
  const { v, board, now, open, todos, items, isLive, endOf, rows } = await gather($, (_, text) => text)
  const busy = board.rows.filter(r => r.state !== 'reported' && r.state !== 'waiting').length
  return {
    version: BOARD_VERSION,
    session: await $.session.id(),
    cwd: session.cwd,
    at: now,
    // The hc terminal this coordinator runs in (null outside hc); an app finds the board by it.
    coordinator: { terminal: (await $.env.get('HC_TERMINAL_ID')) || null },
    stageNames: [...STAGES],
    summary: {
      busy,
      left: board.rows.filter(r => r.state !== 'reported').length,
      target: board.target ?? null,
      wrapUp: !!board.wrapUp,
      needs: items.filter(it => isLive.has(it.key)).length,
      context: board.context ?? null,
    },
    workers: board.rows.map(r => ({
      name: r.name,
      profile: r.profile,
      state: r.state,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      note: r.note ?? null,
      since: r.since ?? null,
      repo: r.repo ?? null,
    })),
    tasks: rows.map(r =>
      isJoined(r)
        ? { key: r.key, label: r.label, joined: r.into.key }
        : {
            key: r.key,
            label: r.label,
            title: r.title,
            repo: r.repo ?? null,
            pr: r.pr ?? null,
            url: ghUrl(r) ?? null,
            stages: r.stages,
            who: r.who,
            now: r.now,
            item: r.item ?? null,
            tab: r.tab ?? null,
            workers: r.jobs.map(j => j.name),
            isFinished: r.isFinished,
            isMerged: r.isMerged,
            mergedAt: r.mergedAt ?? null,
          },
    ),
    needs: items.map(it => {
      const d = open.find(x => `D${x.id}` === it.key)
      const t = todos.find(x => `T${x.id}` === it.key)
      return {
        key: it.key,
        kind: it.kind,
        title: it.title,
        text: it.text,
        from: it.from,
        at: it.at,
        isOpen: isLive.has(it.key),
        end: isLive.has(it.key) ? null : endOf(it),
        options: d?.options ?? [],
        recommended: d?.recommended ?? null,
        url: t?.text.match(/\bhttps?:\/\/\S+|\blocalhost:\d+\S*/)?.[0]?.replace(/[).,;]+$/, '') ?? null,
        images: d?.images ?? t?.images ?? [],
      }
    }),
    status: v.status ?? '',
  }
}
export const BOARD_VERSION = 1

// What an app outside Claude Code asks of the board: the sidebar's own buttons.
export type BoardAction =
  | { action: 'answer'; key: string; answer: string }
  | { action: 'done'; key: string }
  | { action: 'clearDone'; what?: 'items' | 'tasks' }
  | { action: 'wrapUp'; on: boolean }

// Does what pressing that button in the sidebar does, and says what came of it; throws
// when the item is not open or the action unknown.
export async function boardAct($: EngineInterface, a: BoardAction): Promise<string> {
  const g = await gather($, (_, text) => text)
  const keep = (key: string, answer: string, status: string) =>
    update($, side, s => ({
      ...s,
      items: [...s.items, ...g.items.filter(x => !s.items.some(y => y.key === x.key))],
      answers: { ...s.answers, [key]: answer },
      status,
    }))
  switch (a.action) {
    case 'answer': {
      const d = g.open.find(x => `D${x.id}` === a.key)
      if (!d) throw new Error(`${a.key} is not an open decision`)
      await keep(a.key, a.answer, `${a.key} → ${a.answer} · sent`)
      await choose($, d, a.answer)
      return `${a.key} → ${a.answer}`
    }
    case 'done': {
      const t = g.todos.find(x => `T${x.id}` === a.key)
      if (!t) throw new Error(`${a.key} is not an open to-do`)
      const done = t.kind === 'do' ? 'done' : 'dismissed'
      await keep(a.key, done, `${a.key} ${done}`)
      await tick($, t)
      return `${a.key} ${done}`
    }
    case 'clearDone': {
      const resolved = g.items.filter(it => !g.isLive.has(it.key))
      const finished = g.tasks.filter(t => t.isFinished)
      const done = new Set([...finished.map(t => t.key), ...g.rows.filter(isJoined).map(j => j.key)])
      const items = a.what !== 'tasks'
      const tasks = a.what !== 'items'
      await update($, side, s => ({
        ...s,
        ...(items
          ? {
              items: s.items.filter(it => !resolved.some(r => r.key === it.key)),
              answers: Object.fromEntries(Object.entries(s.answers).filter(([k]) => !resolved.some(r => r.key === k))),
            }
          : {}),
        ...(tasks
          ? {
              tasks: s.tasks.filter(k => !done.has(k) && !done.has(g.owner(k)?.key ?? '')),
              cleared: { ...s.cleared, ...Object.fromEntries(finished.map(t => [t.key, t.jobs.length])) },
            }
          : {}),
      }))
      return `cleared ${(items ? resolved.length : 0) + (tasks ? done.size : 0)} done`
    }
    case 'wrapUp':
      await toggleWrapUp($, a.on)
      return a.on ? 'wrapping up' : 'keep going'
    default:
      throw new Error(`unknown action ${JSON.stringify((a as { action?: unknown }).action)}`)
  }
}

// The task's PR on GitHub, else its issue.
export function ghUrl(t: Task) {
  const n = t.pr ?? t.refs[0]
  return t.repo && n ? `https://github.com/${t.repo}/${t.pr ? 'pull' : 'issues'}/${n}` : undefined
}
