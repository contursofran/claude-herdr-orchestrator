import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app, findId, textOf } from './fake-gpui.mjs'

// Taken when the mod is imported, so it is set before that.
const hcCalls = []
globalThis.__fakeGpui.hc = async args => (hcCalls.push(args), { code: 0, stdout: '' })

const m = await import('../mods/herdr-agents/panelmodel.js')
const { floatView, panelFor, panelView, stageHead, workerView } = await import('../mods/herdr-agents/panel.js')
const { panelHeld } = await import('../mods/herdr-agents/panelheld.js')

app.theme = {
  background: '#111111',
  selected: '#404040',
  muted: '#505050',
  foreground: '#606060',
  hover: '#707070',
  working: '#808080',
  blocked: '#909090',
}

const COORD = 't1'
const board = (extra = {}) => ({
  session: 's',
  cwd: '/code/repo',
  coordinator: { terminal: COORD },
  workers: [{ name: 'fix-1', state: 'working' }],
  tasks: [],
  ...extra,
})
const terms = [
  { address: COORD, name: null },
  { address: 't2', name: 'fix-1' },
  { address: 't3', name: null },
]
const OPEN = [
  ['layout.select', { stack: 'panel-body', child: 'hrd-panel' }],
  ['layout.show', { id: 'panel' }],
]
const WIDE = 1400

test("arriving at an orchestrator's tab opens a closed panel on the board, once", () => {
  const first = m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'closed', WIDE)
  assert.deepEqual(first.commands, OPEN)
  // Closed again on this tab, it stays closed until the owner leaves.
  assert.deepEqual(m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'closed', WIDE, first).commands, [])
  // Back from elsewhere is a new arrival.
  const away = m.panelMove({ tab: 'b', terminal: 't3' }, board(), terms, 'closed', WIDE, first)
  assert.deepEqual(m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'closed', WIDE, away).commands, OPEN)
})

test('Files or Changes the owner picked stay when arriving at an orchestrator', () => {
  for (const state of ['files', 'changes', 'board']) {
    assert.deepEqual(m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, state, WIDE).commands, [])
  }
})

test('the board comes back over a Changes this code moved to, not over one the owner then picked', () => {
  const shell = m.panelMove({ tab: 's', terminal: 't3' }, board(), terms, 'board', WIDE)
  assert.equal(shell.moved, true)
  assert.deepEqual(m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'changes', WIDE, shell).commands, OPEN)
  assert.deepEqual(m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'files', WIDE, shell).commands, [])
})

test('a draw before the move to Changes lands does not forget it was this code that moved', () => {
  const shell = m.panelMove({ tab: 's', terminal: 't3' }, board(), terms, 'board', WIDE)
  const early = m.panelMove({ tab: 's', terminal: 't3' }, board(), terms, 'board', WIDE, shell)
  assert.equal(early.moved, true)
  assert.deepEqual(m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'changes', WIDE, early).commands, OPEN)
  // Arriving with the board back up ends it: a Changes picked after that is the owner's.
  assert.equal(m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'board', WIDE, early).moved, false)
})

test('closing the board holds: arriving no longer opens it', () => {
  assert.deepEqual(m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'closed', WIDE, null, true).commands, [])
})

test("a worker's tab leaves the panel as it is, so nothing resizes", () => {
  for (const state of ['board', 'closed', 'files', 'changes']) {
    assert.deepEqual(m.panelMove({ tab: 'w', terminal: 't2' }, board(), terms, state, WIDE).commands, [])
  }
})

test("a worker's tab takes back a Changes this code moved to, and Files the owner picked stays", () => {
  const shell = m.panelMove({ tab: 's', terminal: 't3' }, board(), terms, 'board', WIDE)
  assert.deepEqual(m.panelMove({ tab: 'w', terminal: 't2' }, board(), terms, 'changes', WIDE, shell).commands, OPEN)
  assert.deepEqual(m.panelMove({ tab: 'w', terminal: 't2' }, board(), terms, 'files', WIDE, shell).commands, [])
})

