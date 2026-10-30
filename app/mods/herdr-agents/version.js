// Role `version`: the installed version, small and dim at the right of the status bar, so the owner can tell what is
// installed. install.sh writes the file; it is read once when the copy starts (no timer, no process, no shared state).
import { div } from 'gpui-kit'
import { appHome, readTextFile, theme } from 'herdr'

/** What to show for the text of version.json: `herdr-agents 0.18.0 · f623480`, or without the commit if git gave none.
 *  null for a missing or bad file. */
export function versionLabel(text) {
  let info
  try {
    info = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof info?.version !== 'string' || !info.version) return null
  const commit = typeof info.commit === 'string' && info.commit ? ` · ${info.commit}` : ''
  return `herdr-agents ${info.version}${commit}`
}

/** The label from the installed file; null if it can't be read. Never rejects. */
export async function readVersion() {
  try {
    return versionLabel(await readTextFile(`${appHome()}/mods/herdr-agents/version.json`))
  } catch {
    return null
  }
}

/** The bar's own background and top line, so the row reads as one bar; no text without a label. */
export function versionView(label) {
  const t = theme()
  return div()
    .size_full()
    .flex()
    .items_center()
    .justify_end()
    .pr(14)
    .bg(t.chrome)
    .border_t(1)
    .border_color(t.border)
    .text_size(11)
    .text_color(t.dim)
    .when(Boolean(label), el => el.child(div().truncate().child(label)))
}
