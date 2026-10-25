import { expect, test } from 'claude-code/testing'
import { parseHeader, summaryOf } from '../hooks/report'
import { oneLine } from '../view/hooks/format'

// The report header a worker writes at the top of RESULT.md (report.ts), and how the coordinator reads it.

test('a fenced header gives status, PRs, summary and ask, and what follows it is the rest', () => {
  const header = parseHeader(
    [
      '```report',
      'status: blocked',
      'pr: 42',
      'summary: Opened PR #42, the checks pass.',
      '- The reviewer has not run yet.',
      'Waiting on the owner for the CI scope.',
      'ask: Base or develop?',
      '```',
      'Full text one.',
      'Full text two.',
    ].join('\n'),
  )
  expect(header).toEqual({
    status: 'blocked',
    prs: [42],
    summary: ['Opened PR #42, the checks pass.', 'The reviewer has not run yet.', 'Waiting on the owner for the CI scope.'],
    ask: 'Base or develop?',
    rest: 'Full text one.\nFull text two.',
  })
})

test('a header without fences, with bold keys and a title before it, still parses', () => {
  const header = parseHeader('# T\n**Status:** Done\n**Summary:** a\n- b\n\nrest')
  expect(header).toEqual({ status: 'done', prs: [], summary: ['a', 'b'], rest: '# T\n\nrest' })
})

test('prose that starts with Status: and has no summary is not a header', () => {
  expect(parseHeader('# Report\n\nStatus: the candidate pack is built, not released.\n\n## What I did\nBuilt it.')).toBeUndefined()
})

test('the summary keeps at most 3 lines, and a long line is cut to 240 characters', () => {
  const header = parseHeader(['status: done', `summary: ${'y'.repeat(300)}`, 'two', 'three', 'four'].join('\n'))
  expect(header?.summary).toHaveLength(3)
  expect(header?.summary[0]).toHaveLength(240)
  expect(header?.summary.slice(1)).toEqual(['two', 'three'])
  expect(header?.rest).toBe('four')
  // Repeated summary keys share the same 3 lines.
  const repeated = parseHeader(['status: done', 'summary: one', 'summary: two', 'summary: three', 'summary: four'].join('\n'))
  expect(repeated?.summary).toEqual(['one', 'two', 'three'])
})

test('pr takes several numbers or none, and prs is its alias', () => {
  expect(parseHeader('status: done\npr: #1006, https://github.com/o/r/pull/1007\nsummary: x')?.prs).toEqual([1006, 1007])
  expect(parseHeader('status: done\npr: none\nsummary: x')?.prs).toEqual([])
  expect(parseHeader('status: done\nprs: 12, 13\nsummary: x')?.prs).toEqual([12, 13])
})

test('pr reads the PR numbers of its leading list, not the digits of a date or note after it', () => {
  expect(parseHeader('status: done\npr: 42 (merged 2026-10-24)\nsummary: x')?.prs).toEqual([42])
  expect(parseHeader('status: done\npr: #1006, #1007 (merged 2026-10-24)\nsummary: x')?.prs).toEqual([1006, 1007])
  expect(parseHeader('status: done\npr: https://github.com/o/r/pull/42 (merged 2026-10-24)\nsummary: x')?.prs).toEqual([42])
  expect(parseHeader('status: done\npr: none (no PR, 2026-10-24)\nsummary: x')?.prs).toEqual([])
  expect(parseHeader('status: done\npr: 2026-10-24\nsummary: x')?.prs).toEqual([])
  // The list ends at the first word, so a number after it is not a PR.
  expect(parseHeader('status: done\npr: 42 merged 24 Oct\nsummary: x')?.prs).toEqual([42])
})

test('a header that starts past line 12 is not read, one that starts within it is', () => {
  const preface = Array.from({ length: 12 }, () => 'Intro.').join('\n')
  expect(parseHeader(`${preface}\nstatus: done\nsummary: x`)).toBeUndefined()
  expect(parseHeader(`${preface.split('\n').slice(1).join('\n')}\nstatus: done\nsummary: x`)?.summary).toEqual(['x'])
})

test('a status is read by its first word, and an unknown one is no status while the header stays valid', () => {
  expect(parseHeader('status: Completed.\nsummary: x')?.status).toBe('done')
  expect(parseHeader('status: error in CI\nsummary: x')?.status).toBe('failed')
  const progress = parseHeader('status: in progress\nsummary: x')
  expect(progress?.status).toBeUndefined()
  expect(progress?.summary).toEqual(['x'])
})

test('a fence with no closing fence ends the header at its last key; the lines after it are kept', () => {
  const header = parseHeader(['```report', 'status: done', 'summary: Did it.', 'ask: Base or develop?', '', 'Body line one.'].join('\n'))
  expect(header?.summary).toEqual(['Did it.'])
  expect(header?.ask).toBe('Base or develop?')
  expect(header?.rest).toBe('Body line one.')
})

test('an unknown key inside a fence is ignored and ends the summary', () => {
  const header = parseHeader(
    ['```report', 'status: done', 'summary: Opened PR #42.', 'Checks: all green.', 'ask: Merge now?', '```'].join('\n'),
  )
  expect(header).toEqual({ status: 'done', prs: [], summary: ['Opened PR #42.'], ask: 'Merge now?', rest: '' })
})

test('the inline form is the summary, the ask, the pinned questions and the pointer, in that order', () => {
  const header = parseHeader('status: blocked\nsummary: Opened it.\nask: Base or develop?\n\nLong text.')!
  expect(summaryOf(header, '/w/RESULT-t1.md', 9, ['D1 [Port] Which port? | 5173 (recommended) | 8080'])).toBe(
    'Opened it.\nAsk: Base or develop?\nD1 [Port] Which port? | 5173 (recommended) | 8080\n[Full report, 9 lines: /w/RESULT-t1.md. Read it only when this summary is not enough.]',
  )
  // Nothing after the header: no pointer.
  const alone = parseHeader('status: done\nsummary: Done.')!
  expect(summaryOf(alone, '/w/RESULT-t1.md', 2)).toBe('Done.')
})

test('the view draws a header report with its result and PRs, and a report without one as before', () => {
  const headed =
    '<herdr-agent name="w-busy" profile="builder" status="done" result="blocked" pr="42,43">\nOpened PR #42.\nAsk: Base or develop?\n[Full report, 12 lines: /x/RESULT-t.md. Read it only when this summary is not enough.]\n</herdr-agent>'
  expect(oneLine(headed)).toBe('⇠ w-busy blocked: Opened PR #42. · full report in file · PR #42, #43')
  const plain = '<herdr-agent name="w-x" profile="builder" status="done">\nDone.\n</herdr-agent>'
  expect(oneLine(plain)).toBe('⇠ w-x done: Done.')
})
