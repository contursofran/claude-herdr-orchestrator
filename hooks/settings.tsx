import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { SettingsView } from '../types'
import type { BandRender } from './band'
import { refresh } from './board'
import { allProfiles, BUILT_IN, customized, OPTIONAL, readJson, userConfigPath } from './config'
import { CLOSE_IDLE_MINUTES, PREFIX, PRUNE_MINUTES, RESET_AT, TARGET } from './defaults'
import { tilde } from './format'
import { session } from './session'
import { sideOpen, toggleSide } from './side'

// /hrd-config: the settings, listed on the band above the prompt as /config lists
// its own. Enter flips a switch, steps a choice (›) or opens a field; each change
// is written to the user's or the folder's herdr-agents.json at once.

const settingsView = atom(
  { plugin: 'herdr-agents', key: 'settings' } as const,
  {
    scope: 'user',
    paths: { user: '', folder: '' },
    home: '',
    user: {},
    folder: {},
    profiles: [],
  } as SettingsView,
)

export async function settingsOpen($: EngineInterface) {
  return (await read($, settingsView)).isOpen === true
}

// The settings pane's values for a picker that writes nothing, or `null`.
export const INHERIT = '*inherit'

export const NONE = '*none'

export const EDIT = 'cfg-edit'

// One row of the settings pane. `text` rows open a field, `switch` and `choice` rows
// change on Enter, `fixed` rows only show. `raw` is what this file holds; `value`
// what is in effect, `isDefault` when no file sets it.
export type SettingRow = {
  key: string
  label: string
  kind: 'text' | 'switch' | 'choice' | 'fixed'
  value: string
  raw: string
  isDefault: boolean
  hint: string
  detail?: string
}

// The settings typed into a field, with their label, default, unit and hint.
type TextSetting = 'target' | 'resetAt' | 'statePath' | 'pruneMinutes' | 'closeIdleMinutes' | 'commandPrefix'

export const TEXT_SETTINGS: [key: TextSetting, label: string, initial: unknown, unit: string, hint: string][] = [
  ['target', 'Workers to keep busy', TARGET, '', 'How many workers the coordinator keeps running.'],
  [
    'resetAt',
    'Compact the coordinator past',
    RESET_AT,
    ' tokens',
    'Past this much context the coordinator saves its state and is compacted.',
  ],
  ['statePath', 'State file', 'COORDINATOR-STATE.md', '', "The coordinator's notes: relative to the folder, absolute, or ~/…."],
  [
    'pruneMinutes',
    'Prune merged worktrees every',
    PRUNE_MINUTES,
    ' min',
    'How often merged worktrees are removed; 0 turns it off. New sessions.',
  ],
  [
    'closeIdleMinutes',
    'Close idle worker tabs after',
    CLOSE_IDLE_MINUTES,
    ' min',
    "A reported worker's tab closes once idle this long; 0 keeps it. New sessions.",
  ],
  ['commandPrefix', 'Command prefix', PREFIX, '', 'What every command starts with. New sessions.'],
]

export const NUMBERS: Record<string, number> = { target: 1, resetAt: 10_000, pruneMinutes: 0, closeIdleMinutes: 0 }

export async function loadSettings($: EngineInterface, note?: string, error?: string) {
  const paths = { user: await userConfigPath($), folder: `${session.cwd}/.claude/herdr-agents.json` }
  const user = await readJson($, paths.user)
  const folder = await readJson($, paths.folder)
  const home = (await $.env.get('HOME')) ?? ''
  const all = await allProfiles($)
  const old = await read($, settingsView)
  const scope = old.paths.user ? old.scope : (await $.fs.exists(paths.folder)) ? 'folder' : 'user'
  await update($, settingsView, p => ({
    ...p,
    scope,
    paths,
    home,
    user,
    folder,
    profiles: Object.entries(all).map(([name, p]) => ({
      name,
      note: p.note ?? p.kind,
      builtIn: BUILT_IN.includes(name),
      customized: customized(name, p),
    })),
    note,
    error,
  }))
}

