import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { OutboxItem } from '../types'
import { BATCH_MS, JOBS_KEEP_MS, OUTBOX_PREFIX } from './defaults'
import { belowTarget } from './target'

// The prompts for the coordinator that come close together go out as one: reports (each a
// <herdr-agent> element), the owner's answers and the to-dos they ticked. An item waits until
// BATCH_MS have passed since the last one and since the coordinator's turn ended, and nothing
// is sent while a turn runs: a prompt sent then would only queue behind it. The outbox is also
// kept in $.store, so a reload finds what it held (see restoreOutbox).

const outbox = atom({ plugin: 'herdr-agents', key: 'outbox' } as const, [] as OutboxItem[])

// Whether a main-loop turn runs, when an item last came in or a turn last ended, and whether
// a loop is waiting to flush (only one at a time). A reload resets busy to false, so a batch can
// go out during a turn that was running before it: that is acceptable, as the prompt only queues
// behind that turn and nothing is lost.
let busy = false
let lastAt = 0
let flushing = false

// The main loop's turn started or ended (register.tsx).
export function turnStarted() {
  busy = true
}
export async function turnEnded($: EngineInterface) {
  busy = false
  lastAt = await $.clock.now()
  void kick($)
}

// Whether a main-loop turn runs (the state file's block is not written then, see stateblock.ts).
export function turnRunning() {
  return busy
}

// Queues a prompt for the coordinator. A batch with a report ends with the worker count (see flush).
export async function post($: EngineInterface, text: string, report = false) {
  const item: OutboxItem = report ? { text, report: true } : { text }
  await update($, outbox, list => [...list, item])
  lastAt = await $.clock.now()
  await save($)
  void kick($)
}

// The sweep's tick (register.tsx): a batch that a refused prompt kept goes out without a new post or turn's end.
export function retry($: EngineInterface) {
  void kick($)
}

// Waits for the quiet and flushes, while items are held. A post or a turn's end that finds the
// loop running needs nothing more: the loop looks again after its wait.
async function kick($: EngineInterface) {
  if (flushing) return
  flushing = true
  try {
    while ((await read($, outbox)).length > 0) {
      await $.clock.sleep(BATCH_MS)
      // A turn is running: its end starts the loop again.
      if (busy) return
      if ((await $.clock.now()) - lastAt < BATCH_MS) continue
      // A prompt that could not be sent keeps its items; the next post, turn's end or sweep tries again.
      if (!(await flush($))) return
    }
  } catch {
    // Background work: a failed step ends the loop, and the next post or turn's end starts it again.
  } finally {
    flushing = false
  }
}

// Takes the held items and sends them as one prompt. False when the send failed: the items go back.
// With no items there is nothing to send: a loop that wakes after a reload emptied the state sends
// no empty prompt, and the copy in $.store is left for the restore.
async function flush($: EngineInterface): Promise<boolean> {
  let items: OutboxItem[] = []
  await update($, outbox, list => {
    items = list
    return []
  })
  if (items.length === 0) return true
  try {
    let text = items.map(i => i.text).join('\n\n')
    if (items.some(i => i.report)) text += await belowTarget($)
    await save($)
    await $.prompt.submit({ text: text.trim() })
    return true
  } catch (err) {
    await update($, outbox, list => [...items, ...list])
    await save($)
    $.ui.toast(`herdr-agents: a prompt for the coordinator was not sent (${err}); it goes with the next one`)
    return false
  }
}

// The held items in $.store under the session's key, or none once they are out.
async function save($: EngineInterface) {
  const items = await read($, outbox)
  const key = `${OUTBOX_PREFIX}${await $.session.id()}`
  if (items.length > 0) await $.store.set(key, { at: lastAt, items })
  else await $.store.delete(key)
}

// session.start: a reload may have left items held. $.state keeps the outbox only sometimes (as
// with the jobs), so its copy in $.store is taken when the state is empty, and the batch goes out
// at once. Other sessions' copies older than the jobs' are removed, as the jobs' copies are.
export async function restoreOutbox($: EngineInterface) {
  const now = await $.clock.now()
  const mine = `${OUTBOX_PREFIX}${await $.session.id()}`
  for (const key of await $.store.keys()) {
    if (!key.startsWith(OUTBOX_PREFIX) || key === mine) continue
    const { at = 0 } = ((await $.store.get(key)) ?? {}) as { at?: number }
    if (now - at > JOBS_KEEP_MS) await $.store.delete(key)
  }
  if ((await read($, outbox)).length === 0) {
    const kept = ((await $.store.get(mine)) ?? {}) as { at?: number; items?: OutboxItem[] }
    const items = kept.items ?? []
    if (items.length > 0) {
      lastAt = kept.at ?? 0
      await update($, outbox, () => items)
    }
  }
  void kick($)
}
