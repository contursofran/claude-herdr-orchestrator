// Defaults and tuning values in one place. The first group are the defaults of the
// settings in herdr-agents.json (see config.ts); the rest are the mod's own.

// Workers the coordinator keeps busy (`target`).
export const TARGET = 4
// Context tokens past which the coordinator saves its state and is compacted (`resetAt`).
export const RESET_AT = 200_000
// What every slash command starts with (`commandPrefix`).
export const PREFIX = 'hrd-'
// How often merged worktrees are pruned (`pruneMinutes`); 0 turns it off.
export const PRUNE_MINUTES = 30
// How long a reported worker's tab may sit idle before it is closed (`closeIdleMinutes`); 0 keeps it.
export const CLOSE_IDLE_MINUTES = 30

// A worker's name: also its herdr tab's label.
export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
// A report longer than this goes to the coordinator as its first line and its file's path.
export const INLINE_LINES = 6
export const INLINE_CHARS = 700
// A follow-up to a worker up to this long is typed into its prompt as well as saved to a file.
export const MESSAGE_CHARS = 4000
// How long a worker may sit with an unchanged screen, not working and without
// RESULT.md, before it is reported as stopped.
export const QUIET_MS = 5 * 60_000
// The same for a worker whose status lines show background work of its own (a shell,
// a monitor, a subagent): a dev server it left running must not hide it for good.
export const QUIET_BUSY_MS = 60 * 60_000
// How often a prompt is sent or submitted again when herdr sees no work start after it.
export const PROMPT_TRIES = 3
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
