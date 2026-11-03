import { SpacesList } from './spaces.js'

export default class SpacesRole {
  init(cx) {
    this.spacesList = new SpacesList()
    this.spacesList.init(cx)
  }

  render() {
    return this.spacesList.render()
  }

  close() {}
}
