import type { Job, Pr, Row } from '../types'
import { ago } from './format'

// The sidebar's work table: one row per issue or PR, the workers on it grouped by the
// numbers their briefs and reports name (the planner, the builders and fix rounds, the
// reviewer of the PR a builder linked), with a mark per stage.

// The brief's first line and the issue or PR it names: its first #123 ("PR #123" is a PR),
// else the number after a worker name's role letters (b513-c1, p-640).
export function briefRefs(task: string, worker: string): Pick<Job, 'brief' | 'refs' | 'prs'> {
  const brief = (task.split('\n').find(l => l.trim()) ?? '')
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, 200)
  const m = brief.match(/(PR\s*)?#(\d{1,6})\b/i)
  const n = Number(m?.[2] ?? worker.match(/^[a-z]{1,3}-?(\d{2,6})(?!\d)/i)?.[1])
  return {
    ...(brief ? { brief } : {}),
    ...(n ? { refs: [n] } : {}),
    ...(n && m?.[1] ? { prs: [n] } : {}),
  }
}

// Adds the PR a report linked.
export function withPr(job: Job, pr: number | undefined): Job {
  if (!pr || job.prs?.includes(pr)) return job
  return { ...job, refs: [...new Set([...(job.refs ?? []), pr])], prs: [...(job.prs ?? []), pr] }
}

