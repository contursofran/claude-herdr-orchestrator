import { expect } from 'claude-code/testing'
import { sharedFiles } from '../hooks/overlap'
import type { Pr } from '../types'
import { settled, start, stopAll, test, until } from './harness'

// Conflict state and files shared between open PRs (#279), from `gh pr view` to the board.

const BOARD = '/home/t/.herdr-agents/board/session-1234.json'
const HEARTBEAT = '/home/t/.herdr-agents/app-mod.json'
const R = 'acme/app-client'
const open = (files: string[], extra: Partial<Pr> = {}): Pr => ({ state: 'OPEN', ci: 'pass', at: 1, files, ...extra })
const task = (pr: number, repo = R) => ({ key: `${repo}#${pr}`, repo, pr })

test('open PRs of one repo that change a file name each other, with how many files they share', () => {
  const shares = sharedFiles([task(1), task(2), task(3)], {
    [`${R}#1`]: open(['b/z.ts', 'a/pin.ts', 'c.ts']),
    [`${R}#2`]: open(['a/pin.ts', 'b/z.ts']),
    [`${R}#3`]: open(['other.ts']),
  })
  expect(shares.get(`${R}#1`)).toEqual([{ pr: 2, file: 'a/pin.ts', count: 2 }])
  expect(shares.get(`${R}#2`)).toEqual([{ pr: 1, file: 'a/pin.ts', count: 2 }])
  expect(shares.has(`${R}#3`)).toBe(false)
})

test('a merged PR, another repo and a lockfile say nothing, and an old read with no files is safe', () => {
  const shares = sharedFiles([task(1), task(2), task(3), task(4, 'acme/other'), task(5)], {
    [`${R}#1`]: open(['x.ts', 'package-lock.json', 'sub/Cargo.lock']),
    [`${R}#2`]: { state: 'MERGED', ci: 'pass', at: 1, files: ['x.ts'] },
    [`${R}#3`]: open(['package-lock.json', 'sub/Cargo.lock']),
    'acme/other#4': open(['x.ts']),
    [`${R}#5`]: { state: 'OPEN', ci: 'pass', at: 1 },
  })
  expect(shares.size).toBe(0)
})

async function twoPrs($: Parameters<typeof start>[0], on: Parameters<typeof start>[1]) {
  const s = await start($, on)
  for (const pr of [15, 16]) {
    await $.tool.call({
      tool: 'mcp__herdr-agents__spawn',
      worker: `r-${pr}`,
      profile: 'reviewer',
      cwd: '/repo',
      task: `Review ${R} PR #${pr}`,
    })
    await settled()
  }
  const poll = async () => {
    for (let i = 0; i < 5; i++) {
      s.files[HEARTBEAT] = JSON.stringify({ at: s.clock.now(), terminals: ['t1'] })
      await s.clock.advance(30_000)
    }
  }
  const row = (pr: number) => JSON.parse(s.files[BOARD] ?? '{}').tasks?.find((t: { pr: number }) => t.pr === pr)
  return { ...s, poll, row }
}

const gh = (files: string[], mergeable: string, baseRefName = 'main') => ({
  state: 'OPEN',
  statusCheckRollup: [],
  mergeable,
  baseRefName,
  files: files.map(path => ({ path, additions: 1, deletions: 1 })),
})

test('the board says what conflicts and what is shared, and goes back when it clears', async ($, on) => {
  const { clock, prs, poll, row } = await twoPrs($, on)
  prs[`${R}#15`] = gh(['app/pin-panel.ts', 'a.ts'], 'CONFLICTING', 'develop')
  prs[`${R}#16`] = gh(['app/pin-panel.ts'], 'MERGEABLE')
  await poll()
  await until(clock, () => row(15)?.conflictsWith === 'develop')
  expect(row(15)).toMatchObject({ conflictsWith: 'develop', shares: [{ pr: 16, file: 'app/pin-panel.ts', count: 1 }] })
  expect(row(16)).toMatchObject({ conflictsWith: null, shares: [{ pr: 15, file: 'app/pin-panel.ts', count: 1 }] })

  // GitHub still working it out leaves the last answer, until it has one.
  prs[`${R}#15`] = gh(['a.ts'], 'UNKNOWN')
  await poll()
  await until(clock, () => row(15)?.shares?.length === 0)
  expect(row(15).conflictsWith).toBe('main')

  prs[`${R}#15`] = gh(['a.ts'], 'MERGEABLE')
  await poll()
  await until(clock, () => row(15)?.conflictsWith === null)
  expect(row(15).conflictsWith).toBeNull()

  // Merged, it conflicts with nothing and shares nothing.
  prs[`${R}#15`] = { state: 'MERGED', mergedAt: '2026-10-30T20:00:00Z', statusCheckRollup: [] }
  prs[`${R}#16`] = gh(['a.ts'], 'CONFLICTING')
  await poll()
  await until(clock, () => row(16)?.conflictsWith === 'main')
  expect(row(15)).toMatchObject({ conflictsWith: null, shares: [] })
  expect(row(16)).toMatchObject({ conflictsWith: 'main', shares: [] })
  await stopAll($, clock, ['r-15', 'r-16'])
})

test('past the limit of a poll, the PRs left out are read first at the next one', async ($, on) => {
  const s = await start($, on)
  const numbers = Array.from({ length: 10 }, (_, i) => 20 + i)
  for (const pr of numbers) {
    s.prs[`${R}#${pr}`] = gh(['a.ts'], 'MERGEABLE')
    await $.tool.call({
      tool: 'mcp__herdr-agents__spawn',
      worker: `r-${pr}`,
      profile: 'reviewer',
      cwd: '/repo',
      task: `Review ${R} PR #${pr}`,
    })
    await settled()
  }
  const read = () => new Set(s.shell.filter(c => c.startsWith('gh pr view ')).map(c => c.split(' ')[3]))
  for (let i = 0; i < 9; i++) {
    s.files[HEARTBEAT] = JSON.stringify({ at: s.clock.now(), terminals: ['t1'] })
    await s.clock.advance(30_000)
  }
  await until(s.clock, () => read().size === numbers.length)
  expect(read().size).toBe(numbers.length)
  await stopAll(
    $,
    s.clock,
    numbers.map(pr => `r-${pr}`),
  )
})
