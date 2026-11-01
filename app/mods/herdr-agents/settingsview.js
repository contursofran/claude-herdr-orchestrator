// The settings dialog. Its files are read when it opens and again after each
// save, and a write fails rather than replace a file that changed meanwhile (writeTextFile's `expected`).
import { Input, InputState } from 'gpui-base'
import { div, svg } from 'gpui-kit'
import { closeOverlay, exec, home, openOverlay, props, readTextFile, setShared, shared, writeTextFile } from 'herdr'
import { TEXT_SETTINGS, applyPress, applyText, fileText, parseFile, settingRows } from './settingsmodel.js'
import { card as look, color, font, icon } from './tokens.js'

export const SETTINGS_W = 620
export const SETTINGS_H = 0.8 // of the window

// CLAUDE_CONFIG_DIR reaches the plugin but not the app, so this is the default place only.
const userPath = () => `${home()}/.claude/herdr-agents.json`
const folderPath = folder => `${folder}/.claude/herdr-agents.json`
const dirOf = path => path.slice(0, path.lastIndexOf('/'))

/** Opens the dialog, replacing one already open; `folder` is the shown coordinator's, for its own file. Only the owner's click
 *  or key calls this. */
export function openSettings(folder) {
  try {
    if (shared('hrd.settings')) closeOverlay(shared('hrd.settings'))
  } catch {
    // already closed: Esc leaves the old id behind
  }
  const overlay = openOverlay({
    mod: 'herdr-agents',
    kind: 'dialog',
    width: SETTINGS_W,
    height: SETTINGS_H,
    props: { role: 'settings', folder: folder ?? null },
  })
  setShared('hrd.settings', overlay)
}

export class SettingsState {
  constructor(cx) {
    this.folder = props()?.folder ?? null
    this.pane = { scope: 'user', user: {}, folder: this.folder ? {} : undefined }
    this.texts = { user: null, folder: null }
    this.note = null
    this.error = null
    this.inputs = {}
    this.shown = {}
    for (const { key } of TEXT_SETTINGS) {
      const input = InputState.new({ value: '', placeholder: 'default' })
      input.on('submit', (_e, cx) => this.commit(key, cx))
      input.on('blur', (_e, cx) => this.commit(key, cx))
      this.inputs[key] = input
      this.shown[key] = ''
    }
    cx.spawn(async cx => this.load(cx))
  }

  path(scope = this.pane.scope) {
    return scope === 'user' ? userPath() : folderPath(this.folder)
  }

  async load(cx) {
    this.texts.user = await readTextFile(userPath())
    this.texts.folder = this.folder ? await readTextFile(folderPath(this.folder)) : null
    const user = parseFile(this.texts.user)
    const folder = this.folder ? parseFile(this.texts.folder) : undefined
    const broken = this.pane.scope === 'user' ? user.error : folder?.error
    this.pane = { ...this.pane, user: user.error ? {} : user, folder: folder?.error ? {} : folder }
    if (broken) this.error = `${this.path()} ${broken}. Fix it by hand first.`
    this.syncInputs()
    cx.notify()
  }

  /** Shows the file's values, except in a field that is mid-edit. */
  syncInputs() {
    for (const row of settingRows(this.pane)) {
      if (row.kind !== 'text') continue
      const input = this.inputs[row.key]
      if (input.value() === this.shown[row.key]) input.set_value(row.raw)
      this.shown[row.key] = row.raw
    }
  }

  setScope(scope, cx) {
    if (scope === this.pane.scope || (scope === 'folder' && !this.folder)) return
    this.pane = { ...this.pane, scope }
    this.note = null
    this.error = null
    for (const { key } of TEXT_SETTINGS) {
      this.inputs[key].set_value('')
      this.shown[key] = ''
    }
    cx.spawn(async cx => this.load(cx))
    cx.notify()
  }

  commit(key, cx) {
    const row = settingRows(this.pane).find(r => r.key === key)
    const typed = this.inputs[key].value()
    if (!row || typed.trim() === row.raw) return
    cx.spawn(async cx => this.edit(cx, c => applyText(c, key, typed), key))
  }

  press(key, cx) {
    cx.spawn(async cx => this.edit(cx, c => applyPress(c, key, this.pane), key))
  }