test('a shell tab goes back to Changes only when the board was showing', () => {
  const back = [['layout.select', { stack: 'panel-body', child: 'changes' }]]
  assert.deepEqual(m.panelMove({ tab: 's', terminal: 't3' }, board(), terms, 'board', WIDE).commands, back)
  assert.deepEqual(m.panelMove({ tab: 's', terminal: 't3' }, null, terms, 'board', WIDE).commands, back)
  assert.deepEqual(m.panelMove({ tab: 's', terminal: 't3' }, board(), terms, 'files', WIDE).commands, [])
})

test('a narrow window does not open it, and widening past the limit does', () => {
  const narrow = m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'closed', m.PANEL_MIN_WORK_PX - 1)
  assert.deepEqual(narrow.commands, [])
  assert.deepEqual(m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'closed', m.PANEL_MIN_WORK_PX, narrow).commands, OPEN)
})

test('nothing is decided before the strip is measured or with no focus', () => {
  const last = { key: 'old', moved: true }
  assert.deepEqual(m.panelMove({ tab: 'a', terminal: COORD }, board(), terms, 'closed', null, last), { ...last, commands: [] })
  assert.deepEqual(m.panelMove(null, board(), terms, 'closed', WIDE, last), { ...last, commands: [] })
})

test("the panel's state comes from the layout", () => {
  const root = (hidden, active) => ({ id: 'r', children: [{ id: 'panel', hidden, children: [{ id: 'panel-body', active }] }] })
  assert.equal(m.panelState(root(false, 'hrd-panel')), 'board')
  assert.equal(m.panelState(root(true, 'hrd-panel')), 'closed')
  assert.equal(m.panelState(root(false, 'changes')), 'changes')
  assert.equal(m.panelState(null), null)
})

test('the bottom row offers panel when it is closed with room, nothing over the open board, else the pop-up', () => {
  assert.equal(m.bottomPill('closed', WIDE, true), 'panel')
  assert.equal(m.bottomPill('closed', WIDE, false), 'panel')
  assert.equal(m.bottomPill('board', WIDE, true), null)
  assert.equal(m.bottomPill('board', WIDE, false), 'board')
  assert.equal(m.bottomPill('files', WIDE, true), 'board')
  assert.equal(m.bottomPill('closed', m.PANEL_MIN_WORK_PX - 1, true), 'panel')
  assert.equal(m.bottomPill('closed', null, true), 'board')
  assert.equal(m.bottomPill(null, WIDE, true), 'board')
})

const task = (key, extra) => ({ key, label: key, title: `Title ${key}`, stages: [], who: { text: 'building', kind: 'dim' }, ...extra })

test('rows split into what can still need a look and merged, merged newest first; other finished rows leave', () => {
  const merged = { isMerged: true, who: { text: 'merged', kind: 'dim' } }
  const b = board({
    tasks: [
      task('a', { ...merged, mergedAt: 100 }),
      task('b'),
      task('c', { ...merged, mergedAt: 300 }),
      task('d', { isFinished: true, who: { text: 'done', kind: 'dim' } }),
      task('e', { ...merged }),
      task('f', { isMerged: true, who: { text: 'you', kind: 'you' } }), // merged, but a test waits on the owner
      task('g', { ...merged, isFinished: true, mergedAt: 200 }),
    ],
  })
  const keys = rows => rows.map(r => r.key)
  const s = m.panelSections(b)
  assert.deepEqual(keys(s.work), ['b', 'f'])
  assert.deepEqual(keys(s.merged), ['c', 'g', 'a', 'e'])
})

