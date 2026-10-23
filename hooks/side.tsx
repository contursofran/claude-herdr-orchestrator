import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import type { Decision, Pr, SideItem, SideView, Todo } from '../types'
import { readBoard } from './board'
import { toggleWrapUp } from './coordinator'
import { SIDE_BOX_ROWS, SIDE_COLUMNS, SIDE_NEED_ROWS, SIDE_RECENT_MS, SIDE_WORK_ROWS } from './defaults'
import { ago, tilde } from './format'
import { herdr, type HerdrAgent } from './herdr'
import { linker, type LinkFn } from './links'
import { answered, choose, decisionTitle, openQuestions, pinnedItems, tick } from './owner'
import { cmd } from './session'
import { jobs } from './state'
import { groupTasks, STAGES, type ItemRef, type Stage, type Task } from './tasks'

// The sidebar (/hrd-side): what the band shows, docked beside the transcript. Work at the
// top, one row per issue or PR with a mark per stage; what needs the person at the bottom,
// level with the prompt, over a box of fixed height for the row picked. Nothing moves until
// the person asks: a finished row stays, struck through, until Clear done; a new one takes
// the next free slot; answering swaps the box's contents in place and stays on that item.

export const SIDE = 'hrd-side'
const side = atom(
  { plugin: 'herdr-agents', key: 'side' } as const,
  {
    tab: 'board',
    items: [],
    tasks: [],
    answers: {},
    cleared: {},
    prs: {},
  } as SideView,
)

export type SideRender = RenderInput<'Pane'>
type Pick = NonNullable<SideView['pick']>

// The rows the sidebar draws: the needs-you items and the tasks, each in its slot, with
// what closed items ended as and the open decisions and to-dos they come from.
async function gather($: EngineInterface, link: LinkFn) {
  const v = await read($, side)
  const board = await readBoard($)
  const now = await $.clock.now()
  const open = await openQuestions($)
  const todos = await pinnedItems($)
  const settled = await answered($)
  const live: SideItem[] = [
    ...todos.map(t => ({ key: `T${t.id}`, kind: t.kind, title: t.text, text: t.text, from: t.from, at: t.at })),
    ...open.map(d => ({ key: `D${d.id}`, kind: 'ask' as const, title: decisionTitle(d), text: d.question, from: d.from, at: d.at })),
  ].sort((x, y) => x.at - y.at)
  const isLive = new Set(live.map(it => it.key))
  const kept = new Set(v.items.map(it => it.key))
  const items = [...v.items, ...live.filter(it => !kept.has(it.key))]
  // How a closed item ended: the person's answer here, the coordinator's, or only that it closed.
  const endOf = (it: SideItem) => {
    const mine = v.answers[it.key]
    if (mine) return mine
    const s = settled.find(x => `D${x.id}` === it.key)
    if (s) return `${s.answer} (${s.by})`
    return it.kind === 'ask' ? 'answered' : it.kind === 'do' ? 'done' : 'dismissed'
  }

  const links = await linker($, board.rows, link)
  const refs: ItemRef[] = items.map(it => ({ key: it.key, kind: it.kind, from: it.from, text: it.text, isOpen: isLive.has(it.key) }))
  const all = groupTasks({
    jobs: Object.values(await jobs($)),
    rows: board.rows,
    items: refs,
    prs: v.prs,
    now,
    repoOf: j => links.repoIn(j.brief ?? '', j.cwd),
  })
  const byKey = new Map(all.map(t => [t.key, t]))
  // A task joins the table while it runs or waits on the person, or when it finished
  // lately; one Clear done removed comes back only with a new worker or a new question.
  const lastAt = (t: Task) => Math.max(...t.jobs.map(j => j.endedAt ?? now))
  const joins = (t: Task) => {
    const c = v.cleared[t.key]
    if (c !== undefined && t.jobs.length <= c && t.isFinished) return false
    return !t.isFinished || now - lastAt(t) < SIDE_RECENT_MS
  }
  const slotted = v.tasks.filter(k => byKey.has(k))
  const keys = [...slotted, ...all.filter(t => !slotted.includes(t.key) && joins(t)).map(t => t.key)]
  const tasks = keys.map(k => byKey.get(k)!)
  return { v, board, now, open, todos, items, isLive, endOf, tasks, links }
}