  /** Reads the file, changes it and writes it back. Refuses a broken file and one that changed since the read. */
  async edit(cx, change, key) {
    const path = this.path()
    try {
      const before = await readTextFile(path)
      const c = parseFile(before)
      if (c.error) throw new Error(`${path} ${c.error}. Fix it by hand first.`)
      const refused = change(c)
      if (refused?.error) {
        this.error = refused.error
        this.note = null
        return cx.notify()
      }
      await exec('mkdir', ['-p', dirOf(path)])
      await writeTextFile(path, fileText(c), before)
      this.note = `Saved to ${path}`
      this.error = null
    } catch (error) {
      this.error = `Not saved (${key}): ${error?.message ?? error}`
      this.note = null
    }
    await this.load(cx)
  }
}

const rowShell = (row, control) =>
  div()
    .id(`set-${row.key}`)
    .flex()
    .items_center()
    .justify_between()
    .gap(16)
    .py(8)
    .border_b(1)
    .border_color(look.keyBorder)
    .child(
      div()
        .flex_1()
        .min_w(0)
        .child(div().text_color(color.text).child(row.label))
        .child(div().mt(2).text_size(11).text_color(look.meta).child(row.hint))
        .when(Boolean(row.inEffect), el => el.child(div().mt(2).text_size(11).text_color(look.meta).child(`In effect: ${row.inEffect}`))),
    )
    .child(control)

const pressable = (id, text, on, onPress) =>
  div()
    .id(id)
    .flex_none()
    .h(26)
    .px(10)
    .flex()
    .items_center()
    .rounded(6)
    .border(1)
    .border_color(on ? color.text : look.border)
    .bg(on ? color.text : look.bg)
    .text_color(on ? color.chipText : color.text)
    .cursor_pointer()
    .hover(el => el.opacity(0.85))
    .on_mouse_down('left', onPress)
    .child(text)

function control(row, state, cx) {
  if (row.kind === 'text') {
    return div()
      .flex_none()
      .w(210)
      .h(28)
      .px(8)
      .flex()
      .items_center()
      .rounded(6)
      .border(1)
      .border_color(look.border)
      .child(Input.new(state.inputs[row.key]).flex_1().h_full().text_size(font.size).text_color(color.text))
  }
  if (row.kind === 'fixed') return div().flex_none().text_color(look.meta).child(row.value)
  const onPress = (_e, cx) => state.press(row.key, cx)
  if (row.kind === 'switch') return pressable(`set-${row.key}-btn`, row.value ? 'On' : 'Off', row.value, onPress)
  return pressable(`set-${row.key}-btn`, row.value, false, onPress)
}

const scopeTabs = (state, cx) =>
  div()
    .flex()
    .items_center()
    .gap(6)
    .child(pressable('set-scope-user', 'All folders', state.pane.scope === 'user', (_e, cx) => state.setScope('user', cx)))
    .when(Boolean(state.folder), el =>
      el.child(pressable('set-scope-folder', 'This folder', state.pane.scope === 'folder', (_e, cx) => state.setScope('folder', cx))),
    )

/** The dialog. Herdr draws its frame; Esc closes it. */
export function settingsView(state, cx) {
  const rows = settingRows(state.pane)
  return div()
    .id('settings')
    .size_full()
    .flex()
    .flex_col()
    .p(16)
    .gap(10)
    .bg(look.bg)
    .text_size(font.size)
    .text_color(color.text)
    .child(
      div()
        .flex()
        .items_center()
        .justify_between()
        .child(div().font_bold().child('Settings'))
        .child(
          div()
            .id('settings-close')
            .size(22)
            .flex()
            .items_center()
            .justify_center()
            .rounded(5)
            .cursor_pointer()
            .hover(el => el.bg(look.hover))
            .on_mouse_down('left', () => closeOverlay(props()?.overlay))
            .child(svg(icon('close')).size(12).text_color(look.meta)),
        ),
    )
    .child(scopeTabs(state, cx))
    .child(div().text_size(11).text_color(look.meta).truncate().child(state.path()))
    .child(
      div()
        .id('settings-rows')
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .children(rows.map(row => rowShell(row, control(row, state, cx)))),
    )
    .when(Boolean(state.error ?? state.note), el =>
      el.child(
        div()
          .id('settings-status')
          .text_size(11)
          .text_color(state.error ? color.text : look.meta)
          .child(state.error ?? state.note),
      ),
    )
}