test('a long history shows its newest rows until asked for all of them', () => {
  const tasks = Array.from({ length: 5 }, (_, i) =>
    task(`d${i}`, { isMerged: true, mergedAt: 100 - i, who: { text: 'merged', kind: 'dim' } }),
  )
  const ui = { open: new Set() }
  const view = () => panelView(board({ tasks }), 0, ui)
  const shown = () => textOf(view()).filter(t => /^Title d/.test(t))
  assert.deepEqual(shown(), ['Title d0', 'Title d1', 'Title d2'])
  assert.ok(textOf(view()).includes('all 5'))
  findId(view(), 'panel-all-Merged').node.calls.on_mouse_down[1](null, { notify() {} })
  assert.equal(shown().length, 5)
  assert.ok(textOf(view()).includes('fewer'))
  findId(view(), 'panel-all-Merged').node.calls.on_mouse_down[1](null, { notify() {} })
  assert.equal(shown().length, 3)
})

test('a short history has no toggle, and an empty one no head', () => {
  const view = panelView(board({ tasks: [task('m', { isMerged: true, who: { text: 'merged', kind: 'dim' } })] }), 0)
  assert.equal(findId(view, 'panel-all-Merged'), null)
  assert.ok(textOf(view).includes('Merged'))
  assert.ok(!textOf(panelView(board({ tasks: [task('a')] }), 0)).includes('Merged'))
})

test('the rows scroll with a visible scrollbar, and the panel is framed like Changes', () => {
  const view = panelView(board(), 0)
  assert.ok(findId(view, 'panel-rows').node.calls.overflow_y_scrollbar)
  assert.deepEqual(view.node.calls.rounded, [10])
  assert.ok(view.node.calls.border_1)
})

test('the view draws both lists, with the PR as a link', () => {
  const b = board({
    tasks: [
      task('#7', { pr: 7, url: 'https://github.com/o/r/pull/7' }),
      task('m', { isMerged: true, mergedAt: 1000, who: { text: 'merged', kind: 'dim' } }),
    ],
  })
  const view = panelView(b, 1000 + 2 * 3600 * 1000)
  const text = textOf(view)
  for (const want of ['Title #7', '#7 ↗', 'building', 'Merged', 'Title m', 'merged 2h']) assert.ok(text.includes(want), want)
  assert.ok(findId(view, 'panel-pr-#7'))
  // The age already says merged.
  assert.equal(text.filter(t => t === 'merged').length, 0)
})

test('with nothing to show it says so instead of drawing empty', () => {
  assert.ok(textOf(panelView(null)).includes('No board for this tab.'))
  assert.ok(textOf(panelView(board())).includes('Nothing running.'))
})

test('stage heads fit their narrow cells', () => {
  assert.deepEqual(['plan', 'build', 'rev', 'CI', 'you'].map(stageHead), ['P', 'B', 'R', 'CI', 'you'])
})

test('the header says what the orchestrator is doing, and has no wrap-up', () => {
  app.terminals = [{ address: COORD, status: 'working' }]
  assert.ok(textOf(panelView(board(), 0)).includes('working'))
  app.terminals = []
  assert.ok(!textOf(panelView(board(), 0)).includes('working'))
  assert.equal(findId(panelView(board(), 0), 'panel-wrap'), null)
})

test('its close button hides the panel and remembers', () => {
  app.ran.length = 0
  findId(panelView(board(), 0), 'panel-close').node.calls.on_click[0]()
  assert.deepEqual(app.ran, [['layout.hide', { id: 'panel' }]])
  assert.equal(panelHeld(), true)
  app.store['hrd.panelHidden'] = undefined
})

const worker = { name: 'fix-1', profile: 'builder', state: 'working', repo: 'o/app', note: null }

test('a worker is found by its tab, and only on its own board', () => {
  assert.equal(m.focusedWorker(board(), terms, { terminal: 't2' })?.name, 'fix-1')
  assert.equal(m.focusedWorker(board(), terms, { terminal: 't3' }), null)
  assert.equal(m.focusedWorker(board(), terms, { terminal: COORD }), null)
  assert.equal(m.focusedWorker(board({ workers: [] }), terms, { terminal: 't2' }), null)
  assert.equal(m.focusedWorker(null, terms, { terminal: 't2' }), null)
})

