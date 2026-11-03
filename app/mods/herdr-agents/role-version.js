import { readVersion, versionView } from './version.js'

export default class VersionRole {
  init(cx) {
    // Read once: nothing here starts the boards or redraws other copies.
    cx.spawn(async cx => {
      this.version = await readVersion()
      if (this.version) cx.notify()
    })
  }

  render() {
    return versionView(this.version)
  }

  close() {}
}
