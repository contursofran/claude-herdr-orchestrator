import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Decision, Settled, Todo } from '../types'
import { SETTLED_MS } from './defaults'
import { notify } from './hc'
import { post } from './outbox'

// What waits on the person: questions (ask_owner, workers' DECISION: lines) and
// to-dos (pin_for_owner), pinned on the band until answered or ticked off.

const decisions = atom({ plugin: 'herdr-agents', key: 'decisions' } as const, [] as Decision[])
const settled = atom({ plugin: 'herdr-agents', key: 'settled' } as const, [] as Settled[])
const lastId = atom({ plugin: 'herdr-agents', key: 'lastId' } as const, 0)
const todos = atom({ plugin: 'herdr-agents', key: 'todos' } as const, [] as Todo[])
const lastTodo = atom({ plugin: 'herdr-agents', key: 'lastTodo' } as const, 0)

// A decision's name in a list: its title, else the question's first words.
export function decisionTitle(d: Decision) {
  return (
    d.title ??
    d.question
      .replace(/^\s*(TEST \(ignore\)\s*:?\s*)?(Q\d+\s*:\s*)?([#\w-]*\d+\s*:?\s*)?/i, '')
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .split(/\s+/)
      .slice(0, 4)
      .join(' ')
      .replace(/[?:,.;]+$/, '')
  )
}

export function openQuestions($: EngineInterface) {
  return read($, decisions)
}
export function answered($: EngineInterface) {
  return read($, settled)
}
export function pinnedItems($: EngineInterface) {
  return read($, todos)
}

// Pins a question for the person on the band and notifies them. A `quiet` one
// (a worker's DECISION: line) waits for the coordinator to read it first: see
// pingQuiet. Ids never repeat within a session, so a stale id cannot close a
// newer question.
export async function ask(
  $: EngineInterface,
  from: string,
  question: string,
  options?: string[],
  recommended?: number,
  title?: string,
  quiet = false,
  token?: string,
) {
  const at = await $.clock.now()
  const used = [...(await read($, decisions)), ...(await read($, settled))].map(d => d.id)
  let id = 0
  await update($, lastId, n => (id = Math.max(n, 0, ...used) + 1))
  await update($, decisions, list => [
    ...list,
    {
      id,
      from,
      question,
      at,
      ...(title ? { title } : {}),
      ...(options?.length ? { options, recommended } : {}),
      ...(quiet ? { quiet } : {}),
      ...(token ? { token } : {}),
    },
  ])
  if (!quiet) notify($, `Decision D${id} needed (${from})`, question)
  return id
}

// Pings the person for the quiet questions `pick` selects, once.
export async function pingQuiet($: EngineInterface, pick: (d: Decision) => boolean) {
  let due: Decision[] = []
  await update($, decisions, list => {
    due = list.filter(d => d.quiet && pick(d))
    return due.length ? list.map(d => (due.includes(d) ? { ...d, quiet: false } : d)) : list
  })
  if (due.length === 1) notify($, `Decision D${due[0]!.id} needed (${due[0]!.from})`, due[0]!.question)
  else if (due.length > 1) notify($, `${due.length} decisions need you`, due.map(d => `D${d.id} ${d.title ?? d.question}`).join(' · '))
}

// The person picked an answer on the band: unpin it and hand it to the model.
export async function choose($: EngineInterface, d: Decision, answer: string) {
  await update($, decisions, list => list.filter(x => x.id !== d.id))
  $.ui.toast(`D${d.id}: ${answer}`)
  await post(
    $,
    [
      `<herdr-decision id="D${d.id}" from="${d.from}">`,
      `Question: ${d.question}`,
      `The owner chose: ${answer}`,
      'It is already unpinned. Act on it now (tell the worker with message).',
      '</herdr-decision>',
    ].join('\n'),
  )
}

// Pins one line for the person at the top of the band. The same text already
// pinned keeps its id. Ids never repeat within a session.
export async function pin($: EngineInterface, text: string, kind: Todo['kind'], from: string) {
  const same = (await read($, todos)).find(t => t.text === text)
  if (same) return { id: same.id, isNew: false }
  const at = await $.clock.now()
  let id = 0
  await update($, lastTodo, n => (id = n + 1))
  await update($, todos, list => [...list, { id, kind, text, from, at }])
  if (kind === 'do') notify($, `For you: T${id}`, text)
  else $.ui.toast(`T${id}: ${text}`)
  return { id, isNew: true }
}

// The person ticked an item off on the band: unpin it and, for a `do` item,
// tell the model, which may be waiting on it (a merge, a test).
export async function tick($: EngineInterface, t: Todo) {
  await update($, todos, list => list.filter(x => x.id !== t.id))
  if (t.kind !== 'do') return
  await post(
    $,
    [
      `<herdr-owner-done id="T${t.id}" from="${t.from.replace(/"/g, "'")}">`,
      `The owner ticked off: ${t.text}`,
      'It is already unpinned. Carry on from it (check it, tell the worker with message).',
      '</herdr-owner-done>',
    ].join('\n'),
  )
}

// The items pinned for the person, for the compaction summary to keep.
export async function pinned($: EngineInterface) {
  return (await read($, todos)).map(t => `- T${t.id} (${t.kind}, ${t.from}): ${t.text}`).join('\n')
}

// The main-loop turn reading worker reports, and the workers whose reports it reads:
// their DECISION: questions ping the person once that turn ends, unless it settled them.
let reading: { turnId: string; names: Set<string> } | undefined

export function noteReports(turnId: string, text: string) {
  const names = new Set([...text.matchAll(/<herdr-agent name="([^"]+)"/g)].map(m => m[1]!))
  reading = names.size ? { turnId, names } : undefined
}

export async function pingAfterReports($: EngineInterface, turnId: string) {
  if (reading?.turnId !== turnId) return
  const { names } = reading
  reading = undefined
  await pingQuiet($, d => names.has(d.from))
}

export type AskArgs = { question: string; title?: string; options?: string[]; recommended?: number; from?: string }

export async function askOwner($: EngineInterface, e: AskArgs) {
  const id = await ask($, e.from ?? 'coordinator', e.question, e.options, e.recommended, e.title)
  return { result: `Pinned as D${id} and notified the person. Call decided with "D${id}" once they answer.` }
}

// Takes down open questions without settling them (not asked, not answered): a worker's rewritten report
// pins its changed question anew, and the old pin must not stay beside it.
export async function withdraw($: EngineInterface, ids: number[]) {
  if (!ids.length) return
  await update($, decisions, list => (list.some(d => ids.includes(d.id)) ? list.filter(d => !ids.includes(d.id)) : list))
}

export type DecidedArgs = { ids: string[]; answer: string; by: string }

export async function settle($: EngineInterface, e: DecidedArgs) {
  const ids = new Set((e.ids as string[]).map(s => Number(String(s).replace(/^D/i, ''))))
  const by: Settled['by'] = e.by === 'owner' ? 'owner' : 'coordinator'
  const answer = String(e.answer ?? '').trim() || 'closed'
  const at = await $.clock.now()
  let gone: Decision[] = []
  let left = 0
  await update($, decisions, list => {
    gone = list.filter(d => ids.has(d.id))
    const kept = list.filter(d => !ids.has(d.id))
    left = kept.length
    return kept
  })
  if (gone.length) {
    await update($, settled, list => [
      ...list.filter(x => at - x.at < SETTLED_MS),
      ...gone.map(d => ({
        id: d.id,
        from: d.from,
        question: d.question,
        ...(d.title ? { title: d.title } : {}),
        ...(d.token ? { token: d.token } : {}),
        answer,
        by,
        at,
      })),
    ])
    const names = gone.map(d => `D${d.id}${d.title ? ` ${d.title}` : ''}`).join(', ')
    // A question the person was already pinged for gets a toast;
    // a quiet one they never heard of only shows on the band.
    if (by === 'coordinator' && gone.some(d => !d.quiet)) notify($, `${names} settled by coordinator`, answer)
    else $.ui.toast(`${names} settled by ${by}: ${answer}`)
  }
  const missing = [...ids].filter(id => !gone.some(d => d.id === id)).map(id => `D${id}`)
  return {
    result: `Unpinned ${gone.length}.${missing.length ? ` Not pinned (already answered or wrong id): ${missing.join(', ')}.` : ''} ${left} question(s) still wait for the person.`,
  }
}

export type PinArgs = { text: string; kind?: string; from?: string }

export async function pinForOwner($: EngineInterface, e: PinArgs) {
  const text = String(e.text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return { deny: 'text is empty' }
  const from = String(e.from ?? '').trim() || 'coordinator'
  const { id, isNew } = await pin($, text, e.kind === 'know' ? 'know' : 'do', from)
  return { result: `${isNew ? 'Pinned' : 'Already pinned'} as T${id}. Unpin it with unpin_for_owner once it is done.` }
}

export async function unpinForOwner($: EngineInterface, e: { ids?: string[] }) {
  const ids = new Set(((e.ids ?? []) as string[]).map(s => Number(String(s).replace(/^T/i, ''))))
  let gone: Todo[] = []
  let left = 0
  await update($, todos, list => {
    gone = list.filter(t => ids.has(t.id))
    const kept = list.filter(t => !ids.has(t.id))
    left = kept.length
    return kept
  })
  const missing = [...ids].filter(id => !gone.some(t => t.id === id)).map(id => `T${id}`)
  return {
    result: `Unpinned ${gone.length}.${missing.length ? ` Not pinned (already done or wrong id): ${missing.join(', ')}.` : ''} ${left} item(s) still pinned for the person.`,
  }
}