test("a worker's row is the one naming it, the running one over a finished one", () => {
  const b = board({
    tasks: [task('old', { tab: 'fix-1', isFinished: true }), task('new', { workers: ['fix-1'] }), task('other', { tab: 'fix-2' })],
  })
  assert.equal(m.workerRow(b, worker).key, 'new')
  assert.equal(m.workerRow(board({ tasks: [task('old', { tab: 'fix-1', isFinished: true })] }), worker).key, 'old')
  assert.equal(m.workerRow(board(), worker), null)
})

test('plan shows only for a planned row', () => {
  const names = ['plan', 'build', 'rev', 'CI', 'you']
  assert.deepEqual(m.rowStageNames({ stages: ['done', 'run'] }, names), names)
  assert.deepEqual(m.rowStageNames({ stages: ['none', 'run'] }, names), names.slice(1))
})

test("a worker's tab draws that worker, and any other tab the board", () => {
  app.terminals = terms
  const b = board({ tasks: [task('#7', { tab: 'fix-1', pr: 7, url: 'https://github.com/o/r/pull/7', now: 'Building the fix.' })] })
  const shown = panelFor({ ...b, workers: [worker] }, { terminal: 't2' }, 0, { open: new Set() })
  assert.ok(findId(shown, 'hrd-panel-worker'))
  const text = textOf(shown)
  for (const want of ['fix-1', 'builder', 'working', 'app', 'Title #7', 'Building the fix.', '#7 ↗', 'Stop'])
    assert.ok(text.includes(want), want)
  assert.ok(findId(panelFor(b, { terminal: COORD }, 0, { open: new Set() }), 'hrd-panel'))
  app.terminals = []
})

test('a worker with no task says so, and a blocked one says why', () => {
  const text = textOf(workerView(board(), { ...worker, state: 'blocked', note: 'permission prompt' }))
  assert.ok(text.includes('No task on the board for this worker.'))
  assert.ok(text.includes('app · permission prompt'))
})

test('Stop takes a second press, and only then sends', async () => {
  const ui = { open: new Set() }
  const b = board()
  const press = () => findId(workerView(b, worker, ui), 'panel-stop').node.calls.on_mouse_down[1](null, { notify() {} })
  const sent = () => Object.values(app.files).filter(v => String(v).includes('"action":"stop"'))
  press()
  assert.ok(textOf(workerView(b, worker, ui)).includes('Stop fix-1?'))
  await new Promise(r => setImmediate(r))
  assert.deepEqual(sent(), [])
  press()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(sent(), [JSON.stringify({ action: 'stop', worker: 'fix-1' })])
  assert.equal(ui.stopping, null)
  assert.ok(textOf(workerView(b, worker, ui)).includes('Stop'))
})

test('it floats only where there is no room for it, and unmeasured it does', () => {
  assert.equal(m.panelFloats(m.PANEL_MIN_WORK_PX), false)
  assert.equal(m.panelFloats(m.PANEL_MIN_WORK_PX - 1), true)
  assert.equal(m.panelFloats(undefined), true)
})

test('floating leaves the rows above and below clear, down to a least height', () => {
  assert.equal(m.panelFloatHeight(700), 700 - 158)
  assert.equal(m.panelFloatHeight(300), 240)
})

const ctl = { h: {} }

test('the floating panel follows the tab it hands back to, and its close and rows only close it', () => {
  app.terminals = terms
  app.props = { overlay: 'o1', height: 500, back: 't2' }
  app.store['hrd.popup'] = 'o1'
  app.closed.length = 0
  app.ran.length = 0
  const b = board({ workers: [worker], tasks: [task('a')] })
  assert.ok(findId(floatView(b, ctl, 0, { open: new Set() }), 'hrd-panel-worker'))
  app.props = { overlay: 'o1', height: 500, back: COORD }
  const ui = { open: new Set() }
  const view = floatView(b, ctl, 0, ui)
  assert.ok(findId(view, 'hrd-panel'))
  findId(view, 'panel-close').node.calls.on_click[0]()
  assert.deepEqual(app.closed, ['o1'])
  assert.equal(app.store['hrd.popup'], null)
  assert.deepEqual(app.ran, [], 'the layout panel is left alone')
  assert.equal(panelHeld(), false)
  findId(floatView(b, ctl, 0, ui), 'panel-a').node.calls.on_mouse_down[1]()
  assert.equal(app.closed.length, 2)
  assert.equal(ctl.leaving, true, 'a row moved the keyboard, so closing leaves it there')
  app.terminals = []
  app.props = null
})

