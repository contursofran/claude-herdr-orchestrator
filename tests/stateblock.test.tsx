import { expect, test } from 'claude-code/testing'
import type { Job } from '../types'
import { AUTO_END, AUTO_START, RECENT_REPORTS } from '../hooks/defaults'
import { mergeBlock, renderBlock } from '../hooks/stateblock'
import { spawn, start, stopAll } from './harness'

// The state file's Workers block (stateblock.ts): the mod writes it from the coordinator's tick.

const STATE = '/repo/COORDINATOR-STATE.md'
const turnEnd = (turnId: string) => ({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' as const })
const job = (over: Partial<Job>): Job => ({
  name: 'w',
  profile: 'builder',
  cwd: '/r',
  dir: '/r/.herdr-agents/w',
  startedAt: 0,
  status: 'running',
  ...over,
})
const at = (iso: string) => Date.parse(`${iso}:00Z`)

// How many times the state file is written: its entry in the fake file system counts each set.
function countWrites(files: Record<string, string>) {
  const count = { writes: 0 }
  let text = files[STATE]
  Object.defineProperty(files, STATE, {
    enumerable: true,
    configurable: true,
    get: () => text,
    set: (v: string) => {
      count.writes++
      text = v
    },
  })
  return count
}

test("the block is written once per change and the coordinator's sections stay byte for byte", async ($, on) => {
  const { clock, files } = await start($, on)
  files[STATE] = '# S\n## Ready\n- a\n'
  await spawn($, ['w-a'])
  await clock.advance(3000)
  expect(files[STATE]).toMatch(/^# S\n## Ready\n- a\n/)
  expect(files[STATE]).toContain(AUTO_START)
  expect(files[STATE]).toContain('- w-a (reviewer) in /repo-w-a')
  const written = files[STATE]
  // Nothing changed: the same text is not written again.
  const count = countWrites(files)
  await clock.advance(9000)
  expect(count.writes).toBe(0)
  expect(files[STATE]).toBe(written)
  await stopAll($, clock, ['w-a'])
})

test('a second write replaces the block in place', async ($, on) => {
  const { clock, files, emit, typed } = await start($, on)
  files[STATE] = '# S\n## Ready\n- a\n'
  await spawn($, ['w-a'])
  await emit('w-a', 'working')
  await clock.advance(3000)
  expect(files[STATE]).toMatch(/### Running\n- w-a .* · running since .*\n### Waiting\n- none\n### Recent reports\n- none\n/)
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(12_000)
  // The report is delivered while the worker still works: it stays under Running until its turn ends.
  expect(files[STATE]).toMatch(/### Running\n- w-a .* · finishing its turn since .*\n### Waiting\n- none\n### Recent reports\n- .* w-a /)
  await emit('w-a', 'done')
  await clock.advance(3000)
  const text = files[STATE]!
  expect(text.startsWith('# S\n## Ready\n- a\n')).toBe(true)
  expect(text.split(AUTO_START)).toHaveLength(2)
  expect(text).toMatch(
    /### Running\n- none\n### Waiting\n- none\n### Recent reports\n- \d{4}-\d\d-\d\d \d\d:\d\d w-a \(reviewer\) done: \/repo-w-a\/\.herdr-agents\/w-a\/RESULT-\w+\.md\n/,
  )
  await stopAll($, clock, ['w-a'])
})

test('no write during a main turn', async ($, on) => {
  const { clock, files } = await start($, on)
  files[STATE] = '# S\n'
  await spawn($, ['w-a'])
  await $.turn.start({ text: 'Go.', turnId: 't1' })
  await clock.advance(9000)
  expect(files[STATE]).toBe('# S\n')
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(3000)
  expect(files[STATE]).toContain(AUTO_START)
  await stopAll($, clock, ['w-a'])
})

test('no write while a context reset waits for the save', async ($, on) => {
  on('session.measure', () => ({ changed: ['context'] }))
  const { clock, files, submitted } = await start($, on, { resetAt: 1000 })
  files[STATE] = '# S\n'
  await spawn($, ['w-a'])
  const measure = (tokens: number) => $.session.measure({ context: { tokens, window: 200_000 }, rateLimits: [], changed: ['context'] })
  // Past the limit the mod asks the model to save; the model's own write to the file would count
  // as the save, so the mod writes no block until the reset is over.
  await measure(5000)
  await clock.advance(1000)
  expect(submitted.join('\n')).toContain('<herdr-context tokens=')
  await clock.advance(9000)
  expect(files[STATE]).toBe('# S\n')
  // The context is back under the limit: the reset is over and the block is written again.
  await measure(100)
  await clock.advance(3000)
  expect(files[STATE]).toContain(AUTO_START)
  await stopAll($, clock, ['w-a'])
})

test('a worker session writes no block', async ($, on) => {
  const { clock, files } = await start($, on, {}, {}, { HERDR_AGENTS_ROLE: 'worker' })
  files[STATE] = '# S\n'
  await spawn($, ['w-a'])
  await clock.advance(9000)
  expect(files[STATE]).toBe('# S\n')
  await stopAll($, clock, ['w-a'])
})

test('a missing state file is created with only the block, and removed markers come back', async ($, on) => {
  const { clock, files } = await start($, on)
  await spawn($, ['w-a'])
  await clock.advance(3000)
  expect(files[STATE]?.startsWith(`${AUTO_START}\n`)).toBe(true)
  expect(files[STATE]?.endsWith(`${AUTO_END}\n`)).toBe(true)
  files[STATE] = '# S\n## Next\n- x\n'
  await clock.advance(3000)
  expect(files[STATE]).toMatch(/^# S\n## Next\n- x\n<!-- hrd:auto -->\n/)
  await stopAll($, clock, ['w-a'])
})

test('spawn records the branch, and a failed git leaves it out', async ($, on) => {
  const { clock, files, runs } = await start($, on)
  runs.set('git -C /repo-w-a branch --show-current', [{ exitCode: 0, stdout: 'issue-9\n' }])
  await spawn($, ['w-a', 'w-b'])
  await clock.advance(3000)
  expect(files[STATE]).toMatch(/- w-a \(reviewer\) in \/repo-w-a on issue-9 · running/)
  expect(files[STATE]).toMatch(/- w-b \(reviewer\) in \/repo-w-b · running/)
  await stopAll($, clock, ['w-a', 'w-b'])
})

test('renderBlock: an empty list gives three none sections', () => {
  expect(renderBlock([])).toBe(
    `${AUTO_START}\n## Workers (written by herdr-agents on every change; do not edit this block)\n### Running\n- none\n### Waiting\n- none\n### Recent reports\n- none\n${AUTO_END}`,
  )
})

test('renderBlock orders running by start and reports by end, newest first, and shows what a worker waits for', () => {
  const t = (iso: string) => at(iso)
  const text = renderBlock([
    job({ name: 'late', startedAt: t('2026-10-02 10:00'), refs: [7, 9], prs: [9], branch: 'b' }),
    job({
      name: 'early',
      startedAt: t('2026-10-01 09:05'),
      wait: { for: 'CI on #9', check: 'x', every: 1, max: 5, since: t('2026-10-01 09:30') },
    }),
    job({ name: 'old', status: 'reported', endedAt: t('2026-10-01 12:00'), reportFile: '/f/old.md', reportStatus: 'done' }),
    job({ name: 'new', status: 'reported', endedAt: t('2026-10-03 08:00'), reportStatus: 'blocked' }),
  ])
  expect(text).toContain(
    '### Running\n- early (builder) in /r · waiting since 2026-10-01 09:05\n- late (builder) in /r on b · #7 · PR #9 · running since 2026-10-02 10:00\n',
  )
  expect(text).toContain('### Waiting\n- early: CI on #9 (WAIT.json since 2026-10-01 09:30)\n')
  expect(text).toContain(
    '### Recent reports\n- 2026-10-03 08:00 new (builder) blocked: no report file\n- 2026-10-01 12:00 old (builder) done: /f/old.md\n',
  )
})

test('renderBlock lists a reported job that is still watched as running, by what it waits at', () => {
  const text = renderBlock([
    job({ name: 'a', status: 'reported', tail: 'early', endedAt: 5, startedAt: 1 }),
    job({ name: 'b', status: 'reported', tail: 'blocked', endedAt: 6, startedAt: 2 }),
  ])
  expect(text).toContain(
    '### Running\n- a (builder) in /r · finishing its turn since 1970-01-01 00:00\n- b (builder) in /r · blocked after its report since 1970-01-01 00:00\n### Waiting\n- none\n',
  )
  expect(text).toContain('### Recent reports\n- 1970-01-01 00:00 b (builder) reported:')
})

test('renderBlock lists only the newest RECENT_REPORTS reports', () => {
  const many = Array.from({ length: RECENT_REPORTS + 3 }, (_, i) => job({ name: `w${i}`, status: 'reported', endedAt: i * 60_000 }))
  const lines = renderBlock(many)
    .split('### Recent reports\n')[1]!
    .split('\n')
    .filter(l => l.startsWith('- '))
  expect(lines).toHaveLength(RECENT_REPORTS)
  expect(lines[0]).toContain(` w${RECENT_REPORTS + 2} `)
})

test('mergeBlock replaces the block and keeps the rest byte for byte; without markers it appends', () => {
  const block = `${AUTO_START}\nnew\n${AUTO_END}`
  expect(mergeBlock(`a\n\n${AUTO_START}\nold\n${AUTO_END}\n\nb  \n`, block)).toBe(`a\n\n${block}\n\nb  \n`)
  expect(mergeBlock('a\n\n\n', block)).toBe(`a\n${block}\n`)
  expect(mergeBlock('', block)).toBe(`${block}\n`)
  // A stray start marker with no end of its own is left alone.
  expect(mergeBlock(`${AUTO_START}\nkeep\n`, block)).toBe(`${AUTO_START}\nkeep\n${block}\n`)
})
