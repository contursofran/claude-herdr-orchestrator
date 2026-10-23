import { expect, test } from 'claude-code/testing'
import { spawn, start, stopAll } from './harness'

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
  await clock.advance(3000)

  // The coordinator gets the same prompts as from the sidebar.
  expect(submitted.some(t => t.startsWith('<herdr-decision id="D1"') && t.includes('The owner chose: By type'))).toBe(true)
  expect(submitted.some(t => t.startsWith('<herdr-owner-done id="T1"'))).toBe(true)
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