test('a blocked worker moves its row to Needs a look, saying why, once however many share it', () => {
  const b = board({
    workers: [
      { name: 'w1', state: 'blocked', note: 'permission prompt' },
      { name: 'w2', state: 'blocked' },
      { name: 'w3', state: 'blocked' },
      { name: 'w4', state: 'working' },
    ],
    tasks: [task('a', { workers: ['w1', 'w2'] }), task('b', { tab: 'w4' })],
  })
  const s = m.panelSections(b)
  assert.deepEqual(
    s.look.map(r => [r.key, r.blocked]),
    [
      ['a', 'permission prompt'],
      ['worker-w3', 'waiting'],
    ],
  )
  assert.deepEqual(
    s.work.map(r => r.key),
    ['b'],
  )
})

test('Needs a look draws only when it has rows, and takes the stage heads', () => {
  const heads = v => textOf(v).filter(t => t === 'P').length
  const clear = panelView(board({ tasks: [task('a')] }), 0)
  assert.ok(!textOf(clear).some(t => /^Needs a look/.test(t)))
  assert.equal(heads(clear), 1)
  const view = panelView(
    board({ workers: [{ name: 'w1', state: 'blocked', note: 'permission prompt' }], tasks: [task('a', { tab: 'w1' })] }),
    0,
  )
  const text = textOf(view)
  for (const want of ['Needs a look · 1', 'blocked · permission prompt', 'open tab']) assert.ok(text.includes(want), want)
  assert.equal(heads(view), 1)
})

test("a worker's view goes back to its orchestrator, and has no way back without one", () => {
  app.ran.length = 0
  const view = workerView(board(), worker)
  assert.ok(textOf(view).includes('‹ repo board'))
  findId(view, 'panel-back').node.calls.on_mouse_down[1]()
  assert.deepEqual(app.ran, [['pane.focus', { terminal: COORD }]])
  assert.equal(findId(workerView(board({ coordinator: { terminal: null } }), worker), 'panel-back'), null)
})

test('going back from a floating panel closes it and leaves the keyboard on the orchestrator', () => {
  app.terminals = terms
  app.props = { overlay: 'o2', height: 500, back: 't2' }
  app.closed.length = 0
  const leaving = { h: {} }
  const b = board({ workers: [worker] })
  findId(floatView(b, leaving, 0, { open: new Set() }), 'panel-back').node.calls.on_mouse_down[1]()
  assert.deepEqual(app.closed, ['o2'])
  assert.equal(leaving.leaving, true)
  app.terminals = []
  app.props = null
})

test("a working worker's row and its view say what it is doing, and a blocked one's say nothing", () => {
  const now = Date.now()
  const live = (state, extra) =>
    board({
      workers: [{ name: 'fix-1', state, ...extra }],
      tasks: [
        { key: 'k', label: '#1', title: 'One', tab: 'fix-1', who: { text: 'fix-1 3m', kind: 'text' }, workers: ['fix-1'], stages: [] },
      ],
    })
  const running = { command: 'npm test', commandAt: now - 180_000, outputAt: now }
  const b = live('working', running)
  app.focus = { terminal: COORD }
  assert.match(textOf(panelView(b)).join(' '), /fix-1 3m/)
  assert.match(textOf(panelView(b)).join(' '), /running npm test/)
  assert.match(textOf(workerView(b, b.workers[0])).join(' '), /running npm test · 3m/)
  const quiet = live('working', { outputAt: now - 480_000 })
  assert.match(textOf(workerView(quiet, quiet.workers[0])).join(' '), /no output · 8m/)
  const blocked = live('blocked', running)
  assert.doesNotMatch(textOf(panelView(blocked)).join(' '), /running npm test/)
  assert.doesNotMatch(textOf(workerView(blocked, blocked.workers[0])).join(' '), /running npm test/)
})

