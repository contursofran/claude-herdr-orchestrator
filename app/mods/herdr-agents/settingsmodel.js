// What the settings dialog shows and how a change edits herdr-agents.json. No drawing and no files here. The rules match
// /hrd-config (hooks/settings.tsx), which stays for people without the app, and both edit the same files.

export const TEXT_SETTINGS = [
  { key: 'target', label: 'Workers to keep busy', initial: 4, unit: '', min: 1, hint: 'How many workers the coordinator keeps running.' },
  {
    key: 'resetAt',
    label: 'Compact the coordinator past',
    initial: 250000,
    unit: ' tokens',
    min: 10000,
    hint: 'Past this much context the coordinator saves its state and is compacted.',
  },
  {
    key: 'statePath',
    label: 'State file',
    initial: 'COORDINATOR-STATE.md',
    unit: '',
    hint: "The coordinator's notes: relative to the folder, absolute, or ~/….",
  },
  {
    key: 'pruneMinutes',
    label: 'Prune merged worktrees every',
    initial: 30,
    unit: ' min',
    min: 0,
    hint: 'How often merged worktrees are removed; 0 turns it off. New sessions.',
  },
  {
    key: 'closeIdleMinutes',
    label: 'Close idle worker tabs after',
    initial: 30,
    unit: ' min',
    min: 0,
    hint: "A reported worker's tab closes once idle this long; 0 keeps it. New sessions.",
  },
  { key: 'commandPrefix', label: 'Command prefix', initial: 'hrd-', unit: '', hint: 'What every command starts with. New sessions.' },
]

const OPTIONAL = {
  planner: 'Plans work that needs several PRs or an open approach. Off: the builder plans all of it.',
  reviewer: 'Reviews each PR. Off: the coordinator reviews the diff and checks itself.',
  debugger: 'Takes over after two failed fix rounds. Off: the coordinator asks you.',
}
const BUILT_IN = ['planner', 'builder', 'reviewer', 'debugger']
const NOBODY = 'nobody'

const title = name => `${name[0].toUpperCase()}${name.slice(1)}`
const disabled = c => (Array.isArray(c.disable) ? c.disable : [])

/** The file the dialog edits now. */
export const mine = pane => pane[pane.scope] ?? {}

/** What is in effect: the folder's file over the one for all folders. */
export const merged = pane => ({ ...pane.user, ...(pane.folder ?? {}) })

/** Who small tasks can go to: nobody, then each profile that is on. */
export function smallTaskChoices(pane) {
  const all = merged(pane)
  const named = Object.keys({ ...pane.user?.profiles, ...pane.folder?.profiles })
  const off = disabled(all)
  return [NOBODY, ...new Set([...BUILT_IN, ...named])].filter(name => !off.includes(name))
}

/** One row per setting. `kind`: text is a field, switch and choice change on a press, fixed only shows. */
export function settingRows(pane) {
  const file = mine(pane)
  const all = merged(pane)
  const inherited = key => (pane.scope === 'folder' && pane.user?.[key] !== undefined ? 'all folders' : 'default')
  const small = file.smallTasks !== undefined ? file.smallTasks : all.smallTasks
  return [
    ...TEXT_SETTINGS.map(s => ({
      key: s.key,
      label: s.label,
      kind: 'text',
      hint: s.hint,
      raw: file[s.key] === undefined ? '' : String(file[s.key]),
      inEffect: file[s.key] === undefined ? `${all[s.key] ?? s.initial}${s.unit} (${inherited(s.key)})` : null,
    })),
    {
      key: 'wrapUp',
      label: 'Wrap up',
      kind: 'switch',
      value: file.wrapUp === true,
      hint: 'On: no new workers start, the running ones finish. In the all-folders file it holds every coordinator.',
    },
    {
      key: 'view',
      label: 'Show workers in',
      kind: 'choice',
      value: (file.view ?? all.view) === 'side' ? 'the sidebar' : 'the band',
      hint: 'The band above the prompt or the sidebar beside the chat. New sessions; /hrd-side switches a running one.',
    },
    ...BUILT_IN.map(name =>
      OPTIONAL[name]
        ? { key: `off:${name}`, label: title(name), kind: 'switch', value: !disabled(all).includes(name), hint: OPTIONAL[name] }
        : { key: `off:${name}`, label: title(name), kind: 'fixed', value: 'always on', hint: 'Every issue needs one.' },
    ),
    {
      key: 'smallTasks',
      label: 'Small tasks go to',
      kind: 'choice',
      value: small || NOBODY,
      hint: 'A profile the coordinator may give small, well-defined tasks.',
    },
  ]
}

