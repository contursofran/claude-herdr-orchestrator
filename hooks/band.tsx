import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import { openQuestions, pinnedItems } from './owner'

export type BandRender = RenderInput<'AbovePrompt'>
export type ToolUseRender = RenderInput<'ToolUse'>
export type ToolResultRender = RenderInput<'ToolResult'>

// One line above the prompt when the Herdr app isn't showing this session's board (the main layout, an app crash, another
// machine), so a question can't wait unseen. Its text is the first question, else the first to-do; the person answers in chat.
export async function drawBand($: EngineInterface, e: BandRender, next: (e: BandRender) => Promise<RenderElement>): Promise<RenderElement> {
  const open = await openQuestions($)
  const items = await pinnedItems($)
  const count = open.length + items.length
  if (e.props.hasSurvey || count === 0) return next(e)
  const { Text } = $.ui.resolve(e)
  const first = (open[0]?.question ?? items[0]?.text ?? '').split('\n')[0]
  return (
    <Text wrap="truncate-end">
      <Text bold color="claude">{`${count} waiting`}</Text>
      <Text dimColor>{' (reply in chat): '}</Text>
      {first}
    </Text>
  )
}

// An Edit or Write of a Markdown file draws no row: notes kept in .md files buried what the owner needs to
// read. One that failed or was cut off stays, and ctrl+o (isExpanded) shows them all.
const writesMarkdown = (tool: string, path: unknown) =>
  (tool === 'Edit' || tool === 'Write') && typeof path === 'string' && /\.(md|markdown)$/i.test(path)

export function hidesToolUse({ props: p }: ToolUseRender) {
  const path = (p.input as { file_path?: unknown } | undefined)?.file_path
  return writesMarkdown(p.tool, path) && !p.isErrored && !p.isInterrupted && !p.isExpanded
}

export function hidesToolResult({ props: p }: ToolResultRender) {
  const path = (p.output as { filePath?: unknown } | undefined)?.filePath
  return writesMarkdown(p.tool, path) && !p.isErrored && !p.isExpanded
}

// spawn and message calls drawn with their brief cut to its first line: the full
// text is in the worker's TASK.md or MESSAGE file, not the transcript.
export function shortenBrief(e: ToolUseRender): ToolUseRender {
  const field = e.props.tool === 'mcp__herdr-agents__spawn' ? 'task' : e.props.tool === 'mcp__herdr-agents__message' ? 'text' : undefined
  const input = e.props.input as Record<string, unknown> | undefined
  const text = field && input ? input[field] : undefined
  if (typeof text !== 'string' || text.length <= 160) return e
  const first = (text.split('\n').find(l => l.trim()) ?? '').replace(/^#+\s*/, '').slice(0, 100)
  const where =
    field === 'task' && typeof input?.cwd === 'string' && typeof input?.worker === 'string'
      ? ` · full brief in ${String(input.cwd).split('/').pop()}/.herdr-agents/${input.worker}/TASK.md`
      : ''
  const cwd = typeof input?.cwd === 'string' ? `…/${String(input.cwd).split('/').pop()}` : undefined
  return {
    ...e,
    props: {
      ...e.props,
      input: { ...input, ...(cwd ? { cwd } : {}), [field!]: `${first} … (${text.length.toLocaleString('en')} chars${where})` },
    },
  }
}