test('a quiet orchestrator says so in the head, and Interrupt goes straight to hc', async () => {
  const NOW = 10_000_000
  const termsBefore = app.terminals
  app.terminals = [{ address: COORD, status: 'working' }]
  const quiet = board({ coordinator: { terminal: COORD, outputAt: NOW - 8 * 60_000 } })
  const tree = panelView(quiet, NOW)
  assert.ok(textOf(tree).includes('no output · 8m'))
  findId(tree, 'panel-interrupt').node.calls.on_mouse_down[1](null, { stop_propagation() {} })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(hcCalls, [['interrupt', COORD]])

  // Not quiet, and not mid-turn: no button.
  assert.equal(findId(panelView(board({ coordinator: { terminal: COORD, outputAt: NOW } }), NOW), 'panel-interrupt'), null)
  app.terminals = [{ address: COORD, status: 'idle' }]
  assert.equal(findId(panelView(quiet, NOW), 'panel-interrupt'), null)
  app.terminals = termsBefore
})

test("a working worker's view offers Interrupt with its line, through its board", async () => {
  const now = Date.now()
  const live = { name: 'fix-1', state: 'working', command: 'npm test', commandAt: now - 60_000, outputAt: now }
  const sent = () => Object.values(app.files).filter(v => String(v).includes('"action":"interrupt"'))
  const tree = workerView(board(), live)
  assert.ok(textOf(tree).includes('running npm test · 1m'))
  findId(tree, 'panel-interrupt').node.calls.on_mouse_down[1](null, { stop_propagation() {} })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(sent(), [JSON.stringify({ action: 'interrupt', worker: 'fix-1' })])

  // No line, or done with its turn: nothing to interrupt.
  assert.equal(findId(workerView(board(), { name: 'fix-1', state: 'working' }), 'panel-interrupt'), null)
  assert.equal(findId(workerView(board(), { ...live, state: 'waiting' }), 'panel-interrupt'), null)
})

test('a PR in conflict with no worker on it goes to Needs a look; with one, its row says so', () => {
  const b = board({
    workers: [
      { name: 'w1', state: 'working' },
      { name: 'w2', state: 'reported' },
    ],
    tasks: [
      task('busy', { tab: 'w1', conflictsWith: 'main' }),
      task('left', { tab: 'w2', workers: ['w2'], conflictsWith: 'main', isFinished: true }),
      task('none', { conflictsWith: 'develop' }),
      task('fine'),
    ],
  })
  const s = m.panelSections(b)
  assert.deepEqual(
    s.look.map(r => [r.key, r.unattended]),
    [
      ['left', 'conflicts with main · no worker on it'],
      ['none', 'conflicts with develop · no worker on it'],
    ],
  )
  assert.deepEqual(
    s.work.map(r => r.key),
    ['busy', 'fine'],
  )
  const text = textOf(panelView(b))
  assert.ok(text.includes('Needs a look · 2'))
  assert.ok(text.includes('conflicts with main · no worker on it'))
  assert.ok(text.includes('conflicts with main'))
})

test('a blocked worker on a PR in conflict stays one row, saying it is blocked', () => {
  const b = board({
    workers: [{ name: 'w1', state: 'blocked', note: 'permission prompt' }],
    tasks: [task('a', { tab: 'w1', conflictsWith: 'main' })],
  })
  const [row, ...rest] = m.panelSections(b).look
  assert.equal(row.blocked, 'permission prompt')
  assert.equal(row.unattended, undefined)
  assert.deepEqual(rest, [])
})

