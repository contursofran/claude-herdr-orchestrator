// Defaults and tuning values in one place. The first group are the defaults of the
// settings in herdr-agents.json (see config.ts); the rest are the mod's own.

// Workers the coordinator keeps busy (`target`).
export const TARGET = 4
// Context tokens past which the coordinator saves its state and is compacted (`resetAt`).
export const RESET_AT = 250_000
// What every slash command starts with (`commandPrefix`).
export const PREFIX = 'hrd-'
// How often merged worktrees are pruned (`pruneMinutes`); 0 turns it off.
export const PRUNE_MINUTES = 30
// How long a reported worker's tab may sit idle before it is closed (`closeIdleMinutes`); 0 keeps it.
export const CLOSE_IDLE_MINUTES = 30

// A worker's name: also its hc terminal's name (hc takes 32 characters at most) and its tab's label.
export const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
// hc reads a name shaped like a terminal's address (t7, t1b) as that address, so workers cannot have one.
export const ADDRESS_LIKE = /^t\d[0-9a-z]*$/
// A report without a header (see report.ts) longer than this goes to the coordinator as its first line and its file's path.
export const INLINE_LINES = 6
export const INLINE_CHARS = 700
// A report's header (see report.ts): the lines it may start within, and the summary's size.
export const HEADER_SCAN_LINES = 12
export const SUMMARY_LINES = 3
export const SUMMARY_LINE_CHARS = 240
// A follow-up to a worker up to this long is typed into its prompt as well as saved to a file.
export const MESSAGE_CHARS = 4000
// How long a worker may sit with an unchanged screen, not working and without
// RESULT.md, before it is reported as stopped.
export const QUIET_MS = 5 * 60_000
// The same for a worker whose status lines show background work of its own (a shell,
// a monitor, a subagent): a dev server it left running must not hide it for good.
export const QUIET_BUSY_MS = 60 * 60_000
// How often a prompt is sent or submitted again when hc sees no work start after it.
export const PROMPT_TRIES = 3
// How long a prompt gets to start work before it is submitted or typed again. Longer than the 56 s a
// Claude session has been seen to sit on a first prompt while it starts.
export const PROMPT_WAIT_MS = 90_000
// The most a prompt's delivery may take in all, however slow hc is: 3 tries of 90 s, and room for the calls between.
export const SEND_DEADLINE_MS = 6 * 60_000
// How often hc is asked whether that work started.
export const PROMPT_CHECK_MS = 5000
// How often the sweep reads hc for every running worker at once (one `hc ls`).
export const SWEEP_MS = 60_000
// How many sweeps in a row must miss a worker's tab before it is reported gone: one failed
// or late list does not end a job.
export const GONE_MISSES = 2
// How long a prompt that never arrived waits before its worker is reported blocked.
export const LOST_REPORT_MS = 10_000
// Prompts for the coordinator (reports, owner answers) wait this long after the last one,
// and after its turn ends, so the ones that arrive together go out as one prompt (see outbox.ts).
export const BATCH_MS = 3000
// The coordinator's tick: report check, band, sidebar and inbox.
export const TICK_MS = 3000
// How long a reported worker stays on the band.
export const LINGER_MS = 60_000

// How long a settled decision stays on the band.
export const SETTLED_MS = 10 * 60_000
// How long a worker's question waits for the coordinator before the person is pinged anyway.
export const QUIET_MAX_MS = 3 * 60_000

// If the coordinator hasn't saved its state this long after being asked, compact anyway.
export const SAVE_WAIT_MS = 10 * 60_000

// The band: to-dos shown (the decisions command lists the rest), worker lines in the
// compact view (Details shows them all), and the narrowest worker column; a band at
// least twice as wide shows two workers per line.
export const TODO_ROWS = 6
export const WORKER_LINES = 2
export const WORKER_CELL = 56

// The sidebar (/hrd-side): the width it asks for when docked, its fixed rows (work
// table, needs-you list, the answer box), how long a finished task still shows when it
// first appears, and how often it reads the GitHub state of the PRs it lists.
export const SIDE_COLUMNS = 64
export const SIDE_WORK_ROWS = 8
export const SIDE_NEED_ROWS = 6
export const SIDE_BOX_ROWS = 8
export const SIDE_RECENT_MS = 3 * 60 * 60_000
export const PR_POLL_MS = 2 * 60_000

// Keys in $.store, which every session on the machine shares.
export const STATE_OWNER = 'stateOwner'
export const WRAP_UP = 'wrapUp'
// A session's jobs, under this prefix and its id (see state.ts), kept this long after their last change.
export const JOBS_PREFIX = 'jobs:'
export const JOBS_KEEP_MS = 3 * 24 * 60 * 60_000
// A reported job is dropped from the state this long after it ended (see dropOldJobs).
export const JOBS_DROP_MS = 7 * 24 * 60 * 60_000
// The outbox's copy in $.store (see outbox.ts), under this prefix and the session's id.
export const OUTBOX_PREFIX = 'outbox:'

// The board for apps outside Claude Code (see bridge.ts), under the home folder, and how
// many of their last actions the snapshot reports.
export const BRIDGE_DIR = '.herdr-agents/board'
// The app mod's heartbeat file (under HOME), and how old it may be while the band still steps aside.
export const APP_MOD_FILE = '.herdr-agents/app-mod.json'
export const APP_MOD_FRESH_MS = 90_000
export const BRIDGE_ACTIONS_KEPT = 10
// With nothing else changed the board is still written this often: `at` tells a live board from a leftover, and a deleted file comes back.
export const BRIDGE_REWRITE_MS = 60_000

// The block of the state file the mod keeps current (see stateblock.ts): how many recent reports it
// lists, and the markers that fence it.
export const RECENT_REPORTS = 8
export const AUTO_START = '<!-- hrd:auto -->'
export const AUTO_END = '<!-- /hrd:auto -->'

// Where each delivered report is also copied, under HOME, so the metrics outlive a pruned worktree.
export const REPORTS_DIR = '.herdr-agents/reports'

// The PR pipeline's defaults (`pipeline` in herdr-agents.json, see pipelineSettings in config.ts).
export const PIPE_ROUNDS = 3
export const PIPE_RESCUE_AFTER = 2
export const PIPE_CI_EVERY_MINUTES = 2
export const PIPE_CI_MAX_MINUTES = 60
export const PIPE_NO_CI_MINUTES = 10
export const PIPE_PAUSE_MINUTES = 30
export const PIPE_MAX_SPAWNS = 8
// Lines kept in a pipe's log.
export const PIPE_LOG_KEPT = 40
