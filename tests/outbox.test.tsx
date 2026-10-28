import { expect, test } from 'claude-code/testing'
import { BATCH_MS, JOBS_KEEP_MS } from '../hooks/defaults'
import { spawn, start, stopAll } from './harness'

// The outbox (outbox.ts): the prompts for the coordinator that come close together go out as one,
// after a quiet BATCH_MS and once the coordinator's turn has ended. The batch's tick checks read
// RESULT.md every 3 s, so a report written now is delivered within 3 s and sent BATCH_MS after that.

const INBOX = '/home/t/.herdr-agents/board/session-1234.actions'
const turnEnd = (turnId: string) => ({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' as const })

test('two reports that land together reach the coordinator as one prompt, with one worker count', async ($, on) => {
  const { clock, emit, submitted, typed, files } = await start($, on)
  await spawn($, ['w-a', 'w-b'])
  for (const w of ['w-a', 'w-b']) await emit(w, 'working')
  const [tokenA, tokenB] = typed.map(t => t.match(/<!-- report (\S+) -->/)?.[1])
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${tokenA} -->\nReviewed: approve.`
  files['/repo-w-b/.herdr-agents/w-b/RESULT.md'] = `<!-- report ${tokenB} -->\nReviewed: two blockers.`
  await clock.advance(2 * 3000)
  await clock.advance(BATCH_MS)
  expect(submitted).toHaveLength(1)
  // Both elements in one prompt. Their order is the order the tick delivered them in, which the test does not fix.
  expect(submitted[0]).toMatch(/<herdr-agent name="w-a"/)
  expect(submitted[0]).toMatch(/<herdr-agent name="w-b"/)
  expect(submitted[0]?.match(/workers working/g)).toHaveLength(1)
  await stopAll($, clock, ['w-a', 'w-b'])
})

test('a report that lands while a coordinator turn runs waits for the turn to end, and joins the next batch', async ($, on) => {
  const { clock, emit, submitted, typed, files } = await start($, on)
  await spawn($, ['w-a', 'w-b'])
  for (const w of ['w-a', 'w-b']) await emit(w, 'working')
  const [tokenA, tokenB] = typed.map(t => t.match(/<!-- report (\S+) -->/)?.[1])
  await $.turn.start({ text: 'Check the reports.', turnId: 't1' })
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${tokenA} -->\nReviewed: approve.`
  await clock.advance(10_000)
  await clock.advance(30_000)
  // Held while the turn runs: a prompt sent now would only queue behind it.
  expect(submitted).toEqual([])
  files['/repo-w-b/.herdr-agents/w-b/RESULT.md'] = `<!-- report ${tokenB} -->\nReviewed: two blockers.`
  await clock.advance(3000)
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(10_000)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/<herdr-agent name="w-a"/)
  expect(submitted[0]).toMatch(/<herdr-agent name="w-b"/)
  await stopAll($, clock, ['w-a', 'w-b'])
})

test("a held batch survives a reload and goes out once; other sessions' copies that are days old are removed", async ($, on) => {
  const held = {
    at: 990_000,
    items: [{ text: '<herdr-agent name="w-x" profile="builder" status="done">\nDone.\n</herdr-agent>', report: true }],
  }
  const stale = { at: 1_000_000 - JOBS_KEEP_MS - 1, items: [{ text: 'an old answer' }] }
  const recent = { at: 999_000, items: [{ text: 'a recent answer' }] }
  const { clock, submitted, store } = await start($, on, {}, { 'outbox:session-1234': held, 'outbox:old': stale, 'outbox:recent': recent })
  await clock.advance(BATCH_MS)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^<herdr-agent name="w-x" profile="builder" status="done">\nDone\.\n<\/herdr-agent>/)
  expect(store.has('outbox:session-1234')).toBe(false)
  expect(store.has('outbox:old')).toBe(false)
  expect(store.get('outbox:recent')).toEqual(recent)
  await clock.advance(BATCH_MS)
  expect(submitted).toHaveLength(1)
})