test('shared files read as the design has them, on the row and in the worker view', () => {
  const b = board({
    workers: [{ name: 'w1', state: 'working' }],
    tasks: [
      task('one', { tab: 'w1', workers: ['w1'], shares: [{ pr: 215, file: 'app/mods/pin-panel.ts', count: 1 }] }),
      task('more', {
        conflictsWith: null,
        tab: 'w1',
        shares: [
          { pr: 213, file: 'a/b.ts', count: 3 },
          { pr: 216, file: 'c.ts', count: 1 },
        ],
      }),
      task('old'),
    ],
  })
  const rows = m.panelSections(b).work
  assert.equal(rows[0].shares, 'touches pin-panel.ts like #215')
  assert.equal(rows[1].shares, 'touches b.ts +2 like #213, #216')
  assert.equal(rows[2].shares, '')
  assert.ok(textOf(panelView(b)).includes('touches pin-panel.ts like #215'))
  assert.ok(textOf(workerView(b, { name: 'w1', state: 'working' })).includes('touches pin-panel.ts like #215'))
})

const FAIL = {
  job: 'test',
  url: 'https://github.com/o/r/actions/runs/7',
  seconds: 185,
  failed: 3,
  passed: 46,
  tests: ['a > one', 'a > two'],
  more: 1,
}

test('a failed CI reads as the design has it on the row and in the worker view', () => {
  const b = board({ tasks: [task('one', { tab: 'fix-1', workers: ['fix-1'], ciFailure: FAIL }), task('old')] })
  const [one, old] = m.panelSections(b).work
  assert.equal(one.ciFailure.summary, 'CI failed · 3 tests')
  assert.equal(old.ciFailure, null)
  const row = textOf(panelView(b))
  assert.ok(row.includes('CI failed · 3 tests ↗'))
  const view = workerView(b, { name: 'fix-1', state: 'working' })
  const text = textOf(view)
  for (const line of ['3 failed · 46 passed', 'test · 3m 5s', 'a > one', '+2 more failing tests', 'Open log ↗'])
    assert.ok(text.includes(line), line)
  assert.ok(!text.includes('a > two'))
  assert.ok(findId(view, 'panel-ci-log-one'))
  assert.ok(findId(panelView(b), 'panel-ci-one'))
})

test('two failures, both named, still say there is one more than the first shown', () => {
  const ci = { job: 'test', url: null, seconds: null, failed: 2, passed: 1, tests: ['a > one', 'a > two'], more: 0 }
  const b = board({ tasks: [task('one', { tab: 'fix-1', ciFailure: ci })] })
  const text = textOf(workerView(b, { name: 'fix-1', state: 'working' }))
  assert.ok(text.includes('a > one'))
  assert.ok(text.includes('+1 more failing test'))
  assert.ok(!text.includes('+1 more failing tests'))
})

test('a failed CI with less on the board says less, and one without a run has no link', () => {
  const b = board({
    tasks: [
      task('one', {
        tab: 'fix-1',
        ciFailure: { job: 'build', url: null, seconds: null, failed: null, passed: null, tests: ['t'], more: 0 },
      }),
    ],
  })
  const f = m.panelSections(b).work[0].ciFailure
  assert.deepEqual(f, {
    summary: 'CI failed · 1 test',
    url: null,
    counts: '1 failed',
    job: 'build',
    first: 't',
    more: '',
  })
  assert.ok(textOf(panelView(b)).includes('CI failed · 1 test'))
  assert.ok(!textOf(panelView(b)).includes('↗'))
  assert.equal(findId(workerView(b, { name: 'fix-1', state: 'working' }), 'panel-ci-log-one'), null)
  const bare = m.panelSections(board({ tasks: [task('x', { ciFailure: { job: 'build', tests: [], more: 0 } })] })).work[0].ciFailure
  assert.equal(bare.summary, 'CI failed')
})

test('pressing the failed CI opens its run, and the press stops there', () => {
  const b = board({ tasks: [task('one', { ciFailure: FAIL })] })
  app.execs.length = 0
  let stopped = false
  findId(panelView(b), 'panel-ci-one').node.calls.on_mouse_down[1](null, { stop_propagation: () => (stopped = true) })
  assert.deepEqual(app.execs, [['open', FAIL.url]])
  assert.ok(stopped)
})
