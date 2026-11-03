import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { BoardItem, BoardState, CiFailure, NextItem, Pr } from '../types'
import { readDiff } from './branchdiff'
import { appModShown } from './appmod'
import { readBoard } from './board'
import { ciOf, type Check } from './ci'
import { failedJob, parseLog, runIdOf } from './failure'
import { isOrchestrating, toggleWrapUp } from './coordinator'
import { NEXT_MAX, PR_POLL_MAX, TASK_RECENT_MS } from './defaults'
import { linker } from './links'
import { ownLiveFields } from './live'
import { sharedFiles } from './overlap'
import { answered, choose, decisionTitle, openQuestions, pinnedItems, tick } from './owner'
import { session } from './session'
import { active, jobs } from './state'
import { groupTasks, STAGES, type ItemRef, type Task } from './tasks'
import { interruptWorker, stopWorker } from './workers'

// What the Herdr app draws: the work by issue or PR and what needs the person, as plain data
// (written out by bridge.ts, format in docs/board-schema.json), and the actions the app sends back.

const state = atom(
  { plugin: 'herdr-agents', key: 'boardState' } as const,
  {
    items: [],
    answers: {},
    cleared: {},
    prs: {},
  } as BoardState,
)

// The needs-you items and the tasks, with what closed items ended as and the open decisions and to-dos they come from.
export async function gather($: EngineInterface) {
  const v = await read($, state)
  const board = await readBoard($)
  const now = await $.clock.now()
  const open = await openQuestions($)
  const todos = await pinnedItems($)
  const settled = await answered($)
  const live: BoardItem[] = [
    ...todos.map(t => ({ key: `T${t.id}`, kind: t.kind, title: t.text, text: t.text, from: t.from, at: t.at })),
    ...open.map(d => ({ key: `D${d.id}`, kind: 'ask' as const, title: decisionTitle(d), text: d.question, from: d.from, at: d.at })),
  ].sort((x, y) => x.at - y.at)
  const isLive = new Set(live.map(it => it.key))
  const kept = new Set(v.items.map(it => it.key))
  const items = [...v.items, ...live.filter(it => !kept.has(it.key))]
  // How a closed item ended: the person's answer here, the coordinator's, or only that it closed.
  const endOf = (it: BoardItem) => {
    const mine = v.answers[it.key]
    if (mine) return mine
    const s = settled.find(x => `D${x.id}` === it.key)
    if (s) return `${s.answer} (${s.by})`
    return it.kind === 'ask' ? 'answered' : it.kind === 'do' ? 'done' : 'dismissed'
  }

  const links = await linker($, board.rows)
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
  // A task shows while it runs or waits on the person, or when it finished lately; one
  // Clear done removed comes back only with a new worker or a new question.
  const lastAt = (t: Task) => Math.max(...t.jobs.map(j => j.endedAt ?? now))
  const tasks = all.filter(t => {
    const c = v.cleared[t.key]
    if (c !== undefined && t.jobs.length <= c && t.isFinished) return false
    return !t.isFinished || now - lastAt(t) < TASK_RECENT_MS
  })
  return { v, board, now, open, todos, items, isLive, endOf, tasks, all }
}

export type NextArgs = { items?: { issue?: unknown; title?: unknown; planned?: unknown }[] }