test('a prompt the session refuses is kept, and goes out with the next batch', async ($, on) => {
  const { clock, emit, submitted, typed, files, refuse } = await start($, on)
  await spawn($, ['w-a', 'w-b'])
  for (const w of ['w-a', 'w-b']) await emit(w, 'working')
  const [tokenA, tokenB] = typed.map(t => t.match(/<!-- report (\S+) -->/)?.[1])
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${tokenA} -->\nReviewed: approve.`
  refuse.next = 1
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(submitted).toEqual([])
  files['/repo-w-b/.herdr-agents/w-b/RESULT.md'] = `<!-- report ${tokenB} -->\nReviewed: two blockers.`
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^<herdr-agent name="w-a"[\s\S]*\n\n<herdr-agent name="w-b"/)
  await stopAll($, clock, ['w-a', 'w-b'])
})

test('an owner answer and a report that arrive together go out as one prompt', async ($, on) => {
  const { clock, emit, submitted, typed, files } = await start($, on)
  await spawn($, ['w-a'])
  for (const w of ['w-a']) await emit(w, 'working')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await $.tool.call({ tool: 'mcp__herdr-agents__ask_owner', question: 'Ship it today?', options: ['Yes', 'No'], from: 'p-1' })
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  // The first tick sees the report; the answer comes in at the second, with the report's delivery.
  await clock.advance(3000)
  files[`${INBOX}/1-answer.json`] = JSON.stringify({ action: 'answer', key: 'D1', answer: 'Yes' })
  await clock.advance(3000 + BATCH_MS)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^<herdr-agent name="w-a"[\s\S]*\n\n<herdr-decision id="D1" from="p-1">[\s\S]*The owner chose: Yes/)
  await stopAll($, clock, ['w-a'])
})

test('an owner answer that goes out alone carries no worker count', async ($, on) => {
  const { clock, submitted, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__ask_owner', question: 'Ship it today?', options: ['Yes', 'No'], from: 'p-1' })
  files[`${INBOX}/1-answer.json`] = JSON.stringify({ action: 'answer', key: 'D1', answer: 'Yes' })
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^<herdr-decision id="D1" from="p-1">/)
  expect(submitted[0]).not.toContain('workers working')
})

test('a wrap-up goes out at once, not in the batch: the answer waiting for its batch comes after it', async ($, on) => {
  const { clock, submitted, files } = await start($, on)
  await spawn($, ['w-a'])
  await $.tool.call({ tool: 'mcp__herdr-agents__ask_owner', question: 'Ship it today?', options: ['Yes', 'No'], from: 'p-1' })
  files[`${INBOX}/1-answer.json`] = JSON.stringify({ action: 'answer', key: 'D1', answer: 'Yes' })
  files[`${INBOX}/2-wrap.json`] = JSON.stringify({ action: 'wrapUp', on: true })
  await clock.advance(3000)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^<herdr-context>The owner is wrapping up/)
  await clock.advance(BATCH_MS)
  expect(submitted).toHaveLength(2)
  expect(submitted[1]).toMatch(/^<herdr-decision id="D1" from="p-1">/)
  await stopAll($, clock, ['w-a'])
})

test('a loop that wakes after a reload emptied $.state sends no empty prompt; the held batch goes out once after the restore', async ($, on) => {
  // A reload empties $.state while a batch's loop sleeps, and the store keeps its copy. The kit gives
  // each session its own module, so the two loops of a real reload cannot be staged; this stages the
  // empty flush they would cause: the loop wakes with no items.
  let lost = false
  // The state as a reload leaves it: empty, at the version the engine holds.
  on('state.get', async (_, e, next) => {
    const read = await next(e)
    if (!read.value || !lost || e.key !== 'outbox') return read
    return { value: { value: [], version: read.value.version } }
  })
  const { clock, submitted, files, store } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__ask_owner', question: 'Ship it today?', options: ['Yes', 'No'], from: 'p-1' })
  files[`${INBOX}/1-answer.json`] = JSON.stringify({ action: 'answer', key: 'D1', answer: 'Yes' })
  await clock.advance(3000)
  lost = true
  await clock.advance(BATCH_MS)
  expect(submitted).toEqual([])
  // Nothing was sent, so the copy in the store is still there for the restore.
  expect(store.has('outbox:session-1234')).toBe(true)
  lost = false
  // The reload's start restores the copy in the store, and its batch goes out after the quiet.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(BATCH_MS + 3000)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^<herdr-decision id="D1" from="p-1">/)
  expect(store.has('outbox:session-1234')).toBe(false)
  await clock.advance(BATCH_MS)
  expect(submitted).toHaveLength(1)
})

test('a prompt the session refused goes out on the next sweep, with no new report or turn end', async ($, on) => {
  const { clock, submitted, typed, files, refuse } = await start($, on)
  await spawn($, ['w-a'])
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  refuse.next = 1
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(submitted).toEqual([])
  // Nothing else comes in before the sweep at 60 s: it is what tries again.
  await clock.advance(50_000)
  expect(submitted).toEqual([])
  await clock.advance(10_000)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/^<herdr-agent name="w-a"/)
  await stopAll($, clock, ['w-a'])
})

test('a turn whose decision ping throws still ends, so a report that comes later goes out', async ($, on) => {
  // The ping reads the decisions; a read that gives no list makes it throw.
  let unreadable = false
  on('state.get', async (_, e, next) => {
    const read = await next(e)
    if (!read.value || !unreadable || e.key !== 'decisions') return read
    return { value: { value: null, version: read.value.version } }
  })
  const { clock, emit, submitted, typed, files } = await start($, on)
  await spawn($, ['w-a', 'w-b'])
  for (const w of ['w-a', 'w-b']) await emit(w, 'working')
  const [tokenA, tokenB] = typed.map(t => t.match(/<!-- report (\S+) -->/)?.[1])
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${tokenA} -->\nDECISION: Ship it today? | Yes | No`
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(submitted).toHaveLength(1)
  // The coordinator's turn reads the report; its end pings the person for the question, and the ping throws
  // (the engine skips the turn.complete hook, so the turn still ends).
  await $.turn.start({ text: submitted[0] ?? '', turnId: 't1' })
  unreadable = true
  await $.turn.complete(turnEnd('t1'))
  unreadable = false
  files['/repo-w-b/.herdr-agents/w-b/RESULT.md'] = `<!-- report ${tokenB} -->\nReviewed: approve.`
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(submitted).toHaveLength(2)
  expect(submitted[1]).toMatch(/^<herdr-agent name="w-b"/)
  await stopAll($, clock, ['w-a', 'w-b'])
})
