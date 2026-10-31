import { expect } from 'claude-code/testing'
import { actionFile, answerAction, doneAction } from '../app/mods/herdr-agents/model.js'
import { BATCH_MS } from '../hooks/defaults'
import { spawn, start, stopAll, test } from './harness'

// The board for apps outside Claude Code: a snapshot file per session, and action files
// that press the sidebar's buttons.

const DIR = '/home/t/.herdr-agents/board'
const FILE = `${DIR}/session-1234.json`
const INBOX = `${DIR}/session-1234.actions`

test('the board is written for outside apps, and their action files answer and tick as the sidebar does', async ($, on) => {
  const { clock, submitted, files } = await start($, on)
  await spawn($, ['w-busy'])
  await $.tool.call({
    tool: 'mcp__herdr-agents__ask_owner',
    question: 'Sort bags by type or by weight?',
    title: 'Bag sort',
    options: ['By type', 'By weight'],
    recommended: 0,
    from: 'p-640',
  })
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Test #642 at localhost:5173', kind: 'do', from: 'r-642' })
  await clock.advance(3000)

  const board = JSON.parse(files[FILE] ?? '{}')
  expect(board.version).toBe(1)
  expect(board.coordinator).toEqual({ terminal: 't1' })
  expect(board.stageNames).toEqual(['plan', 'build', 'rev', 'CI', 'you'])
  expect(board.workers.map((w: { name: string }) => w.name)).toEqual(['w-busy'])
  expect(board.summary.needs).toBe(2)
  const d1 = board.needs.find((n: { key: string }) => n.key === 'D1')
  expect(d1).toMatchObject({ kind: 'ask', title: 'Bag sort', isOpen: true, options: ['By type', 'By weight'], recommended: 0 })
  expect(board.needs.find((n: { key: string }) => n.key === 'T1')).toMatchObject({ kind: 'do', isOpen: true, url: 'localhost:5173' })
  expect(`${FILE}.tmp` in files).toBe(false)

  files[`${INBOX}/1-answer.json`] = JSON.stringify({ action: 'answer', key: 'D1', answer: 'By type' })
  files[`${INBOX}/2-done.json`] = JSON.stringify({ action: 'done', key: 'T1' })
  files[`${INBOX}/3-stale.json`] = JSON.stringify({ action: 'answer', key: 'D9', answer: 'x' })
  await clock.advance(3000 + BATCH_MS)

  // The coordinator gets the same prompts as from the sidebar.
  expect(submitted.some(t => t.includes('<herdr-decision id="D1"') && t.includes('The owner chose: By type'))).toBe(true)
  expect(submitted.some(t => t.includes('<herdr-owner-done id="T1"'))).toBe(true)
  const after = JSON.parse(files[FILE] ?? '{}')
  expect(after.needs.find((n: { key: string }) => n.key === 'D1')).toMatchObject({ isOpen: false, end: 'By type' })
  expect(after.needs.find((n: { key: string }) => n.key === 'T1')).toMatchObject({ isOpen: false, end: 'done' })
  expect(after.summary.needs).toBe(0)
  expect(after.actions).toEqual([
    { id: '1-answer.json', ok: true, message: 'D1 → By type' },
    { id: '2-done.json', ok: true, message: 'T1 done' },
    { id: '3-stale.json', ok: false, message: 'D9 is not an open decision' },
  ])
  expect(Object.keys(files).filter(f => f.startsWith(`${INBOX}/`))).toEqual([])

  // Clear done takes the closed items off, as the sidebar's button does.
  files[`${INBOX}/4-clear.json`] = JSON.stringify({ action: 'clearDone', what: 'items' })
  await clock.advance(3000)
  expect(JSON.parse(files[FILE] ?? '{}').needs).toEqual([])
  await stopAll($, clock, ['w-busy'])
})

test('the board says null for the coordinator terminal outside hc, and keeps the fields an old reader uses', async ($, on) => {
  const { clock, files } = await start($, on, {}, {}, { HC_TERMINAL_ID: '' })
  await clock.advance(3000)
  const board = JSON.parse(files[FILE] ?? '{}')
  expect(board.coordinator).toEqual({ terminal: null })
  expect(Object.keys(board)).toEqual(
    expect.arrayContaining(['version', 'session', 'cwd', 'at', 'stageNames', 'summary', 'workers', 'tasks', 'needs', 'status', 'actions']),
  )
  expect(board.version).toBe(1)
  expect(board.session).toBe('session-1234')
})

test("action files of the app mod's own shape (answerAction, doneAction, actionFile) are taken, once", async ($, on) => {
  const { clock, submitted, files } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__ask_owner',
    question: 'Sort bags by type or by weight?',
    title: 'Bag sort',
    options: ['By type', 'By weight'],
    recommended: 0,
    from: 'p-640',
  })
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Test #642 at localhost:5173', kind: 'do', from: 'r-642' })
  await clock.advance(3000)

  // What the card writes: a name from actionFile (time, then random), the body from the model's own builders.
  const answer = actionFile(1790000000000, 'ab12cd')
  const done = actionFile(1790000000001, 'ef34gh')
  files[`${INBOX}/${answer}`] = JSON.stringify(answerAction('D1', 'By type'))
  files[`${INBOX}/${done}`] = JSON.stringify(doneAction('T1'))
  await clock.advance(3000 + BATCH_MS)

  expect(submitted.filter(t => t.includes('<herdr-decision id="D1"') && t.includes('The owner chose: By type'))).toHaveLength(1)
  expect(submitted.filter(t => t.includes('<herdr-owner-done id="T1"'))).toHaveLength(1)
  const after = JSON.parse(files[FILE] ?? '{}')
  expect(after.actions).toEqual([
    { id: answer, ok: true, message: 'D1 → By type' },
    { id: done, ok: true, message: 'T1 done' },
  ])
  expect(Object.keys(files).filter(f => f.startsWith(`${INBOX}/`))).toEqual([])
  await stopAll($, clock, [])
})

test('images on a question or to-do reach the board; only absolute paths of pictures and videos count', async ($, on) => {
  const { clock, files } = await start($, on)
  await $.tool.call({
    tool: 'mcp__herdr-agents__ask_owner',
    question: 'Which look?',
    options: ['A', 'B'],
    images: ['/shots/a.png', 'relative.png', '/secrets/.env', 7],
  })
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Check the build', images: ['/shots/b.MP4'] })
  await $.tool.call({ tool: 'mcp__herdr-agents__pin_for_owner', text: 'Nothing to see' })
  await clock.advance(3000)
  const board = JSON.parse(files[FILE]!)
  const images = (key: string) => board.needs.find((n: { key: string }) => n.key === key).images
  expect(images('D1')).toEqual(['/shots/a.png'])
  expect(images('T1')).toEqual(['/shots/b.MP4'])
  expect(images('T2')).toEqual([])
})
