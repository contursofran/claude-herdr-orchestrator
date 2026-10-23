import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import type { Row, View } from '../types'
import { readBoard } from './board'
import { toggleWrapUp } from './coordinator'
import { SETTLED_MS, TODO_ROWS, WORKER_CELL, WORKER_LINES } from './defaults'
import { ago, elapsed } from './format'
import { linker } from './links'
import { answered, choose, decisionTitle, openQuestions, pinnedItems, tick } from './owner'
import { cmd } from './session'

// Which decision the band shows, and whether Details lists every worker.
const view = atom({ plugin: 'herdr-agents', key: 'view' } as const, { tab: 'workers', selected: null } as View)

export type BandRender = RenderInput<'AbovePrompt'>
export type ToolUseRender = RenderInput<'ToolUse'>

// The band above the prompt. Wide: decisions listed on the left, the selected one on
// the right with its answers, workers below. Under 120 columns the list folds into a
// strip of titles above the question. Digits answer from an empty prompt; ctrl+x tab
// lands on the recommended answer, so Enter picks it.
export async function drawBand($: EngineInterface, e: BandRender, next: (e: BandRender) => Promise<RenderElement>): Promise<RenderElement> {
  const { now, rows, context, target: want, wrapUp } = await readBoard($)
  const open = await openQuestions($)
  const { selected, workers: workerView } = await read($, view)
  const items = await pinnedItems($)
  const clock = await $.clock.now()
  const recent = (await answered($)).filter(x => clock - x.at < SETTLED_MS)
  if (e.props.hasSurvey || (rows.length === 0 && open.length === 0 && recent.length === 0 && items.length === 0)) return next(e)

  const { Box, Button, Link, Text } = $.ui.resolve(e)
  const { linkify, repoOf } = await linker($, rows, (href, text, key) => (
    <Link key={key} href={href}>
      {text}
    </Link>
  ))
  // bodyColumns is the band's box; the border and padding take 4 of it.
  const cols = Math.max(20, (e.props.bodyColumns ?? 100) - 4)
  const isWide = cols >= 116
  const rule = <Text color="subtle">{'─'.repeat(cols)}</Text>
  const short = (from: string) => from.replace(/\s*\(.*$/, '').slice(0, 22)
  const pick = (id: number) => update($, view, v => ({ ...v, selected: id }))

  const waiting = new Map<string, string[]>()
  for (const d of open) waiting.set(d.from, [...(waiting.get(d.from) ?? []), `D${d.id}`])
  const rank = (r: Row) =>
    waiting.has(r.name) ? 0 : r.state === 'blocked' || r.state === 'gone' ? 1 : r.state === 'working' ? 2 : r.state === 'done' ? 3 : 4
  const sorted = [...rows].sort((x, y) => rank(x) - rank(y))
  const look: Record<string, { label: string; color?: string; dim?: boolean }> = {
    working: { label: 'Working', color: 'success' },
    waiting: { label: 'Waiting', dim: true },
    blocked: { label: 'Blocked · answer it in its tab', color: 'error' },
    idle: { label: 'Idle', dim: true },
    done: { label: 'Done · report pending', color: 'success' },
    reported: { label: 'Reported', dim: true },
    gone: { label: 'Tab gone', color: 'error' },
  }
  const width = Math.max(0, ...rows.map(r => r.name.length)) + 3
  const running = rows.filter(r => r.state !== 'reported' && r.state !== 'waiting').length
  // While wrapping up, every worker not yet reported counts, waiting ones too.
  const left = rows.filter(r => r.state !== 'reported').length

  // Compact (the default) shows the first WORKER_LINES lines of workers; Details shows them all.
  const isList = workerView === 'list'
  const toggleList = () => update($, view, ({ workers, ...v }) => (isList ? v : { ...v, workers: 'list' as const }))

  // Two per line when the band is wide enough. Sorted, so the ones that need the person come first.
  const perLine = cols >= 2 * WORKER_CELL + 3 ? 2 : 1
  const cellWidth = perLine === 2 ? Math.floor((cols - 3) / 2) : cols
  const onPage = isList ? sorted : sorted.slice(0, perLine * WORKER_LINES)
  const hidden = sorted.length - onPage.length
  const lines = Math.ceil(onPage.length / perLine)
  const columns = perLine === 2 ? [onPage.slice(0, lines), onPage.slice(lines)] : [onPage]
  // The header's mix of roles among the workers it counts, e.g. "3 builders · 1 reviewer".
  const roles = new Map<string, number>()
  for (const r of rows) if (r.state !== 'reported' && r.state !== 'waiting') roles.set(r.profile, (roles.get(r.profile) ?? 0) + 1)
  const mix = [...roles]
    .sort((x, y) => y[1] - x[1])
    .map(([p, n]) => `${n} ${n > 1 && /er$/.test(p) ? `${p}s` : p}`)
    .join(' · ')
  const parked = rows.filter(r => r.state === 'waiting').length
  const pwidth = Math.max(0, ...rows.map(r => r.profile.length)) + 2
  const cell = (r: Row) => {
    const ids = waiting.get(r.name)
    const l = ids
      ? { label: `Waiting for ${ids.join(', ')}`, color: 'claude', dim: false }
      : r.state === 'waiting'
        ? { label: `⏸ ${r.note ?? 'Waiting'}`, dim: true }
        : (look[r.state] ?? { label: r.state, dim: true })
    return (
      <Text key={r.name} wrap="truncate-end">
        <Text color={l.color} dimColor={l.dim}>
          {'● '}
        </Text>
        <Text dimColor={l.dim}>{r.name.padEnd(width)}</Text>
        <Text dimColor>{`${r.profile.padEnd(pwidth)}${elapsed((r.endedAt ?? now) - r.startedAt).padEnd(8)}`}</Text>
        <Text color={ids ? 'claude' : undefined} dimColor={l.dim || !ids}>
          {linkify(l.label, r.repo)}
        </Text>
      </Text>
    )
  }

  // The person's to-dos and news (pin_for_owner), at the top.
  const forYou = items.length ? (
    <Box flexDirection="column">
      {items.slice(0, TODO_ROWS).map(t => (
        <Box key={`t${t.id}`} justifyContent="space-between" columnGap={2}>
          <Text>
            <Text color={t.kind === 'do' ? 'claude' : undefined} dimColor={t.kind === 'know'}>
              {t.kind === 'do' ? '☐ ' : 'ℹ '}
            </Text>
            <Text bold={t.kind === 'do'}>{linkify(t.text, repoOf(t.from))}</Text>
            <Text dimColor>
              {`   T${t.id} · `}
              {linkify(short(t.from))}
              {` · ${ago(clock - t.at)}`}
            </Text>
          </Text>
          <Button key={`tick-t${t.id}`} plain dimColor onPress={() => tick($, t)}>
            {t.kind === 'do' ? 'Done' : 'Dismiss'}
          </Button>
        </Box>
      ))}
      {items.length > TODO_ROWS ? <Text dimColor>{`  +${items.length - TODO_ROWS} more · ${cmd('decisions')} lists them all`}</Text> : null}
    </Box>
  ) : null

  const index = Math.max(
    0,
    open.findIndex(d => d.id === selected),
  )
  const shown = open[index]
  // The recommended answer is always 1.
  const options = shown
    ? (shown.options ?? [])
        .map((label, i) => ({ label, isRec: i === shown.recommended }))
        .sort((x, y) => Number(y.isRec) - Number(x.isRec))
        .slice(0, 4)
    : []
  const ctxColor = context
    ? context.tokens >= context.limit * 0.95
      ? 'error'
      : context.tokens >= context.limit * 0.8
        ? 'warning'
        : undefined
    : undefined

  const detail = shown ? (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color="claude">{`D${shown.id}  `}</Text>
          <Text dimColor>{linkify(shown.from)}</Text>
        </Text>
        <Text dimColor>{`${ago(now - shown.at)}${ago(now - shown.at) === 'now' ? '' : ' ago'}`}</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>{linkify(shown.question, repoOf(shown.from))}</Text>
      </Box>
      <Box flexWrap="wrap" columnGap={4} marginTop={1}>
        {options.map((o, i) => (
          <Button
            key={`d${shown.id}-o${i}`}
            plain
            hotkey={String(i + 1)}
            variant={o.isRec ? 'primary' : undefined}
            autoFocus={i === 0 ? true : undefined}
            onPress={() => choose($, shown, o.label)}
          >
            {o.isRec ? <Text bold color="claude">{`★ ${o.label}  (recommended)`}</Text> : o.label}
          </Button>
        ))}
      </Box>
      <Box columnGap={4} marginTop={options.length ? 1 : 0}>
        <Button
          key={`d${shown.id}-other`}
          plain
          hotkey="o"
          dimColor
          autoFocus={options.length === 0 ? true : undefined}
          onPress={() => $.prompt.fill({ text: `D${shown.id}: `, mode: 'append' })}
        >
          {options.length ? 'Other answer' : 'Answer in chat'}
        </Button>
        {open.length > 1 ? (
          <Button key="prev" plain hotkey="p" dimColor onPress={() => pick(open[(index - 1 + open.length) % open.length]!.id)}>
            Previous
          </Button>
        ) : null}
        {open.length > 1 ? (
          <Button key="next" plain hotkey="n" dimColor onPress={() => pick(open[(index + 1) % open.length]!.id)}>
            Next
          </Button>
        ) : null}
      </Box>
    </Box>
  ) : null

  // Wide: one two-line entry per decision, the selected one marked.
  const list = (
    <Box flexDirection="column" width={34} flexShrink={0}>
      <Text dimColor>Decisions</Text>
      {open.slice(0, 6).map(d => {
        const isOn = d === shown
        return (
          <Button key={`pick-d${d.id}`} plain onPress={() => pick(d.id)}>
            <Text bold={isOn} color={isOn ? 'claude' : undefined} dimColor={!isOn}>{`${isOn ? '▸' : ' '} D${d.id}  `}</Text>
            <Text bold={isOn}>{decisionTitle(d).slice(0, 24)}</Text>
            {'\n'}
            <Text dimColor>{`      ${short(d.from)} · ${ago(now - d.at)}`}</Text>
          </Button>
        )
      })}
      {open.length > 6 ? <Text dimColor>{`  +${open.length - 6} more · n for next`}</Text> : null}
    </Box>
  )

  // Narrow: the titles as a strip.
  const strip = (
    <Box flexWrap="wrap" columnGap={3} marginBottom={1}>
      {open.map(d => (
        <Button key={`pick-d${d.id}`} plain dimColor={d !== shown} onPress={() => pick(d.id)}>
          <Text bold={d === shown} inverse={d === shown} color={d === shown ? 'claude' : undefined}>
            {` D${d.id} ${decisionTitle(d).slice(0, 18)} `}
          </Text>
        </Button>
      ))}
    </Box>
  )

  // The right column's height: header, gap, the wrapped question, gap, answers, gap, actions.
  const detailWidth = Math.max(20, cols - 34 - 5)
  const detailLines = shown ? 3 + Math.ceil(shown.question.length / detailWidth) + (options.length ? 2 : 0) + 1 : 0
  const divider = shown ? (
    <Box flexDirection="column" flexShrink={0} marginX={2}>
      <Text color="subtle">{Array.from({ length: Math.max(Math.min(open.length, 6) * 2 + 1, detailLines) }, () => '│').join('\n')}</Text>
    </Box>
  ) : null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
      {forYou}
      {recent.map(x => (
        <Text key={`s${x.id}`} wrap="truncate-end">
          <Text color="success">{'✓ '}</Text>
          <Text bold>{`D${x.id} ${x.title ?? x.question.slice(0, 40)}`}</Text>
          <Text dimColor>{`  settled by ${x.by} ${ago(clock - x.at)}: `}</Text>
          {linkify(x.answer, repoOf(x.from))}
        </Text>
      ))}
      {items.length > 0 || recent.length > 0 ? rule : null}
      {shown && isWide ? (
        <Box>
          {list}
          {divider}
          {detail}
        </Box>
      ) : null}
      {shown && !isWide ? (
        <Box flexDirection="column">
          {open.length > 1 ? strip : null}
          {detail}
        </Box>
      ) : null}
      {shown ? rule : null}
      <Box justifyContent="space-between" columnGap={3}>
        <Text>
          {open.length > 0 ? (
            <Text>
              <Text color="claude">● </Text>
              <Text bold>{`${open.length} decision${open.length === 1 ? '' : 's'} waiting`}</Text>
            </Text>
          ) : null}
          {open.length > 0 ? <Text color="subtle">{'   │   '}</Text> : null}
          {wrapUp ? (
            <Text color="warning" bold>{`⏸ Wrapping up · ${left} left`}</Text>
          ) : (
            <Text dimColor={open.length > 0}>{want ? `${running}/${want} workers` : `${running} worker${running === 1 ? '' : 's'}`}</Text>
          )}
          {mix ? <Text dimColor>{`: ${mix}`}</Text> : null}
          {parked ? <Text dimColor>{`   ⏸ ${parked} waiting`}</Text> : null}
        </Text>
        <Box columnGap={3} flexShrink={0}>
          {rows.length > 0 ? (
            <Button key="workers" plain dimColor onPress={toggleList}>
              {isList ? 'Compact' : hidden > 0 ? `Details +${hidden}` : 'Details'}
            </Button>
          ) : null}
          <Button key="wrap-up" plain dimColor={!wrapUp} onPress={() => toggleWrapUp($, !wrapUp)}>
            {wrapUp ? 'Keep going' : 'Wrap up'}
          </Button>
          {context ? (
            <Text color={ctxColor} dimColor={!ctxColor} bold={ctxColor === 'error'}>
              {`ctx ${Math.round(context.tokens / 1000)}k / ${Math.round(context.limit / 1000)}k${ctxColor === 'error' ? ' · resets soon' : ''}`}
            </Text>
          ) : null}
        </Box>
      </Box>
      {onPage.length > 0 ? (
        <Box columnGap={3}>
          {columns.map((list, i) => (
            <Box key={`col${i}`} flexDirection="column" width={cellWidth}>
              {list.map(cell)}
            </Box>
          ))}
        </Box>
      ) : null}
      {shown ? (
        <Box justifyContent="space-between">
          <Text dimColor>
            {options.length ? `Empty prompt: 1–${options.length} answer  ·  ` : ''}
            {`alt+d (or ctrl+x tab), then ${options.length ? 'Enter ★' : 'Enter: answer in chat'} / o / n / p  ·  Esc: prompt`}
          </Text>
          <Text dimColor>click works too</Text>
        </Box>
      ) : null}
    </Box>
  )
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
