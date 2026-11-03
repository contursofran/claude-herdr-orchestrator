import { View, div } from 'gpui-kit'
import { props, setShared, shared, theme } from 'herdr'

// One mod, one file per part; props().role says which part this copy draws. Herdr keeps every load of a mod for the life of
// the window, and loads it again for each copy, so a copy imports only its own role's code, with import() (#335). Each role
// module's default export is a class with init(cx), render(cx) and close(). A role with no module here draws nothing.
const roles = {
  version: () => import('./role-version.js'),
  usage: () => import('./role-usage.js'),
  settings: () => import('./role-settings.js'),
  spaces: () => import('./role-spaces.js'),
  agents: () => import('./role-agents.js'),
  panel: () => import('./role-panel.js'),
  board: () => import('./role-board.js'),
  strip: () => import('./role-strip.js'),
  sheet: () => import('./role-sheet.js'),
  arrivals: () => import('./role-arrivals.js'),
}

export default class HerdrAgents extends View {
  init(_props, cx) {
    // props() is read now: after the import() it answers for the copy loaded last, so the role gets this copy's own.
    const own = props()
    const load = roles[own?.role]
    if (!load) return
    // `loaded` settles once the role is running (the tests wait on it); until then the copy draws nothing.
    this.loaded = load()
      .then(mod => {
        const role = new mod.default()
        role.props = own
        role.init(cx)
        this.role = role // only once it runs: a role whose init threw is never drawn or closed half-set
        // The redraw that shows the role goes through a spawn: a bare cx.notify() here reaches only some of the copies.
        cx.spawn(async cx => cx.notify())
      })
      .catch(error => this.loadFailed(own.role, error, cx))
  }

  /** A role that cannot load says so: in the log, in the view (a dim line, so the owner is not left with a blank band) and,
   *  for a part the plugin's band stands in for, in the draw-failed key the strip's copy reports with its heartbeat. */
  loadFailed(role, error, cx) {
    this.failure = `herdr-agents: ${role} failed to load: ${error?.message ?? error}`
    console.log(this.failure)
    import('./drawguard.js').then(guard => guard.guardsDraw(role) && guard.noteDraw(role, error, shared, setShared)).catch(() => {})
    cx.spawn(async cx => cx.notify())
  }

  async close() {
    await this.loaded
    await this.role?.close()
  }

  render(cx) {
    if (this.failure) {
      const t = theme()
      return div().size_full().flex().items_center().px(8).text_size(11).text_color(t.dim).child(div().truncate().child(this.failure))
    }
    return this.role?.render?.(cx) ?? div() // a role that draws nothing (arrivals) has no render
  }
}
