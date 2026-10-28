export type Job = {
  name: string
  profile: string
  cwd: string
  dir: string
  startedAt: number
  endedAt?: number
  // the current prompt's report token (see reportRule)
  token?: string
  // 'starting' while spawn's background start makes the tab and the CLI (no token yet); 'running' until
  // the worker settles; 'reported' once its report was delivered
  status: 'starting' | 'running' | 'reported'
  // the herdr tab and pane of the worker, set while it starts
  tab?: string
  pane?: string
  // message files held for a non-Claude worker until it reports
  queued?: string[]
  // the WAIT.json the worker is waiting on, read once (see waiting)
  wait?: Wait
  // set while a reported job's turn is not over, so it is still watched: 'early' = reported before its
  // turn ended; 'blocked' = reported as blocked (no RESULT.md), or blocked after an early report
  tail?: 'early' | 'blocked'
  // its tab was closed (stop, or closeIdle once it sat idle after its report)
  closed?: boolean
  // the brief's first line: the sidebar's task title (TASK.md changes with follow-ups)
  brief?: string
  // the issue and PR numbers it worked on: the brief's first #123, then the PR its reports link
  refs?: number[]
  // the PRs among them: a brief's "PR #123", a report's /pull/123
  prs?: number[]
  // the git branch checked out in `cwd` when the worker started (missing when git failed)
  branch?: string
  // the file deliver wrote for the last report (RESULT-<token>.md or SCREEN-<token>.txt), and its status
  reportFile?: string
  // also 'failed' (it did not start) and 'stopped' (stopped while it started)
  reportStatus?: string
}

// `every` and `max` in minutes; `lastAt` is when `check` last ran.
export type Wait = { for: string; check: string; every: number; max: number; since: number; lastAt?: number }

// A question only the person can answer, pinned on the band until `decided`.
// `options` are the answers offered as buttons; `recommended` indexes one.
// `title` is a 2-4 word name for the decision list.
// `quiet` while a worker's question waits for the coordinator before the person is pinged.
export type Decision = {
  id: number
  from: string
  question: string
  at: number
  title?: string
  options?: string[]
  recommended?: number
  quiet?: boolean
}

// A decision closed with `decided`, shown on the band for a while with its answer.
export type Settled = {
  id: number
  from: string
  question: string
  title?: string
  answer: string
  by: 'coordinator' | 'owner'
  at: number
}

// Something the person has to do (`do`: test a build, merge a PR) or should know (`know`),
// pinned at the top of the band until the coordinator unpins it or the person ticks it off.
export type Todo = { id: number; kind: 'do' | 'know'; text: string; from: string; at: number }

// A prompt for the coordinator held until its batch goes out (see outbox.ts). `report` marks a
// worker's report: a batch with one ends with the worker count.
export type OutboxItem = { text: string; report?: true }

// The band's open tab and, on the decisions tab, the decision shown.
// `workers: 'list'` (Details) shows every worker; compact shows the first few.
export type View = { tab: 'workers' | 'decisions'; selected: number | null; workers?: 'list' }

// One line of the band above the prompt; `state` is herdr's agent_status, or
// 'reported' once the report reached the session, 'waiting' while it waits on WAIT.json.
// `repo` is the GitHub repo (owner/name) of the worker's folder, for links.
export type Row = { name: string; profile: string; state: string; startedAt: number; endedAt?: number; note?: string; repo?: string }

// The GitHub repo (owner/name) of each folder this session and its workers used, from its git
// remotes, and `repos` from the config (short name -> owner/name): what a #123 links to.
export type Links = { byCwd: Record<string, string>; extra: Record<string, string> }

// `context` is this session's last measured context fill, shown on the band.
// `target` is how many workers the coordinator keeps running.
export type Board = { now: number; rows: Row[]; context?: { tokens: number; limit: number }; target?: number; wrapUp?: boolean }

// One line of the sidebar's needs-you list: a decision (D7) or a to-do (T12) as it was
// when it arrived, kept after it closes so its row stays in place until Clear done.
// `title` is its short name, `text` the question or the to-do in full.
export type SideItem = { key: string; kind: 'ask' | 'do' | 'know'; title: string; text: string; from: string; at: number }

// A PR's GitHub state as the sidebar last read it: `ci` sums its checks.
export type Pr = { state: 'OPEN' | 'MERGED' | 'CLOSED'; ci: 'pass' | 'fail' | 'pending' | 'none'; at: number }

// The sidebar (/hrd-side). Rows keep their slots: `items` and `tasks` (task keys) are in
// arrival order and only Clear done removes them. `answers` holds what the person answered
// in the sidebar; `cleared` the tasks Clear done removed, with their worker count then (a
// new worker brings one back). `pick` is the row the box at the bottom shows; `status` the
// one line under it; `prs` by owner/name#123.
export type SideView = {
  isOpen?: boolean
  pick?: { kind: 'item' | 'task'; key: string }
  items: SideItem[]
  tasks: string[]
  answers: Record<string, string>
  cleared: Record<string, number>
  status?: string
  prs: Record<string, Pr>
}

// The context reset in progress (see maybeReset): the coordinator was asked at
// `at` to save its state, and the mod compacts once it has.
export type Reset = { stage: 'saving'; at: number }

// A worker profile: the CLI herdr starts (`kind`), its flags, extra environment, and a
// short description for the spawn tool and the guides.
export type Profile = { kind: string; args: string[]; env?: Record<string, string>; note?: string }

// herdr-agents.json, the user's and a folder's. Every key is optional; see the README.
export type Settings = {
  target?: number
  resetAt?: number
  statePath?: string
  trustRoots?: string[]
  commandPrefix?: string
  profiles?: Record<string, Profile>
  disable?: string[]
  // null in a folder's file: nobody, over the user's choice
  smallTasks?: string | null
  playbook?: string | string[]
  pruneMinutes?: number
  closeIdleMinutes?: number
  repos?: Record<string, string>
  wrapUp?: boolean
  // where the workers and what needs the person show: the band above the prompt or the sidebar
  view?: 'band' | 'side'
}

// The settings list (/hrd-config), drawn on the band above the prompt: the two files as
// last read, which one changes go to (`user`: ~/.claude/herdr-agents.json, `folder`:
// <cwd>/.claude/herdr-agents.json), the profiles in effect, and the last save's note or error.
export type SettingsView = {
  isOpen?: boolean
  scope: 'user' | 'folder'
  paths: { user: string; folder: string }
  // $HOME, so the paths show as ~/...
  home: string
  user: Settings
  folder: Settings
  // `customized`: a built-in whose settings a file changes
  profiles: { name: string; note: string; builtIn: boolean; customized: boolean }[]
  // the row the focus ring is on, and the setting being typed into, if any
  focused?: string
  editing?: string
  note?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'herdr-agents': {
      jobs: Record<string, Job>
      board: Board
      reset: Reset | null
      decisions: Decision[]
      view: View
      settled: Settled[]
      lastId: number
      todos: Todo[]
      lastTodo: number
      outbox: OutboxItem[]
      links: Links
      orchestrating: boolean
      settings: SettingsView
      side: SideView
    }
  }
}