/** Checks a typed value. Returns the value to store, undefined to remove the key, or { error }. */
export function parseText(key, raw) {
  const text = String(raw).trim()
  if (!text) return undefined
  const setting = TEXT_SETTINGS.find(s => s.key === key)
  if (setting?.min !== undefined) {
    const n = Number(text)
    if (!Number.isInteger(n) || n < setting.min) return { error: `${setting.label} must be a whole number of at least ${setting.min}.` }
    return n
  }
  if (key === 'commandPrefix' && !/^[a-z0-9_-]{0,20}$/.test(text)) {
    return { error: 'Command prefix takes up to 20 lowercase letters, digits, _ and -.' }
  }
  return text
}

/** A typed value's change to the file `c`, in place. Returns { error } when it is refused. */
export function applyText(c, key, raw) {
  const value = parseText(key, raw)
  if (value?.error) return value
  if (value === undefined) delete c[key]
  else c[key] = value
  return null
}

/** A press on a switch or choice row, as a change to the file `c`, in place. `pane` says what it stands at now. */
export function applyPress(c, key, pane) {
  const scope = pane.scope
  if (key === 'wrapUp') {
    if (c.wrapUp === true) delete c.wrapUp
    else c.wrapUp = true
  } else if (key === 'view') {
    const next = (c.view ?? merged(pane).view) === 'side' ? 'band' : 'side'
    // The band is the default for all folders; a folder writes it to override theirs.
    if (next === 'band' && scope === 'user') delete c.view
    else c.view = next
  } else if (key === 'smallTasks') {
    const choices = smallTaskChoices(pane)
    const now = (c.smallTasks !== undefined ? c.smallTasks : merged(pane).smallTasks) || NOBODY
    const next = choices[(choices.indexOf(now) + 1) % choices.length]
    // Nobody is the default for all folders; a folder writes null to override theirs.
    if (next !== NOBODY) c.smallTasks = next
    else if (scope === 'user') delete c.smallTasks
    else c.smallTasks = null
  } else if (key.startsWith('off:')) {
    const name = key.slice('off:'.length)
    // A folder file without `disable` starts from the one for all folders, since its own replaces that one.
    const base = c.disable ?? (scope === 'folder' ? pane.user?.disable : undefined) ?? []
    const next = base.includes(name) ? base.filter(n => n !== name) : [...base, name]
    if (next.length || (scope === 'folder' && pane.user?.disable?.length)) c.disable = next
    else delete c.disable
  }
}

/** The text of a settings file: `{}` when absent, { error } when a hand edit left it broken, so it is never overwritten. */
export function parseFile(text) {
  if (text === null || text === undefined) return {}
  try {
    const c = JSON.parse(text)
    return c !== null && typeof c === 'object' && !Array.isArray(c) ? c : { error: 'is not a JSON object' }
  } catch {
    return { error: 'is not valid JSON' }
  }
}

export const fileText = c => `${JSON.stringify(c, null, 2)}\n`

/** Whether a mod command name means "open the settings" (`herdr-agents.settings`). */
export const isSettingsCommand = name => /(?:^|\.)settings$/.test(String(name))
