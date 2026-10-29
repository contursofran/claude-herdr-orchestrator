import { HEADER_SCAN_LINES, SUMMARY_LINE_CHARS, SUMMARY_LINES } from './defaults'

// The header a worker puts at the top of RESULT.md (see reportRule in workers.ts): its status,
// the PRs it opened or updated, a short summary and an optional question for the coordinator.
// Pure: no engine calls. A report without a header is delivered as it always was.

export type Header = {
  status?: 'done' | 'blocked' | 'failed'
  prs: number[]
  summary: string[]
  ask?: string
  verdict?: 'approve' | 'changes'
  head?: string
  rest: string
}

// `status: done`, `**Status:** done`, `- status: done`. `prs` is an alias of `pr`.
const KEY = /^\s*(?:[-*]\s+)?\**(status|prs?|summary|ask|verdict|head)\**\s*:\s*\**\s*(.*?)\s*$/i
// Any other `word:` line: ignored inside a fence, and it ends an unfenced header.
const OTHER_KEY = /^\s*(?:[-*]\s+)?\**[A-Za-z][\w-]*\**\s*:(?:\s|$)/
const FENCE = /^\s*```/
// The walk reads at most this many lines from the header's first key on.
const WALK_LINES = 15
// The words a status may start with, mapped to the status they mean.
const STATUS_WORDS = new Map<string, 'done' | 'blocked' | 'failed'>([
  ['done', 'done'],
  ['complete', 'done'],
  ['completed', 'done'],
  ['finished', 'done'],
  ['ok', 'done'],
  ['success', 'done'],
  ['blocked', 'blocked'],
  ['waiting', 'blocked'],
  ['stuck', 'blocked'],
  ['failed', 'failed'],
  ['fail', 'failed'],
  ['failure', 'failed'],
  ['error', 'failed'],
])

// The words a verdict may start with, mapped to the verdict they mean.
const VERDICT_WORDS = new Map<string, 'approve' | 'changes'>([
  ['approve', 'approve'],
  ['approved', 'approve'],
  ['lgtm', 'approve'],
  ['changes', 'changes'],
  ['changes-needed', 'changes'],
  ['request-changes', 'changes'],
  ['blocked', 'changes'],
])
const HEAD = /^[0-9a-f]{7,40}$/i

// One item of a `pr:` list: `42`, `#42` or a pull request link.
const PR_ITEM = /^(?:#?(\d+)|https?:\/\/\S*?\/pull\/(\d+)\b\S*)$/
// The PR numbers a `pr:` value names, read from its leading list (items separated by `,` or spaces).
// The list ends at the first item that is not a PR, so `42 (merged 2026-10-24)` names 42 only.
function prNumbers(value: string): number[] {
  const found: number[] = []
  for (const item of value.split(/[\s,]+/)) {
    if (!item) continue
    const m = PR_ITEM.exec(item)
    if (!m) break
    found.push(Number(m[1] ?? m[2]))
  }
  return [...new Set(found)].slice(0, 5)
}

// The header of a report body (RESULT.md without its token line), or undefined when it has none:
// no summary line with some text in it. Its first key must start within HEADER_SCAN_LINES.
export function parseHeader(body: string): Header | undefined {
  const lines = body.split('\n')
  let s = -1
  for (let i = 0; i < Math.min(lines.length, HEADER_SCAN_LINES); i++) {
    const key = KEY.exec(lines[i]!)?.[1]?.toLowerCase()
    if (key === 'status' || key === 'summary') {
      s = i
      break
    }
  }
  if (s < 0) return undefined

  // A fence up to three lines above the first key opens a fenced header.
  let start = s
  let fenced = false
  for (let i = s - 1; i >= Math.max(0, s - 3); i--) {
    if (FENCE.test(lines[i]!)) {
      start = i
      fenced = true
      break
    }
  }

  let status: Header['status']
  let prs: number[] = []
  let ask: string | undefined
  let verdict: Header['verdict']
  let head: string | undefined
  const summary: string[] = []
  const addSummary = (text: string) => {
    const line = text.replace(/^\s*[-*]\s+/, '').trim()
    if (line && summary.length < SUMMARY_LINES) summary.push(line)
  }
  let inSummary = false
  // The last line that belongs to the header.
  let end = s
  for (let j = s; j < Math.min(lines.length, s + WALK_LINES); j++) {
    const line = lines[j]!
    if (FENCE.test(line)) {
      // The closing fence of a fenced header; a fence in an unfenced one is not part of it.
      if (fenced) end = j
      break
    }
    if (!line.trim()) {
      if (fenced) continue
      break
    }
    const m = KEY.exec(line)
    if (m) {
      const name = m[1]!.toLowerCase()
      const value = m[2] ?? ''
      end = j
      inSummary = name === 'summary'
      if (name === 'status') status = STATUS_WORDS.get(value.toLowerCase().match(/[a-z]+/)?.[0] ?? '')
      else if (name === 'summary') addSummary(value)
      else if (name === 'ask') ask = value || undefined
      else if (name === 'verdict') verdict = VERDICT_WORDS.get(value.toLowerCase().match(/[a-z-]+/)?.[0] ?? '')
      else if (name === 'head') head = HEAD.test(value.replace(/^`|`$/g, '')) ? value.replace(/^`|`$/g, '') : undefined
      else prs = prNumbers(value)
      continue
    }
    if (OTHER_KEY.test(line)) {
      if (!fenced) break
      inSummary = false
      end = j
      continue
    }
    if (inSummary && summary.length < SUMMARY_LINES) {
      addSummary(line)
      end = j
      continue
    }
    if (fenced) continue
    break
  }

  const kept = summary.map(l => l.slice(0, SUMMARY_LINE_CHARS))
  if (kept.length === 0) return undefined
  const rest = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n').trim()
  return { status, prs, summary: kept, ask, verdict, head, rest }
}

// The inline form of a report with a header: its summary, the question for the coordinator,
// the pinned questions (`pinned`, one line each, from workers.ts) and a pointer to the file
// when anything else is in it. `lines` is the report's non-empty line count.
export function summaryOf(header: Header, full: string, lines: number, pinned: string[] = []): string {
  return [
    ...header.summary,
    ...(header.ask ? [`Ask: ${header.ask}`] : []),
    ...pinned,
    ...(header.rest ? [`[Full report, ${lines} lines: ${full}. Read it only when this summary is not enough.]`] : []),
  ].join('\n')
}