// A short title from a brief: what follows "#123 (" or "#123 ...:", else the whole line.
export function titleOf(brief: string) {
  const paren = brief.match(/#\d+\s*\(([^)]+)\)?/)?.[1]
  const colon = brief.match(/#\d+[^:]{0,40}:\s*(.+)$/)?.[1]
  return (
    (paren ?? colon ?? brief)
      .replace(/^(#\d+\s*)+/, '')
      .replace(/[.\s]+$/, '')
      .trim() || brief
  )
}

// plan, build, rev, CI, you: done ✓, running ◐, waiting ⏸, not started ·, a question ?,
// a to-do ☐ for the person, blocked ■.
export type Stage = 'done' | 'run' | 'wait' | 'none' | 'ask' | 'todo' | 'block'
export const STAGES = ['plan', 'build', 'rev', 'CI', 'you'] as const

// What waits on the person, as the table matches it to a task: by the worker it came
// from, or an issue or PR its text names (owner/repo#123, see refKey) that the task names.
export type ItemRef = { key: string; kind: 'ask' | 'do' | 'know'; from: string; text: string; refs: string[]; isOpen: boolean }

// An issue or PR as the table keys it: owner/repo#123, or #123 when no repo is known.
export const refKey = (repo: string | undefined, n: number) => `${repo ?? ''}#${n}`
// A task's or slot's key as the table's # column shows it.
export const labelOf = (key: string) => (key.includes('#') ? `#${key.split('#').pop()}` : key).slice(0, 7)

export type Task = {
  key: string
  label: string
  title: string
  repo?: string
  jobs: Job[]
  refs: number[]
  // the same, as refKey makes them: a slot whose task joined this one names one of them
  refKeys: string[]
  pr?: number
  stages: Stage[]
  // the right-hand column: `you` and `blocked` stand out, `dim` is quiet
  who: { text: string; kind: 'you' | 'dim' | 'text' }
  // one sentence for the box: who is on it and what it waits for
  now: string
  // the open decision or to-do it waits on, and the worker whose tab to focus
  item?: string
  tab?: string
  // nothing runs and nothing waits on the person: Clear done may remove it
  isFinished: boolean
  isMerged: boolean
}

type Input = {
  jobs: Job[]
  rows: Row[]
  items: ItemRef[]
  prs: Record<string, Pr>
  now: number
  // the repo a brief names, else the worker folder's
  repoOf: (job: Job) => string | undefined
}

const role = (profile: string) => (profile === 'planner' ? 0 : profile === 'reviewer' ? 2 : 1)
const CI = /\bci\b|check|workflow|actions/i

export function groupTasks({ jobs, rows, items, prs, now, repoOf }: Input): Task[] {
  const sorted = [...jobs].sort((x, y) => x.startedAt - y.startedAt)
  const rowOf = new Map(rows.map(r => [r.name, r]))
  // Numbers count per repo: client #640 and server #640 are two tasks. A #640 whose repo is
  // unknown is the one repo's #640 that has one.
  const repoOfJob = new Map(sorted.map(j => [j.name, repoOf(j)]))
  const keyed = new Set(sorted.flatMap(j => (j.refs ?? []).map(n => refKey(repoOfJob.get(j.name), n))))
  const alias = (k: string) => {
    if (!k.startsWith('#')) return k
    const known = [...keyed].filter(x => !x.startsWith('#') && x.endsWith(k))
    return known.length === 1 ? known[0]! : k
  }
  const keysOf = (j: Job) => (j.refs ?? []).map(n => alias(refKey(repoOfJob.get(j.name), n)))
  // Workers that share an issue or PR are one task; the oldest names it.
  const root = new Map<string, Job>()
  const find = (j: Job): Job => {
    let r = j
    while (root.get(r.name) !== r) r = root.get(r.name)!
    return r
  }
  const byRef = new Map<string, Job>()
  for (const j of sorted) {
    root.set(j.name, j)
    for (const n of keysOf(j)) {
      const other = byRef.get(n)
      if (!other) byRef.set(n, j)
      else {
        const [a, b] = [find(other), find(j)]
        if (a !== b) root.set((a.startedAt <= b.startedAt ? b : a).name, a.startedAt <= b.startedAt ? a : b)
      }
    }
  }
  const groups = new Map<Job, Job[]>()
  for (const j of sorted) groups.set(find(j), [...(groups.get(find(j)) ?? []), j])

  const tasks: Task[] = []
  for (const [first, list] of groups) {
    const refs = [...new Set(list.flatMap(j => j.refs ?? []))]
    const refKeys = [...new Set(list.flatMap(keysOf))]
    const key = keysOf(first)[0] ?? first.name
    const repo = list.map(j => repoOfJob.get(j.name)).find(Boolean)
    const pr = list.flatMap(j => j.prs ?? []).at(-1)
    const names = new Set(list.map(j => j.name))
    const mine = items.filter(it => names.has(it.from) || it.refs.some(r => refKeys.includes(alias(r))))
    const open = mine.filter(it => it.isOpen)
    const todo = open.find(it => it.kind === 'do')
    const ask = open.find(it => it.kind === 'ask')

    const stageOf = (j: Job): Stage => {
      if (j.status === 'reported') return 'done'
      const state = rowOf.get(j.name)?.state
      return state === 'waiting' ? 'wait' : state === 'blocked' || state === 'gone' ? 'block' : state === 'done' ? 'done' : 'run'
    }
    const latest = [0, 1, 2].map(r => list.filter(j => role(j.profile) === r).at(-1))
    const state = pr && repo ? prs[`${repo}#${pr}`] : undefined
    const running = list.filter(j => j.status === 'running')
    const waitingOnCi = running.some(j => j.wait && CI.test(j.wait.for))
    const ci: Stage = state
      ? state.state === 'MERGED' || state.ci === 'pass'
        ? 'done'
        : state.ci === 'fail'
          ? 'block'
          : state.ci === 'pending'
            ? 'run'
            : 'none'
      : waitingOnCi
        ? 'wait'
        : 'none'
    const you: Stage = ask ? 'ask' : todo ? 'todo' : mine.some(it => it.kind !== 'know') ? 'done' : 'none'
    const stages: Stage[] = [...latest.map(j => (j ? stageOf(j) : 'none')), ci, you]

    const blocked = running.find(j => stageOf(j) === 'block')
    const working = running.filter(j => stageOf(j) === 'run').at(-1)
    const waiting = running.find(j => stageOf(j) === 'wait')
    const last = list.at(-1)!
    const isMerged = state?.state === 'MERGED'
    const what = (j: Job) => `${j.name} (${j.profile})`
    const also = ask && (working || waiting) ? ` ${ask.key} waits for you.` : ''
    let who: Task['who']
    let said: string
    const isGone = blocked && rowOf.get(blocked.name)?.state === 'gone'
    if (blocked && isGone) {
      who = { text: 'tab gone', kind: 'you' }
      said = `${what(blocked)} lost its herdr tab before it reported. Start it again or stop it.`
    } else if (blocked) {
      who = { text: 'blocked', kind: 'you' }
      said = `${what(blocked)} waits at a prompt in its tab. Answer it there.`
    } else if (todo) {
      who = { text: 'you', kind: 'you' }
      said = `It waits for you: ${todo.key}, ${todo.text}`
    } else if (working) {
      who = { text: `${working.name} ${ago(now - working.startedAt)}`, kind: 'text' }
      said = `${what(working)} is working (${ago(now - working.startedAt) === 'now' ? 'just started' : ago(now - working.startedAt)}).${also}`
    } else if (waiting) {
      who = { text: waitingOnCi ? 'ci' : 'waits', kind: 'dim' }
      said = `${what(waiting)} waits: ${waiting.wait?.for ?? 'WAIT.json'}.${also}`
    } else if (ask) {
      who = { text: ask.key, kind: 'dim' }
      said = `It waits for your answer to ${ask.key}.`
    } else if (isMerged) {
      who = { text: 'merged', kind: 'dim' }
      said = `PR #${pr} is merged.`
    } else {
      who = { text: 'done', kind: 'dim' }
      said = `${what(last)} reported${last.endedAt ? ` ${ago(now - last.endedAt)} ago` : ''}.`
    }
    tasks.push({
      key,
      label: labelOf(key),
      title: titleOf(first.brief ?? first.name),
      ...(repo ? { repo } : {}),
      jobs: list,
      refs,
      refKeys,
      ...(pr ? { pr } : {}),
      stages,
      who,
      now: said,
      ...((todo ?? ask) ? { item: (todo ?? ask)!.key } : {}),
      ...((isGone ? undefined : (blocked ?? working ?? waiting)) ? { tab: (blocked ?? working ?? waiting)!.name } : {}),
      isFinished: running.length === 0 && open.length === 0,
      isMerged,
    })
  }
  return tasks
}