// Keeps the slots as drawn, so a row that closes stays where it was. Runs with the band's refresh.
export async function syncSide($: EngineInterface) {
  const held = await read($, side)
  if (!held.isOpen) return
  const g = await gather($, (_, text) => text)
  const items = g.items
  const tasks = g.tasks.map(t => t.key)
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
  if (
    same(
      items.map(it => it.key),
      held.items.map(it => it.key),
    ) &&
    same(tasks, held.tasks)
  )
    return
  await update($, side, s => ({ ...s, items, tasks }))
}

export async function sideOpen($: EngineInterface) {
  return (await $.ui.panes()).some(p => p.id === SIDE)
}

// Whether the sidebar is drawn now: the band then leaves its rows to it.
export async function sideShown($: EngineInterface) {
  if (!(await read($, side)).isOpen) return false
  return (await $.ui.panes()).some(p => p.id === SIDE && p.isPlaced)
}

export async function toggleSide($: EngineInterface) {
  if (await sideOpen($)) {
    await $.ui.close({ id: SIDE })
    return 'Sidebar closed.'
  }
  await update($, side, s => ({ ...s, isOpen: true }))
  const opened = await $.ui.open({ id: SIDE, title: 'herdr', columns: SIDE_COLUMNS })
  void pollPrs($).catch(() => {})
  return opened.isPlaced
    ? `Sidebar open: ctrl+x tab moves into it, ${cmd('side')} again closes it.`
    : `The sidebar opens once there is room: ${opened.reason}`
}

// The person or the mod closed the pane.
export async function sideClosed($: EngineInterface) {
  await update($, side, s => ({ ...s, isOpen: false }))
}

// The GitHub state of the open PRs the table lists: merged, and its checks.
export async function pollPrs($: EngineInterface) {
  if (!(await read($, side)).isOpen) return
  const { v, tasks, now } = await gather($, (_, text) => text)
  const want = tasks
    .filter(t => t.pr && t.repo)
    .map(t => `${t.repo}#${t.pr}`)
    .filter(k => v.prs[k]?.state !== 'MERGED' && v.prs[k]?.state !== 'CLOSED')
  const got: Record<string, Pr> = {}
  for (const k of want.slice(0, SIDE_WORK_ROWS)) {
    const [repo = '', n = ''] = k.split('#')
    try {
      const ran = await $.process.run(['gh', 'pr', 'view', n, '-R', repo, '--json', 'state,statusCheckRollup'], { timeoutMs: 20_000 })
      if (ran.exitCode !== 0) continue
      const pr = JSON.parse(ran.stdout) as { state: Pr['state']; statusCheckRollup?: Check[] }
      got[k] = { state: pr.state, ci: ciOf(pr.statusCheckRollup ?? []), at: now }
    } catch {}
  }
  if (Object.keys(got).length) await update($, side, s => ({ ...s, prs: { ...s.prs, ...got } }))
}