export function settingRows(pane: SettingsView): SettingRow[] {
  const mine = pane[pane.scope]
  const merged = { ...pane.user, ...pane.folder }
  // Where a value this file leaves out comes from.
  const source = (key: TextSetting) => (pane.scope === 'folder' && pane.user[key] !== undefined ? ' (all folders)' : ' (default)')
  const off: string[] = merged.disable ?? []
  const small = mine.smallTasks !== undefined ? mine.smallTasks : merged.smallTasks
  const builtIn = (name: string): SettingRow => {
    const p = pane.profiles.find(x => x.name === name)
    const detail = `${p?.note ?? ''}${p?.customized ? ' · customized' : ''}`
    if (!OPTIONAL.includes(name))
      return {
        key: `cfg-off-${name}`,
        label: `${name[0]!.toUpperCase()}${name.slice(1)}`,
        kind: 'fixed',
        value: 'always on',
        raw: '',
        isDefault: true,
        hint: '',
      }
    return {
      key: `cfg-off-${name}`,
      label: `${name[0]!.toUpperCase()}${name.slice(1)}`,
      kind: 'switch',
      value: off.includes(name) ? 'off' : 'on',
      raw: '',
      isDefault: !off.includes(name),
      detail,
      hint: {
        planner: 'Plans each issue first. Off: the builder plans before it builds.',
        reviewer: 'Reviews each PR. Off: the coordinator reviews the diff and checks itself.',
        debugger: 'Takes over after two failed fix rounds. Off: the coordinator asks you.',
      }[name]!,
    }
  }
  return [
    {
      key: 'cfg-scope',
      label: 'Edit settings for',
      kind: 'choice',
      value: pane.scope === 'user' ? 'all folders' : 'this folder',
      raw: '',
      isDefault: false,
      detail: tilde(pane.paths[pane.scope], pane.home),
      hint: "Which file the changes go to. This folder's file overrides the one for all folders.",
    },
    ...TEXT_SETTINGS.map(
      ([key, label, initial, unit, hint]): SettingRow => ({
        key: `cfg-${key}`,
        label,
        kind: 'text',
        value: mine[key] !== undefined ? `${mine[key]}${unit}` : `${merged[key] ?? initial}${unit}${source(key)}`,
        raw: mine[key] === undefined ? '' : String(mine[key]),
        isDefault: mine[key] === undefined,
        hint,
      }),
    ),
    {
      key: 'cfg-wrapUp',
      label: 'Wrap up',
      kind: 'switch',
      value: mine.wrapUp === true ? 'on' : 'off',
      raw: '',
      isDefault: mine.wrapUp !== true,
      hint: 'On: no new workers start, the running ones finish. In the all-folders file it holds every coordinator.',
    },
    {
      key: 'cfg-view',
      label: 'Show workers in',
      kind: 'choice',
      value: (mine.view ?? merged.view) === 'side' ? 'the sidebar' : 'the band',
      raw: '',
      isDefault: mine.view === undefined,
      hint: 'The band above the prompt or the sidebar beside the chat; only one shows. /hrd-side switches for this session.',
    },
    builtIn('planner'),
    builtIn('builder'),
    builtIn('reviewer'),
    builtIn('debugger'),
    {
      key: 'cfg-smallTasks',
      label: 'Small tasks go to',
      kind: 'choice',
      value: small ? small : 'nobody',
      raw: '',
      isDefault: mine.smallTasks === undefined,
      hint: 'A profile the coordinator may give small, well-defined tasks.',
    },
  ]
}

