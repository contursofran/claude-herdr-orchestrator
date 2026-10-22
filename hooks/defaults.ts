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

// A worker's name: also its herdr tab's label.
export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
// A report longer than this goes to the coordinator as its first line and its file's path.
export const INLINE_LINES = 6
export const INLINE_CHARS = 700
// How long a worker may sit with an unchanged screen, not working and without
// RESULT.md, before it is reported as stopped.
export const QUIET_MS = 5 * 60_000
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

// Keys in $.store, which every session on the machine shares.
export const STATE_OWNER = 'stateOwner'
export const WRAP_UP = 'wrapUp'