// set_next: the coordinator's Ready list, in order, for the board's Next section (D44). Each call replaces the list. An issue a
// worker starts on leaves it by itself (see nextOnBoard), so a call is needed only when the order or the items change.
export async function setNext($: EngineInterface, e: NextArgs) {
  if (!Array.isArray(e.items)) return { deny: 'items must be a list, in the order they start; an empty list clears it' }
  if (e.items.length > NEXT_MAX) return { deny: `at most ${NEXT_MAX} items: the next few to start, not the backlog` }
  const links = await linker($, (await readBoard($)).rows)
  const own = links.repoIn('', session.cwd)
  const next: NextItem[] = []
  for (const [i, it] of e.items.entries()) {
    const ref = String(it?.issue ?? '').trim()
    const title = String(it?.title ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!/^(?:[\w.-]+(?:\/[\w.-]+)?\s*)?#\d{1,6}$/.test(ref) || !title)
      return { deny: `item ${i + 1}: give issue as #123 or owner/repo#123, and its title` }
    const [repo = '', n = ''] = (links.refsIn(ref, own)[0] ?? '').split('#')
    if (next.some(x => (x.repo ?? '') === repo && x.issue === Number(n))) continue
    next.push({
      ...(repo ? { repo } : {}),
      issue: Number(n),
      title: title.slice(0, 120),
      ...(it?.planned === true ? { planned: true } : {}),
    })
  }
  await update($, state, s => ({ ...s, next }))
  if (!next.length) return { result: 'Cleared the Next list on the board.' }
  return {
    result: `The board's Next list is now ${next.map(x => `${x.repo ?? ''}#${x.issue}`).join(', ')}. An issue leaves it once a worker starts on it; call set_next again when the order or the items change.`,
  }
}

// The Next list as the board shows it: an issue some task already has, running or done, has left it.
function nextOnBoard(next: NextItem[], tasks: Task[]) {
  const taken = (x: NextItem) => tasks.some(t => t.refs.includes(x.issue) && (!x.repo || !t.repo || t.repo === x.repo))
  return next
    .filter(x => !taken(x))
    .map(x => ({
      key: `${x.repo ?? ''}#${x.issue}`,
      label: `issue #${x.issue}`,
      title: x.title,
      repo: x.repo ?? null,
      issue: x.issue,
      url: x.repo ? `https://github.com/${x.repo}/issues/${x.issue}` : null,
      planned: x.planned === true,
    }))
}

// The GitHub state of the open PRs the table lists: merged, and its checks. One poll at a
// time; when gh fails for all of them the status line says so.
let polling = false
/** `{ failure }` for an open PR whose CI failed: the same read when its head is the one already read, else the failed job and,
 *  from its log, the failing tests. One log read per failing head; a log that can't be read leaves the job without test names. */
async function failureOf($: EngineInterface, k: string, checks: Check[], head: string, held?: CiFailure) {
  if (ciOf(checks) !== 'fail') return {}
  if (held && held.head === head) return { failure: held }
  const failure = failedJob(checks, head)
  if (!failure) return {}
  const run = runIdOf(failure.url)
  if (run) {
    try {
      const ran = await $.process.run(['gh', 'run', 'view', run, '-R', k.split('#')[0] ?? '', '--log-failed'], { timeoutMs: 30_000 })
      if (ran.exitCode === 0) Object.assign(failure, parseLog(ran.stdout))
    } catch {}
  }
  return { failure }
}

/** The failure as the board shows it: without the head it was read at. */
function failureForBoard(f?: CiFailure) {
  if (!f) return null
  const { head: _head, ...shown } = f
  return shown
}

// Each shown worker's branch against its default branch, kept in the state for the board. Like pollPrs, only while the app mod draws.
let diffing = false
// Workers whose last diff was read after they stopped; a worker that works again leaves the set.
const finalDiffed = new Set<string>()
export async function pollDiffs($: EngineInterface) {
  if (diffing || !(await appModShown($))) return
  diffing = true
  try {
    const { board } = await gather($)
    const all = await jobs($)
    const kept = (await read($, state)).diffs ?? {}
    const got: NonNullable<BoardState['diffs']> = {}
    for (const r of board.rows) {
      const job = all[r.name]
      const k = kept[r.name]
      if (job && active(job)) finalDiffed.delete(r.name)
      // A worker that stopped (a blocked one counts as running again once answered) gets one last diff, for commits since the last poll; after that its branch no longer moves and it keeps that diff with no git calls.
      else if (!job || finalDiffed.has(r.name)) {
        if (k) got[r.name] = k
        continue
      } else finalDiffed.add(r.name)
      const d = await readDiff($, job.cwd).catch(() => null)
      if (d) got[r.name] = d
      else if (!active(job) && k) got[r.name] = k
    }
    if (JSON.stringify(got) === JSON.stringify(kept)) return
    await update($, state, s => ({ ...s, diffs: got }))
  } finally {
    diffing = false
  }
}

export async function pollPrs($: EngineInterface) {
  // Polls while the app mod draws the boards: its pop-up's CI column reads these PRs.
  if (polling || !(await appModShown($))) return
  polling = true
  try {
    const { v, tasks, now } = await gather($)
    const listed = new Set(tasks.filter(t => t.pr && t.repo).map(t => `${t.repo}#${t.pr}`))
    // A merged PR is asked once more when it has no merge time yet (one stored before `mergedAt`); null (gh gave none) is an answer.
    const want = [...listed]
      .filter(k => v.prs[k]?.state !== 'CLOSED' && (v.prs[k]?.state !== 'MERGED' || v.prs[k]?.mergedAt === undefined))
      // The longest unread first: past PR_POLL_MAX, the others get their turn at the next poll.
      .sort((a, b) => (v.prs[a]?.at ?? 0) - (v.prs[b]?.at ?? 0))
    const got: Record<string, Pr> = {}
    let failed = ''
    for (const k of want.slice(0, PR_POLL_MAX)) {
      const [repo = '', n = ''] = k.split('#')
      try {
        const ran = await $.process.run(
          ['gh', 'pr', 'view', n, '-R', repo, '--json', 'state,mergedAt,statusCheckRollup,mergeable,baseRefName,files,headRefOid'],
          { timeoutMs: 20_000 },
        )
        if (ran.exitCode !== 0) {
          failed = ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`
          continue
        }
        const pr = JSON.parse(ran.stdout) as {
          state: Pr['state']
          mergedAt?: string | null
          statusCheckRollup?: Check[]
          mergeable?: string
          baseRefName?: string
          files?: { path: string }[]
          headRefOid?: string
        }
        const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN
        got[k] = {
          state: pr.state,
          ci: ciOf(pr.statusCheckRollup ?? []),
          at: now,
          mergedAt: Number.isFinite(mergedAt) ? mergedAt : null,
          ...(pr.state === 'OPEN'
            ? {
                // UNKNOWN only means GitHub is still working it out, and asking starts that: the last answer stands until the next poll.
                conflict: pr.mergeable === 'UNKNOWN' ? (v.prs[k]?.conflict ?? false) : pr.mergeable === 'CONFLICTING',
                base: pr.baseRefName ?? 'base',
                files: (pr.files ?? []).map(f => f.path),
                ...(await failureOf($, k, pr.statusCheckRollup ?? [], pr.headRefOid ?? '', v.prs[k]?.failure)),
              }
            : {}),
        }
      } catch (err) {
        failed = String(err)
      }
    }
    const isStale = Object.keys(v.prs).some(k => !listed.has(k))
    const allFailed = failed && Object.keys(got).length === 0
    if (!Object.keys(got).length && !isStale && !allFailed) return
    // Only the PRs the table still lists are kept.
    await update($, state, s => ({
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
    ownLiveFields(await $.clock.now()),
    b.rows,
    b.wrapUp,
    b.target,
    b.context,
    await read($, state),
    await isOrchestrating($),
    await openQuestions($),
    await pinnedItems($),
    await answered($),
    await jobs($),
  ])
}

// The board as plain data for the Herdr app and Discord (see bridge.ts and docs/board-schema.json).
export async function boardSnapshot($: EngineInterface) {
  const { v, board, now, open, todos, items, isLive, endOf, tasks, all } = await gather($)
  const busy = board.rows.filter(r => r.state !== 'reported' && r.state !== 'waiting').length
  const shares = sharedFiles(tasks, v.prs)
  const prOf = (t: Task) => (t.repo && t.pr ? v.prs[`${t.repo}#${t.pr}`] : undefined)
  // The newest review among a task's jobs replaces the older ones.
  const reviewOf = (t: Task) => {
    const j = t.jobs.filter(x => x.review).sort((a, b) => b.review!.at - a.review!.at)[0]
    return j ? { from: j.name, verdict: j.review!.verdict, blockers: j.review!.blockers, head: j.review!.head ?? null } : null
  }
  return {
    version: BOARD_VERSION,
    session: await $.session.id(),
    cwd: session.cwd,
    at: now,
    // The hc terminal this coordinator runs in (null outside hc); an app finds the board by it.
    coordinator: {
      terminal: (await $.env.get('HC_TERMINAL_ID')) || null,
      ...((await $.env.get('HERDR_PANE_ID')) ? { pane: await $.env.get('HERDR_PANE_ID') } : {}),
      orchestrating: await isOrchestrating($),
      ...ownLiveFields(now),
    },
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
      ...(r.provider ? { provider: r.provider } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.worktree ? { worktree: r.worktree } : {}),
      ...(r.branch ? { branch: r.branch } : {}),
      ...(r.pane ? { pane: r.pane } : {}),
      ...(r.outputAt === undefined ? {} : { command: r.command ?? null, commandAt: r.commandAt ?? null, outputAt: r.outputAt }),
      ...(r.context === undefined ? {} : { context: r.context }),
      ...(v.diffs?.[r.name] ? { diff: v.diffs[r.name] } : {}),
    })),
    tasks: tasks.map(t => ({
      key: t.key,
      label: t.label,
      title: t.title,
      repo: t.repo ?? null,
      pr: t.pr ?? null,
      url: ghUrl(t) ?? null,
      stages: t.stages,
      who: t.who,
      now: t.now,
      item: t.item ?? null,
      tab: t.tab ?? null,
      workers: t.jobs.map(j => j.name),
      isFinished: t.isFinished,
      isMerged: t.isMerged,
      mergedAt: t.mergedAt ?? null,
      ciFailure: prOf(t)?.state === 'OPEN' && prOf(t)?.ci === 'fail' ? failureForBoard(prOf(t)?.failure) : null,
      conflictsWith: prOf(t)?.state === 'OPEN' && prOf(t)?.conflict ? (prOf(t)?.base ?? null) : null,
      shares: shares.get(t.key) ?? [],
      review: reviewOf(t),
    })),
    next: nextOnBoard(v.next ?? [], all),
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

// What an app asks of the board.
export type BoardAction =
  | { action: 'answer'; key: string; answer: string }
  | { action: 'done'; key: string }
  | { action: 'clearDone'; what?: 'items' | 'tasks' }
  | { action: 'wrapUp'; on: boolean }
  | { action: 'stop'; worker: string }
  | { action: 'interrupt'; worker: string }

// Does it and says what came of it; throws when the item is not open or the action unknown.
export async function boardAct($: EngineInterface, a: BoardAction): Promise<string> {
  const g = await gather($)
  const keep = (key: string, answer: string, status: string) =>
    update($, state, s => ({
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
      const items = a.what !== 'tasks'
      const tasks = a.what !== 'items'
      await update($, state, s => ({
        ...s,
        ...(items
          ? {
              items: s.items.filter(it => !resolved.some(r => r.key === it.key)),
              answers: Object.fromEntries(Object.entries(s.answers).filter(([k]) => !resolved.some(r => r.key === k))),
            }
          : {}),
        ...(tasks ? { cleared: { ...s.cleared, ...Object.fromEntries(finished.map(t => [t.key, t.jobs.length])) } } : {}),
      }))
      return `cleared ${(items ? resolved.length : 0) + (tasks ? finished.length : 0)} done`
    }
    case 'wrapUp':
      await toggleWrapUp($, a.on)
      return a.on ? 'wrapping up' : 'keep going'
    case 'stop': {
      const stopped = await stopWorker($, { worker: a.worker })
      if ('deny' in stopped) throw new Error(stopped.deny)
      return `stopped ${a.worker}`
    }
    case 'interrupt': {
      const done = await interruptWorker($, { worker: a.worker }, true)
      if ('deny' in done) throw new Error(done.deny)
      return `interrupted ${a.worker}`
    }
    default:
      throw new Error(`unknown action ${JSON.stringify((a as { action?: unknown }).action)}`)
  }
}

// The task's PR on GitHub, else its issue.
function ghUrl(t: Task) {
  const n = t.pr ?? t.refs[0]
  return t.repo && n ? `https://github.com/${t.repo}/${t.pr ? 'pull' : 'issues'}/${n}` : undefined
}