type Check = { __typename?: string; status?: string; conclusion?: string; state?: string }
const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
function ciOf(checks: Check[]): Pr['ci'] {
  if (checks.length === 0) return 'none'
  if (checks.some(c => FAILED.includes(c.conclusion ?? c.state ?? ''))) return 'fail'
  const pending = (c: Check) =>
    c.__typename === 'StatusContext' ? c.state === 'PENDING' || c.state === 'EXPECTED' : c.status !== 'COMPLETED'
  return checks.some(pending) ? 'pending' : 'pass'
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
const CELL = 5
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
const shortFrom = (from: string) => from.replace(/\s*\(.*$/, '').slice(0, 16)
// The rows of the table, header to status line, in a dock tall enough for all of them.
const FIXED_ROWS = 4 + 2 + SIDE_WORK_ROWS + 2 + SIDE_NEED_ROWS + 1 + SIDE_BOX_ROWS + 1

export async function drawSide($: EngineInterface, e: SideRender): Promise<RenderElement> {
  const { Box, Button, Link, Markdown, Text } = $.ui.resolve(e)
  const g = await gather($, (href, text, key) => (
    <Link key={key} href={href}>
      {text}
    </Link>
  ))
  const { v, board, now, open, todos, items, isLive, endOf, tasks, links } = g
  const cols = Math.max(30, e.props.bodyColumns)

  const firstOpen = items.find(it => isLive.has(it.key))
  const exists = (p: Pick) => (p.kind === 'item' ? items.some(it => it.key === p.key) : tasks.some(t => t.key === p.key))
  const pick: Pick | undefined =
    v.pick && exists(v.pick)
      ? v.pick
      : firstOpen
        ? { kind: 'item', key: firstOpen.key }
        : tasks[0]
          ? { kind: 'task', key: tasks[0].key }
          : undefined
  const choosePick = (p: Pick) => update($, side, s => ({ ...s, pick: p, tab: 'board' as const }))
  const say = (status: string) => update($, side, s => ({ ...s, status }))
  const taskOf = (key: string) =>
    tasks.find(t => t.item === key) ?? tasks.find(t => t.jobs.some(j => j.name === items.find(it => it.key === key)?.from))

  const glyph = (s: Stage, key: string, width = CELL) => (
    <Text key={key} dimColor={GLYPH[s].dim} bold={GLYPH[s].bold} color={GLYPH[s].subtle ? 'subtle' : undefined}>
      {center(GLYPH[s].ch, width)}
    </Text>
  )
  const tab = (name: SideView['tab'], hotkey: string) => (
    <Button key={`tab-${name}`} plain hotkey={hotkey} dimColor={v.tab !== name} onPress={() => update($, side, s => ({ ...s, tab: name }))}>
      <Text bold={v.tab === name}>{name}</Text>
    </Button>
  )
  const header = (
    <Box justifyContent="space-between">
      <Box columnGap={2}>
        {tab('board', 'b')}
        {tab('report', 'r')}
      </Box>
      {board.context ? <Text dimColor>{`ctx ${Math.round(board.context.tokens / 1000)}k`}</Text> : null}
    </Box>
  )
  const status = (
    <Text dimColor wrap="truncate-end">
      {v.status || ' '}
    </Text>
  )

  if (v.tab === 'report') return <Box flexDirection="column">{[header, await report(), status]}</Box>

  // The summary line.
  const busy = board.rows.filter(r => r.state !== 'reported' && r.state !== 'waiting').length
  const left = board.rows.filter(r => r.state !== 'reported').length
  const needCount = items.filter(it => isLive.has(it.key)).length
  const summary = [
    board.wrapUp ? `wrapping up · ${left} left` : board.target ? `${busy} of ${board.target} workers busy` : `${busy} busy`,
    needCount ? `${needCount} need${needCount === 1 ? 's' : ''} you` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  // The work table: cursor and #, title, five stage cells, who has it.
  const titleWidth = cols - 7 - 2 - STAGES.length * CELL - 11
  const finished = tasks.filter(t => t.isFinished)
  const clearTasks = () =>
    update($, side, s => ({
      ...s,
      tasks: s.tasks.filter(k => !finished.some(t => t.key === k)),
      cleared: { ...s.cleared, ...Object.fromEntries(finished.map(t => [t.key, t.jobs.length])) },
      status: `cleared ${finished.length} done`,
    }))
  const workHead = (
    <Box justifyContent="space-between">
      <Text dimColor>work</Text>
      <Box columnGap={2}>
        {finished.length ? (
          <Button key="clear-tasks" plain dimColor onPress={clearTasks}>
            clear done
          </Button>
        ) : null}
        <Button key="wrap-up" plain dimColor onPress={() => toggleWrapUp($, !board.wrapUp)}>
          {board.wrapUp ? 'keep going' : 'wrap up'}
        </Button>
      </Box>
    </Box>
  )
  const columns = (
    <Text dimColor>
      {' '.repeat(7)}
      {titleWidth > 3 ? ` ${' '.repeat(titleWidth)} ` : ''}
      {STAGES.map(s => center(s, CELL)).join('')}
    </Text>
  )
  const who = (t: Task) =>
    t.who.kind === 'you' ? (
      <Text key="who">
        {' '.repeat(Math.max(0, 9 - t.who.text.length))}
        <Text inverse bold>{` ${t.who.text} `}</Text>
      </Text>
    ) : (
      <Text key="who" dimColor={t.who.kind === 'dim'}>
        {fit(t.who.text, 10).trimEnd().padStart(11)}
      </Text>
    )
  const workRow = (t: Task) => {
    const isOn = pick?.kind === 'task' && pick.key === t.key
    return (
      <Button key={`task-${t.key}`} plain onPress={() => choosePick({ kind: 'task', key: t.key })}>
        <Text bold={isOn}>{isOn ? '▸' : ' '}</Text>
        <Text dimColor>{t.label.padEnd(6)}</Text>
        {titleWidth > 3 ? <Text dimColor={t.isFinished} strikethrough={t.isMerged}>{` ${fit(t.title, titleWidth)} `}</Text> : null}
        {t.stages.map((s, i) => glyph(s, `g${i}`))}
        {who(t)}
      </Button>
    )
  }
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
  const needWidth = cols - 16
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
          {fit(it.title, needWidth)}
        </Text>
        <Text dimColor>{` ${task.padStart(6)}`}</Text>
      </Button>
    )
  }

  const rule = <Text color="subtle">{'─'.repeat(cols)}</Text>
  const tall = e.props.placement === 'dock' && e.props.scroll.bodyRows >= FIXED_ROWS
  return (
    <Box flexDirection="column" height={tall ? e.props.scroll.bodyRows : undefined}>
      {header}
      <Box marginTop={1}>
        <Text>{summary}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {workHead}
        {columns}
        {slots(tasks, SIDE_WORK_ROWS, workRow, 'w', 'No workers yet.')}
      </Box>
      <Box flexGrow={1} />
      <Box flexDirection="column" marginTop={1}>
        {needHead}
        {slots(items, SIDE_NEED_ROWS, needRow, 'n', 'Nothing waits for you.')}
      </Box>
      {rule}
      <Box flexDirection="column" height={SIDE_BOX_ROWS} overflow="hidden">
        {pick?.kind === 'item' ? itemBox(items.find(it => it.key === pick.key)!) : null}
        {pick?.kind === 'task' ? taskBox(tasks.find(t => t.key === pick.key)!) : null}
        {!pick ? <Text dimColor>Pick a row to see it here.</Text> : null}
      </Box>
      {status}
    </Box>
  )

  // The box for a decision or a to-do: its question in at most three lines, the answers,
  // and once answered, what was sent. Same height either way.
  function itemBox(it: SideItem) {
    const isOpen = isLive.has(it.key)
    const d: Decision | undefined = open.find(x => `D${x.id}` === it.key)
    const t: Todo | undefined = todos.find(x => `T${x.id}` === it.key)
    const task = taskOf(it.key)
    const others = items.filter(x => isLive.has(x.key) && x.key !== it.key)
    const after = others.find(x => items.indexOf(x) > items.indexOf(it)) ?? others[0]
    const options = d
      ? (d.options ?? [])
          .map((label, i) => ({ label, isRec: i === d.recommended }))
          .sort((x, y) => Number(y.isRec) - Number(x.isRec))
          .slice(0, 3)
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
    const answerIt = async (dd: Decision, label: string) => {
      await keep(label, `${it.key} → ${label} · sent`)
      await choose($, dd, label)
    }
    const tickIt = async (tt: Todo) => {
      const done = tt.kind === 'do' ? 'done' : 'dismissed'
      await keep(done, `${it.key} ${done}${tt.kind === 'do' ? ' · sent' : ''}`)
      await tick($, tt)
    }
    let actions: RenderElement | null = null
    if (!isOpen) actions = <Text dimColor>{`✓ ${endOf(it)}`}</Text>
    else if (d)
      actions = (
        <Box columnGap={3}>
          {options.map((o, i) => (
            <Button key={`opt-${d.id}-${i}`} plain hotkey={String(i + 1)} onPress={() => answerIt(d, o.label)}>
              {o.isRec ? <Text inverse bold>{` ${o.label.slice(0, 24)} `}</Text> : o.label.slice(0, 24)}
            </Button>
          ))}
          <Button key={`chat-${d.id}`} plain hotkey="o" dimColor onPress={() => $.prompt.fill({ text: `${it.key}: `, mode: 'append' })}>
            answer in chat
          </Button>
        </Box>
      )
    else if (t)
      actions = (
        <Box columnGap={3}>
          <Button key={`tick-${t.id}`} plain hotkey="d" dimColor={t.kind === 'know'} onPress={() => tickIt(t)}>
            {t.kind === 'do' ? (
              <Text inverse bold>
                {' done '}
              </Text>
            ) : (
              'dismiss'
            )}
          </Button>
          {url ? (
            <Link key={`url-${t.id}`} href={/^https?:/.test(url) ? url : `http://${url}`}>
              open
            </Link>
          ) : null}
        </Box>
      )
    const hint =
      isOpen && d ? (options.length ? `1–${options.length} answers · o in chat` : 'o answers in chat') : isOpen && t ? 'd ticks it off' : ''
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box justifyContent="space-between" columnGap={2}>
          <Text bold wrap="truncate-end" strikethrough={!isOpen}>{`${it.key}  ${it.title}`}</Text>
          <Text dimColor>{`${shortFrom(it.from)} · ${ago(now - it.at)}`}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {wrapLines(it.text, cols, 3).map((l, i) => (
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
              <Button key="next" plain hotkey="n" dimColor={isOpen} onPress={() => choosePick({ kind: 'item', key: after.key })}>
                {`next ${after.key} ▸`}
              </Button>
            ) : null}
            {task ? (
              <Button key="go-task" plain dimColor onPress={() => choosePick({ kind: 'task', key: task.key })}>
                {`${task.label} ▸`}
              </Button>
            ) : null}
          </Box>
        </Box>
      </Box>
    )
  }

  // The box for a task: its stages spelled out, who has it, and where to look.
  function taskBox(t: Task) {
    const href = t.repo ? `https://github.com/${t.repo}/${t.pr ? `pull/${t.pr}` : `issues/${t.refs[0] ?? ''}`}` : undefined
    const where = t.repo ? `${t.repo.split('/')[1]} ${t.pr ? `PR #${t.pr}` : t.label}` : ''
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box justifyContent="space-between" columnGap={2}>
          <Text bold wrap="truncate-end">{`${t.label}  ${t.title}`}</Text>
          <Text dimColor>{where}</Text>
        </Box>
        <Text>
          {STAGES.flatMap((name, i) => [
            <Text key={`n${i}`} dimColor>{`${name} `}</Text>,
            glyph(t.stages[i]!, `s${i}`, 1),
            i < STAGES.length - 1 ? '   ' : '',
          ])}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {wrapLines(t.now, cols, 2).map((l, i) => (
            <Text key={`now${i}`} dimColor>
              {l}
            </Text>
          ))}
        </Box>
        <Box flexGrow={1} />
        <Box columnGap={3}>
          {t.item ? (
            <Button key="go-item" plain onPress={() => choosePick({ kind: 'item', key: t.item! })}>
              <Text inverse bold>{` ${t.item} ▸ `}</Text>
            </Button>
          ) : null}
          {href ? (
            <Link key="open-gh" href={href}>
              open
            </Link>
          ) : null}
          <Button key="show-report" plain onPress={() => update($, side, s => ({ ...s, tab: 'report' as const }))}>
            report
          </Button>
          {t.tab ? (
            <Button key="focus-tab" plain hotkey="t" onPress={() => focusTab($, t.tab!).then(say)}>
              {`tab ${t.tab}`}
            </Button>
          ) : null}
        </Box>
      </Box>
    )
  }

  // The last report of the task picked (or of the picked item's task), as Markdown.
  async function report(): Promise<RenderElement> {
    const t = pick?.kind === 'task' ? tasks.find(x => x.key === pick.key) : pick ? taskOf(pick.key) : undefined
    const back = (
      <Button key="back" plain dimColor onPress={() => update($, side, s => ({ ...s, tab: 'board' as const }))}>
        back
      </Button>
    )
    const j = t ? (t.jobs.filter(x => x.status === 'reported').at(-1) ?? t.jobs.at(-1)) : undefined
    if (!t || !j?.token)
      return (
        <Box key="report" flexDirection="column" marginTop={1}>
          <Text dimColor>{t ? `${t.label}: no report yet.` : 'Pick a task on the board to read its last report.'}</Text>
          <Box marginTop={1}>{back}</Box>
        </Box>
      )
    const result = `${j.dir}/RESULT-${j.token}.md`
    const screen = `${j.dir}/SCREEN-${j.token}.txt`
    const path = (await $.fs.exists(result)) ? result : (await $.fs.exists(screen)) ? screen : undefined
    const body = path ? (await $.fs.read(path)).slice(0, 8000) : `${j.name} has not reported yet.`
    const home = (await $.env.get('HOME')) ?? ''
    return (
      <Box key="report" flexDirection="column" marginTop={1}>
        <Text bold wrap="truncate-end">{`${t.label}  ${t.title}`}</Text>
        <Text dimColor wrap="truncate-start">{`${j.name} ${j.profile} · ${path ? tilde(path, home) : 'running'}`}</Text>
        <Box marginTop={1} flexDirection="column">
          {path?.endsWith('.md') ? <Markdown text={body} /> : <Text>{body}</Text>}
        </Box>
        <Box marginTop={1}>{back}</Box>
      </Box>
    )
  }
}

// Brings a worker's herdr tab to the front; says what happened, for the status line.
async function focusTab($: EngineInterface, name: string) {
  try {
    const got = await herdr<{ agent: HerdrAgent }>($, ['agent', 'get', name])
    await herdr($, ['tab', 'focus', got.agent.tab_id])
    return `focused ${name}`
  } catch (err) {
    return `${name}: ${String(err).slice(0, 80)}`
  }
}
