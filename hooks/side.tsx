import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import type { Decision, SideItem, SideView, Todo } from '../types'
import { gather, ghUrl, isJoined, pollPrs, type Joined } from './boarddata'
import { toggleWrapUp } from './coordinator'
import { SIDE_BOX_ROWS, SIDE_COLUMNS, SIDE_NEED_ROWS, SIDE_WORK_ROWS } from './defaults'
import { ago } from './format'
import { choose, tick } from './owner'
import { cmd } from './session'
import { jobs, patchJob } from './state'
import { briefRefs, STAGES, type Stage, type Task } from './tasks'

// The sidebar (/hrd-side): what the band shows, docked beside the transcript. Work at the
// top, one row per issue or PR with a mark per stage; what needs the person at the bottom,
// level with the prompt, over a box of fixed height for the row picked. Nothing moves until
// the person asks: a finished row stays, struck through, until Clear done; a new one takes
// the next free slot; answering swaps the box's contents in place and stays on that item.

export const SIDE = 'hrd-side'
const side = atom(
  { plugin: 'herdr-agents', key: 'side' } as const,
  {
    items: [],
    tasks: [],
    answers: {},
    cleared: {},
    prs: {},
  } as SideView,
)
export type SideRender = RenderInput<'Pane'>
type Pick = NonNullable<SideView['pick']>

// Keeps the slots as drawn, so a row that closes stays where it was. Runs with the band's refresh.
export async function syncSide($: EngineInterface) {
  if (!(await read($, side)).isOpen) return
  const { newItems, added, moved } = await gather($, (_, text) => text)
  if (!newItems.length && !added.length && [...moved].every(([k, to]) => to === k)) return
  // Applied to the slots as they are by now, so a Clear done pressed meanwhile stays done.
  await update($, side, s => ({
    ...s,
    items: [...s.items, ...newItems.filter(it => !s.items.some(x => x.key === it.key))],
    tasks: [
      ...new Set([
        ...s.tasks.flatMap(k => {
          const to = moved.get(k)
          return to === undefined ? [k] : to === null ? [] : [to]
        }),
        ...added.map(t => t.key),
      ]),
    ],
  }))
}

export async function sideOpen($: EngineInterface) {
  return (await $.ui.panes()).some(p => p.id === SIDE)
}

// Whether the sidebar is drawn now: the band then leaves its rows to it.
export async function sideShown($: EngineInterface) {
  if (!(await read($, side)).isOpen) return false
  return (await $.ui.panes()).some(p => p.id === SIDE && p.isPlaced && p.isShown)
}

export async function toggleSide($: EngineInterface) {
  if (await sideOpen($)) {
    await $.ui.close({ id: SIDE })
    return 'Sidebar closed.'
  }
  await update($, side, s => ({ ...s, isOpen: true }))
  const opened = await $.ui.open({ id: SIDE, title: 'herdr', columns: SIDE_COLUMNS })
  void backfillBriefs($).catch(() => {})
  void pollPrs($).catch(() => {})
  return opened.isPlaced
    ? `Sidebar open: ctrl+x tab moves into it, ${cmd('side')} again closes it.`
    : `The sidebar opens once there is room: ${opened.reason}`
}

// Workers started before the sidebar existed kept no brief: their TASK.md, else their
// name (b-645-fix2), gives the title and number their row goes by.
async function backfillBriefs($: EngineInterface) {
  for (const j of Object.values(await jobs($))) {
    if (j.brief !== undefined || j.refs) continue
    const file = `${j.dir}/TASK.md`
    const got = briefRefs((await $.fs.exists(file)) ? await $.fs.read(file) : '', j.name)
    if (Object.keys(got).length) await patchJob($, j.name, got)
  }
}

// The person or the mod closed the pane.
export async function sideClosed($: EngineInterface) {
  await update($, side, s => ({ ...s, isOpen: false }))
}

