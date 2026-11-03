import { View, div } from 'gpui-kit'
import { props } from 'herdr'

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
        this.role = new mod.default()
        this.role.props = own
        this.role.init(cx)
        // The redraw that shows the role goes through a spawn: a bare cx.notify() here reaches only some of the copies.
        cx.spawn(async cx => cx.notify())
      })
      .catch(error => console.log(`herdr-agents: ${own.role} failed to load: ${error}`))
  }

  async close() {
    await this.loaded
    await this.role?.close()
  }

  render(cx) {
    return this.role?.render(cx) ?? div()
  }
}