export async function pressRow($: EngineInterface, key: string) {
  const pane = await read($, settingsView)
  const row = settingRows(pane).find(r => r.key === key)
  if (!row) return
  if (row.kind === 'text') {
    await update($, settingsView, p => ({ ...p, editing: key, note: undefined, error: undefined }))
    await $.ui.focus({ requestId: session.bandId, key: EDIT }).catch(() => {})
  } else if (key === 'cfg-scope') {
    await update($, settingsView, p => ({
      ...p,
      scope: p.scope === 'user' ? ('folder' as const) : ('user' as const),
      note: undefined,
      error: undefined,
    }))
  } else if (key === 'cfg-wrapUp') {
    await saveSetting($, 'wrapUp', row.value === 'on' ? '' : 'true')
  } else if (key === 'cfg-view') {
    await saveView($, row.value === 'the sidebar' ? 'band' : 'side')
  } else if (key === 'cfg-smallTasks') {
    // Steps through nobody and each profile that is on.
    const merged = { ...pane.user, ...pane.folder }
    const off: string[] = merged.disable ?? []
    const choices = [NONE, ...pane.profiles.filter(p => !off.includes(p.name)).map(p => p.name)]
    const now = row.value === 'nobody' ? NONE : row.value
    await saveSmallTasks($, choices[(choices.indexOf(now) + 1) % choices.length]!)
  } else if (key.startsWith('cfg-off-')) {
    await toggleOff($, key.slice('cfg-off-'.length))
  }
}

export async function closeSettings($: EngineInterface) {
  await update($, settingsView, p => ({ ...p, isOpen: false, focused: undefined, editing: undefined, note: undefined, error: undefined }))
}

export async function editDone($: EngineInterface, key: string, value: string) {
  await update($, settingsView, p => ({ ...p, editing: undefined }))
  await saveSetting($, key.slice('cfg-'.length), value)
  await $.ui.focus({ requestId: session.bandId, key }).catch(() => {})
}

// Reads the file the pane edits, changes it with `fn` and writes it back. A file that is
// not valid JSON is left alone, so a hand edit in progress is never overwritten.
export async function editConfig($: EngineInterface, fn: (c: Record<string, unknown>) => string) {
  const { scope, paths } = await read($, settingsView)
  const path = paths[scope]
  let c: Record<string, unknown> = {}
  if (await $.fs.exists(path)) {
    try {
      c = JSON.parse(await $.fs.read(path))
    } catch {
      return loadSettings($, undefined, `${path} is not valid JSON; fix it by hand first.`)
    }
  }
  const note = fn(c)
  await $.fs.write(path, `${JSON.stringify(c, null, 2)}\n`)
  await loadSettings($, `${note} in ${path}.`)
  void refresh($)
}

export async function saveSetting($: EngineInterface, key: string, raw: string) {
  const text = raw.trim()
  let value: unknown = text
  if (text && key in NUMBERS) {
    value = Number(text)
    if (!Number.isInteger(value) || (value as number) < NUMBERS[key]!)
      return loadSettings($, undefined, `${key} must be a whole number of at least ${NUMBERS[key]}.`)
  }
  if (text && key === 'commandPrefix' && !/^[a-z0-9_-]{0,20}$/.test(text))
    return loadSettings($, undefined, 'commandPrefix takes up to 20 lowercase letters, digits, _ and -.')
  if (key === 'wrapUp') value = text === 'true'
  await editConfig($, c => {
    if (!text || value === false) {
      delete c[key]
      return `Removed ${key}`
    }
    c[key] = value
    return `Saved ${key} = ${text}`
  })
}

export async function saveSmallTasks($: EngineInterface, value: string) {
  const { scope } = await read($, settingsView)
  await editConfig($, c => {
    // Nobody is the default for all folders; a folder writes null to override theirs.
    if (value === INHERIT || (value === NONE && scope === 'user')) delete c.smallTasks
    else c.smallTasks = value === NONE ? null : value
    return value === INHERIT ? 'Removed smallTasks' : `Saved smallTasks = ${value === NONE ? 'nobody' : value}`
  })
}

// Saves where the workers show and shows them there now. The band is the default for all
// folders; a folder writes it to override theirs.
export async function saveView($: EngineInterface, view: 'band' | 'side') {
  const { scope } = await read($, settingsView)
  await editConfig($, c => {
    if (view === 'band' && scope === 'user') delete c.view
    else c.view = view
    return `Saved view = ${view}`
  })
  if ((view === 'side') !== (await sideOpen($))) await toggleSide($)
}