// The marks, monochrome: the shape says the stage, bold says it is the person's.
const GLYPH: Record<Stage, { ch: string; dim?: boolean; bold?: boolean; subtle?: boolean }> = {
  done: { ch: '✓', dim: true },
  run: { ch: '◐' },
  wait: { ch: '⏸', dim: true },
  none: { ch: '·', subtle: true },
  ask: { ch: '?', bold: true },
  todo: { ch: '☐', bold: true },
  block: { ch: '■', bold: true },
}
const center = (s: string, n: number) => {
  const left = Math.floor((n - s.length) / 2)
  return ' '.repeat(Math.max(0, left)) + s + ' '.repeat(Math.max(0, n - s.length - left))
}
const fit = (s: string, n: number) => (n <= 0 ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
// `text` in lines of `width`, at most `max`, the last one cut with … when more is left.
function wrapLines(text: string, width: number, max: number) {
  const lines: string[] = []
  let line = ''
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  const out = lines.slice(0, max).map(l => (l.length > width ? `${l.slice(0, width - 1)}…` : l))
  if (lines.length > max) out[max - 1] = fit(out[max - 1]!, width).replace(/.$/, '…')
  return out
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const shortFrom = (from: string) => from.replace(/\s*\(.*$/, '').slice(0, 16)
// The # column (#123456) with its gap; in the needs-you list, the cursor and the key.
const LABEL = 8
// Blank columns left and right of the sidebar's content. The transcript's side of the
// dock's edge is the engine's, half a cell; one column here keeps the content off the line.
const MARGIN_LEFT = 1
const MARGIN = 2
// The rows of the table, top margin to status line, in a dock tall enough for all of them.
const FIXED_ROWS = 2 + 2 + 2 + SIDE_WORK_ROWS + 2 + SIDE_NEED_ROWS + 1 + SIDE_BOX_ROWS + 1

export async function drawSide($: EngineInterface, e: SideRender): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  // herdr draws no OSC 8 links, so a Link there prints its URL after it: links in text stay
  // plain, and what opens a page is a Button.
  const g = await gather($, (_href, text) => text)
  const opener = (key: string, text: string, href: string, dim = true) => (
    <Button key={key} plain dimColor={dim} onPress={() => $.process.run(['open', href]).then(() => undefined)}>
      {text}
    </Button>
  )
  const { v, board, now, open, todos, items, isLive, endOf, rows, tasks, owner, links } = g
  // The margins on each side, inside the dock.
  const cols = Math.max(30, e.props.bodyColumns - MARGIN_LEFT - MARGIN)
  // A narrow dock gets narrower stage cells, then no who column.
  const cell = cols >= 45 ? 5 : 3
  const whoWidth = cols >= 56 ? 11 : 0

  const firstOpen = items.find(it => isLive.has(it.key))
  // Only a needs-you item is picked; with none, the box stays empty.
  const held = v.pick?.kind === 'item' && items.some(it => it.key === v.pick!.key) ? v.pick : undefined
  const pick: Pick | undefined = held ?? (firstOpen ? { kind: 'item', key: firstOpen.key } : undefined)
  const choosePick = (p: Pick) => update($, side, s => ({ ...s, pick: p }))
  const say = (status: string) => update($, side, s => ({ ...s, status }))
  const taskOf = (key: string) =>
    tasks.find(t => t.item === key) ?? tasks.find(t => t.jobs.some(j => j.name === items.find(it => it.key === key)?.from))

  const glyph = (s: Stage, key: string, width = cell) => (
    <Text key={key} dimColor={GLYPH[s].dim} bold={GLYPH[s].bold} color={GLYPH[s].subtle ? 'subtle' : undefined}>
      {center(GLYPH[s].ch, width)}
    </Text>
  )
  // The summary line, with wrap up and the context beside it. No hotkeys anywhere: the
  // engine draws them in the accent color, and the sidebar stays grey and white. Tab walks
  // the buttons, Enter presses.
  const busy = board.rows.filter(r => r.state !== 'reported' && r.state !== 'waiting').length
  const left = board.rows.filter(r => r.state !== 'reported').length
  const needCount = items.filter(it => isLive.has(it.key)).length
  const summary = [
    board.wrapUp ? `wrapping up · ${left} left` : board.target ? `${busy} of ${board.target} workers busy` : `${busy} busy`,
    needCount ? `${needCount} need${needCount === 1 ? 's' : ''} you` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const header = (
    <Box key="header" justifyContent="space-between" columnGap={2}>
      <Text wrap="truncate-end">{summary}</Text>
      <Box columnGap={2} flexShrink={0}>
        <Button key="wrap-up" plain dimColor onPress={() => toggleWrapUp($, !board.wrapUp)}>
          {board.wrapUp ? 'keep going' : 'wrap up'}
        </Button>
        {board.context ? <Text dimColor>{ctxUsed(board.context)}</Text> : null}
      </Box>
    </Box>
  )
  const status = (
    <Text key="status" dimColor wrap="truncate-end">
      {v.status || ' '}
    </Text>
  )

  // The work table: cursor and #, title, five stage cells, who has it.
  // The # column is as wide as the longest number in it and a gap.
  const numWidth = Math.min(LABEL, 1 + Math.max(4, ...rows.map(r => r.label.length)))
  const titleWidth = cols - numWidth - 2 - STAGES.length * cell - whoWidth
  const finished = tasks.filter(t => t.isFinished)
  const joined = rows.filter(isJoined)
  const done = new Set([...finished.map(t => t.key), ...joined.map(j => j.key)])
  const clearTasks = () =>
    update($, side, s => ({
      ...s,
      tasks: s.tasks.filter(k => !done.has(k) && !done.has(owner(k)?.key ?? '')),
      cleared: { ...s.cleared, ...Object.fromEntries(finished.map(t => [t.key, t.jobs.length])) },
      status: `cleared ${done.size} done`,
    }))
  const workHead = (
    <Box justifyContent="space-between">
      <Text dimColor>issues</Text>
      {done.size ? (
        <Button key="clear-tasks" plain dimColor onPress={clearTasks}>
          clear done
        </Button>
      ) : null}
    </Box>
  )
  const columns = (
    <Text dimColor>
      {' '.repeat(numWidth)}
      {titleWidth > 3 ? ` ${' '.repeat(titleWidth)} ` : ''}
      {STAGES.map(s => center(s.length > cell ? s.slice(0, 1) : s, cell)).join('')}
    </Text>
  )
  const who = (t: Task) =>
    !whoWidth ? null : t.who.kind === 'you' ? (
      <Text key="who">
        {' '.repeat(Math.max(0, 9 - t.who.text.length))}
        <Text inverse bold>{` ${t.who.text} `}</Text>
      </Text>
    ) : (
      <Text key="who" dimColor={t.who.kind === 'dim'}>
        {fit(t.who.text, 10).trimEnd().padStart(11)}
      </Text>
    )
  // The # opens the issue or PR; the row itself is not pressable, so the pointer lights
  // only the link.
  const label = (key: string, text: string, href: string | undefined) => {
    return href ? (
      <Box key={`n-${key}`} width={numWidth}>
        {opener(`gh-${key}`, text, href)}
      </Box>
    ) : (
      <Text dimColor>{text.padEnd(numWidth)}</Text>
    )
  }
  const workRow = (t: Task) => (
    <Box key={`task-${t.key}`}>
      {label(t.key, t.label, ghUrl(t))}
      {titleWidth > 3 ? <Text color={t.isFinished ? 'subtle' : undefined}>{` ${fit(t.title, titleWidth)} `}</Text> : null}
      {t.stages.map((s, i) => glyph(s, `g${i}`))}
      {who(t)}
    </Box>
  )
  const joinedRow = (j: Joined) => (
    <Box key={`task-${j.key}`}>
      {label(j.key, j.label, undefined)}
      <Text dimColor strikethrough>{` ${fit(`joined ${j.into.label}`, cols - numWidth - 2)}`}</Text>
    </Box>
  )
  const slotRow = (r: Task | Joined) => (isJoined(r) ? joinedRow(r) : workRow(r))
  const spare = (n: number, at: string) => Array.from({ length: Math.max(0, n) }, (_, i) => <Text key={`${at}${i}`}> </Text>)
  const slots = <T,>(list: T[], rows: number, draw: (x: T) => RenderElement, at: string, empty: string) => {
    const over = list.length > rows
    const shown = over ? list.slice(0, rows - 1) : list
    return [
      ...(list.length === 0 ? [<Text key={`${at}-empty`} dimColor>{` ${empty}`}</Text>] : shown.map(draw)),
      ...(over ? [<Text key={`${at}-more`} dimColor>{`  +${list.length - shown.length} more · clear done frees rows`}</Text>] : []),
      ...spare(rows - Math.max(1, shown.length + (over ? 1 : 0)), at),
    ]
  }

  // What needs the person, at the bottom.
  const resolved = items.filter(it => !isLive.has(it.key))
  const clearItems = () =>
    update($, side, s => ({
      ...s,
      items: s.items.filter(it => !resolved.some(r => r.key === it.key)),
      answers: Object.fromEntries(Object.entries(s.answers).filter(([k]) => !resolved.some(r => r.key === k))),
      status: `cleared ${resolved.length} done`,
    }))
  const needHead = (
    <Box justifyContent="space-between">
      <Text dimColor>
        {'needs you  '}
        <Text bold dimColor={false}>
          {String(needCount)}
        </Text>
      </Text>
      {resolved.length ? (
        <Button key="clear-items" plain dimColor onPress={clearItems}>
          clear done
        </Button>
      ) : null}
    </Box>
  )
  const needRow = (it: SideItem) => {
    const isOn = pick?.kind === 'item' && pick.key === it.key
    const isOpen = isLive.has(it.key)
    const mark = !isOpen ? '✓' : it.kind === 'ask' ? '?' : it.kind === 'do' ? '☐' : 'ℹ'
    const quiet = !isOpen || it.kind === 'know'
    const task = taskOf(it.key)?.label ?? it.text.match(/#\d{1,6}\b/)?.[0] ?? ''
    return (
      <Button key={`item-${it.key}`} plain onPress={() => choosePick({ kind: 'item', key: it.key })}>
        <Text bold={isOn}>{isOn ? '▸ ' : '  '}</Text>
        <Text bold={!quiet} dimColor={quiet}>{`${mark} ${it.key.padEnd(4)} `}</Text>
        <Text dimColor={quiet} strikethrough={!isOpen}>
          {fit(it.title, cols - LABEL - 5 - Math.max(4, it.key.length))}
        </Text>
        <Text dimColor>{` ${task.padStart(LABEL - 1)}`}</Text>
      </Button>
    )
  }

  const tall = e.props.placement === 'dock' && e.props.scroll.bodyRows >= FIXED_ROWS
  return (
    <Box
      flexDirection="column"
      paddingLeft={MARGIN_LEFT}
      paddingRight={MARGIN}
      paddingTop={1}
      height={tall ? e.props.scroll.bodyRows : undefined}
    >
      {header}
      <Box flexDirection="column" marginTop={1}>
        {workHead}
        {columns}
        {slots(rows, SIDE_WORK_ROWS, slotRow, 'w', 'No workers yet.')}
      </Box>
      <Box flexGrow={1} />
      <Box flexDirection="column" marginTop={1}>
        {needHead}
        {slots(items, SIDE_NEED_ROWS, needRow, 'n', 'Nothing waits for you.')}
      </Box>
      <Text color="subtle">{'─'.repeat(cols)}</Text>
      <Box flexDirection="column" marginTop={1} height={SIDE_BOX_ROWS} overflow="hidden">
        {pick ? itemBox(items.find(it => it.key === pick.key)!) : null}
      </Box>
      {status}
    </Box>
  )

  // The box for a decision or a to-do: its question in at most three lines, the answers,
  // and once answered, what was sent. Same height either way: answers that take a second
  // line take one from the question.
  function itemBox(it: SideItem) {
    const isOpen = isLive.has(it.key)
    const d: Decision | undefined = open.find(x => `D${x.id}` === it.key)
    const t: Todo | undefined = todos.find(x => `T${x.id}` === it.key)
    const task = taskOf(it.key)
    const others = items.filter(x => isLive.has(x.key) && x.key !== it.key)
    const after = others.find(x => items.indexOf(x) > items.indexOf(it)) ?? others[0]
    const options = d
      ? (d.options ?? []).map((label, i) => ({ label, isRec: i === d.recommended })).sort((x, y) => Number(y.isRec) - Number(x.isRec))
      : []
    const url = t?.text.match(/\bhttps?:\/\/\S+|\blocalhost:\d+\S*/)?.[0]?.replace(/[).,;]+$/, '')
    // Answered here: the row keeps its slot, struck through, and the box stays on it.
    const keep = (answer: string, status: string) =>
      update($, side, s => ({
        ...s,
        items: [...s.items, ...items.filter(x => !s.items.some(y => y.key === x.key))],
        pick: { kind: 'item' as const, key: it.key },
        answers: { ...s.answers, [it.key]: answer },
        status,
      }))
    // "sent" once the prompt went out; what failed otherwise.
    const send = async (answer: string, status: string, run: () => Promise<unknown>) => {
      await keep(answer, status)
      try {
        await run()
        await say(`${status}${answer === 'dismissed' ? '' : ' · sent'}`)
      } catch (err) {
        await say(`${it.key} not sent: ${String(err).slice(0, 60)}`)
      }
    }
    const answerIt = (dd: Decision, label: string) => send(label, `${it.key} → ${label}`, () => choose($, dd, label))
    const tickIt = (tt: Todo) => {
      const done = tt.kind === 'do' ? 'done' : 'dismissed'
      return send(done, `${it.key} ${done}`, () => tick($, tt))
    }
    // The answers, then answer in chat, in as many lines as the width takes; two always fit a line.
    const most = Math.max(8, Math.floor((cols - 3) / 2) - 2)
    const chips = [
      ...options.map((o, i) => ({ ...o, i, text: clip(o.label, most) })),
      { label: '', isRec: false, i: -1, text: 'answer in chat' },
    ]
    const lines: (typeof chips)[] = []
    let width = 0
    for (const c of chips) {
      const w = c.text.length + (c.isRec ? 2 : 0)
      if (lines.length && width + 3 + w <= cols) {
        lines.at(-1)!.push(c)
        width += 3 + w
      } else {
        lines.push([c])
        width = w
      }
    }
    let actions: RenderElement | null = null
    if (!isOpen) actions = <Text dimColor>{`✓ ${endOf(it)}`}</Text>
    else if (d)
      actions = (
        <Box flexDirection="column">
          {lines.map((line, l) => (
            <Box key={`ol${l}`} columnGap={3}>
              {line.map(c =>
                c.i < 0 ? (
                  <Button key={`chat-${d.id}`} plain dimColor onPress={() => $.prompt.fill({ text: `${it.key}: `, mode: 'append' })}>
                    {c.text}
                  </Button>
                ) : (
                  <Button key={`opt-${d.id}-${c.i}`} plain onPress={() => answerIt(d, c.label)}>
                    {c.isRec ? <Text inverse bold>{` ${c.text} `}</Text> : c.text}
                  </Button>
                ),
              )}
            </Box>
          ))}
        </Box>
      )
    else if (t)
      actions = (
        <Box columnGap={3}>
          <Button key={`tick-${t.id}`} plain dimColor={t.kind === 'know'} onPress={() => tickIt(t)}>
            {t.kind === 'do' ? (
              <Text inverse bold>
                {' done '}
              </Text>
            ) : (
              'dismiss'
            )}
          </Button>
          {url ? opener(`url-${t.id}`, 'open', /^https?:/.test(url) ? url : `http://${url}`, false) : null}
        </Box>
      )
    const hint = isOpen && (d || t) ? 'tab moves · enter presses' : ''
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box justifyContent="space-between" columnGap={2}>
          <Text bold wrap="truncate-end" strikethrough={!isOpen}>{`${it.key}  ${it.title}`}</Text>
          <Text dimColor>{`${shortFrom(it.from)} · ${ago(now - it.at)}`}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {wrapLines(it.text, cols, Math.max(1, Math.min(3, SIDE_BOX_ROWS - 4 - (isOpen && d ? lines.length : 1)))).map((l, i) => (
            <Text key={`q${i}`} dimColor={!isOpen}>
              {links.linkify(l, links.repoOf(it.from))}
            </Text>
          ))}
        </Box>
        <Box flexGrow={1} />
        {actions}
        <Box justifyContent="space-between" marginTop={1}>
          <Text color="subtle">{hint}</Text>
          <Box columnGap={2}>
            {after ? (
              <Button key="next" plain dimColor={isOpen} onPress={() => choosePick({ kind: 'item', key: after.key })}>
                {`next ${after.key} ▸`}
              </Button>
            ) : null}
            {task && ghUrl(task) ? opener('go-task', `${task.label} ▸`, ghUrl(task)!) : null}
          </Box>
        </Box>
      </Box>
    )
  }
}

// The context used, in thousands of tokens and as a share of the coordinator's reset limit.
function ctxUsed({ tokens, limit }: { tokens: number; limit: number }) {
  return `ctx ${Math.round(tokens / 1000)}k ${Math.round((100 * tokens) / limit)}%`
}
