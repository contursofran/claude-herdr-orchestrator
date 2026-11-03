import { SettingsState, settingsView } from './settingsview.js'

export default class SettingsRole {
  init(cx) {
    this.settings = new SettingsState(cx, this.props)
  }

  render(cx) {
    return settingsView(this.settings, cx)
  }

  close() {}
}