// Turns a built-in profile off or on in the file the pane edits. A folder file without
// `disable` starts from the one for all folders, since its own replaces that one.
export async function toggleOff($: EngineInterface, name: string) {
  const pane = await read($, settingsView)
  const base: string[] = pane[pane.scope].disable ?? (pane.scope === 'folder' ? pane.user.disable : undefined) ?? []
  const isOff = base.includes(name)
  const next = isOff ? base.filter(n => n !== name) : [...base, name]
  await editConfig($, c => {
    if (next.length || (pane.scope === 'folder' && pane.user.disable?.length)) c.disable = next
    else delete c.disable
    return `Turned ${name} ${isOff ? 'on' : 'off'}`
  })
}

export async function openSettings($: EngineInterface) {
  await loadSettings($)
  await update($, settingsView, p => ({ ...p, isOpen: true, focused: undefined, editing: undefined }))
}

// The band's focus ring: while the settings show, ❯ marks the row it is on.
export async function trackFocus($: EngineInterface, element: string | undefined) {
  if ((await read($, settingsView)).isOpen)
    await update($, settingsView, p => ({ ...p, focused: element, editing: element === EDIT ? p.editing : undefined }))
}

// The settings drawn on the band, or undefined while they are closed (or on the mobile
// app, which draws no fields yet).
export async function drawSettings($: EngineInterface, e: BandRender) {
  const settings = await read($, settingsView)
  if (settings.isOpen && !e.props.hasSurvey && e.surface !== 'mobile') {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const list = settingRows(settings)
    const focused = list.find(r => r.key === settings.focused)
    const width = Math.max(...list.map(r => r.label.length)) + 4
    const hint = focused
      ? [focused.hint, focused.detail].filter(Boolean).join('  ·  ')
      : tilde(settings.paths[settings.scope], settings.home)
    return (
      <Box flexDirection="column">
        {list.map(row =>
          row.key === settings.editing ? (
            <Input
              key={EDIT}
              label={`❯ ${row.label.padEnd(width)}`}
              value={row.raw}
              placeholder={row.value}
              submitLabel="save"
              onSubmit={(value: string) => void editDone($, row.key, value)}
            />
          ) : row.kind === 'fixed' ? (
            <Text dimColor>{`  ${row.label.padEnd(width)}${row.value}`}</Text>
          ) : (
            <Button key={row.key} plain onPress={() => void pressRow($, row.key)}>
              {`${settings.focused === row.key ? '❯' : ' '} ${row.label.padEnd(width)}`}
              <Text dimColor={row.isDefault}>{row.value}</Text>
              {row.kind === 'choice' ? <Text dimColor>{' ›'}</Text> : null}
            </Button>
          ),
        )}
        <Text> </Text>
        {/* One line whatever the row's hint, so moving through the rows never
            changes the band's height. */}
        <Text dimColor wrap="truncate-end">{`  ${hint}`}</Text>
        {settings.error ? (
          <Text color="error">{`  ${settings.error}`}</Text>
        ) : settings.note ? (
          <Text color="success">{`  ${settings.note}`}</Text>
        ) : null}
        {/* Done comes first: the keys after it change with the focus, and a click
            focuses before it presses, so a Done after them would move away under it. */}
        <Box columnGap={2} paddingLeft={2}>
          <Button key="cfg-done" plain role="dismiss" onPress={() => void closeSettings($)}>
            Done
          </Button>
          <Text dimColor wrap="truncate-end">
            {settings.editing
              ? 'Enter to save · empty for the default · ↑↓ to leave it'
              : `${settings.focused ? '' : 'alt+d to enter · '}Enter to change · ↑↓ to move · Esc back to the prompt`}
          </Text>
        </Box>
      </Box>
    )
  }
}
