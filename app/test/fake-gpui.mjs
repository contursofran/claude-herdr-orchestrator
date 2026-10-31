// A stand-in for the app's `gpui-kit` and `herdr` modules, so a view can really be built in a test. It is as strict as the
// app where `herdr-app check` is not: a colour must be a hex string, and a bare number as a line height is refused (the app
// reads it as a multiple of the font size, and the text does not draw), and `.child(null)` throws, as it does there.
import { registerHooks } from 'node:module'

const COLOUR = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i
const COLOUR_CALLS = new Set(['bg', 'text_color', 'border_color'])

function makeElement(...init) {
  const node = { calls: {}, kids: [], init } // `init`: what the element was made with, e.g. an svg's path
  const el = new Proxy(node, {
    get(_t, name) {
      if (name === 'node') return node
      if (name === 'when') return (cond, f) => (cond ? f(el) : el)
      if (name === 'child') {
        return kid => {
          if (kid === null || kid === undefined) throw new Error('.child() needs an element or text')
          node.kids.push(kid)
          return el
        }
      }
      if (name === 'content') {
        // A Popup's content slot: drawn, so a test finds what is in it.
        return kid => {
          node.kids.push(kid)
          node.popupContent = kid
          return el
        }
      }
      if (name === 'children') {
        return kids => {
          node.kids.push(...kids)
          return el
        }
      }
      if (name === 'hover') {
        return f => {
          f(el)
          return el
        }
      }
      return (...args) => {
        if (COLOUR_CALLS.has(name) && !COLOUR.test(args[0])) throw new Error(`\`${args[0]}\` is not a color value`)
        if (name === 'line_height' && typeof args[0] === 'number') throw new Error('line_height needs a length, such as "20px"')
        node.calls[name] = args
        return el
      }
    },
  })
  return el
}

/** What the fake `herdr` module reads and records; a test sets these before it renders. */
export const app = {
  files: {},
  props: null,
  store: {},
  opened: [],
  closed: [],
  viewport: null,
  focused: null,
  ran: [],
  execs: [],
  settings: { zoom: 1 },
  notes: [],
}

globalThis.__fakeGpui = {
  appHome: () => '/app-home',
  notify: n => app.notes.push(n),
  div: makeElement,
  svg: makeElement,
  View: class {},
  Popup: {
    new: (id, trigger) => {
      const el = makeElement().id(id)
      el.node.kids.push(trigger)
      el.node.popup = true
      return el
    },
  },
  TextView: {
    markdown: (id, markdown) => {
      const el = makeElement().id(id)
      el.node.markdown = markdown
      el.node.kids.push(markdown)
      return el
    },
  },
  closeOverlay: id => {
    if (app.closeThrows) throw new Error('overlay already closed')
    app.closed.push(id)
  },
  exec: async (command, args) => {
    app.execs.push([command, ...(args ?? [])])
    return { exitCode: 0 }
  },
  focused: () => app.focused ?? null,
  layout: () => app.layout ?? null,
  openOverlay: o => {
    app.opened.push(o)
    return `o${app.opened.length}`
  },
  props: () => app.props,
  readTextFile: async path => {
    const text = app.files[path]
    if (text instanceof Error) throw text
    return text ?? null
  },
  theme: () => ({ chrome: '#101010', border: '#202020', dim: '#303030' }),
  run: (name, args) => app.ran.push([name, args]),
  settings: () => app.settings ?? {},
  setShared: (k, v) => {
    app.store[k] = v
  },
  shared: k => app.store[k],
  terminals: () => [],
}

const names = {
  'gpui-base': ['Popup', 'TextView'],
  'gpui-kit': ['div', 'svg', 'View'],
  herdr: [
    'appHome',
    'closeOverlay',
    'exec',
    'focused',
    'hc',
    'home',
    'layout',
    'nextCommand',
    'notify',
    'openOverlay',
    'playSound',
    'props',
    'readTextFile',
    'run',
    'settings',
    'setShared',
    'shared',
    'terminals',
    'theme',
    'watchFolder',
    'writeTextFile',
  ],
}

registerHooks({
  resolve(specifier, context, next) {
    return names[specifier] ? { url: `fake:${specifier}`, shortCircuit: true } : next(specifier, context)
  },
  load(url, context, next) {
    const list = names[url.slice('fake:'.length)]
    if (!url.startsWith('fake:') || !list) return next(url, context)
    const source = list.map(n => `export const ${n} = globalThis.__fakeGpui.${n};`).join('\n')
    return { format: 'module', source, shortCircuit: true }
  },
})

/** All the text an element draws, in order. */
export function textOf(el) {
  if (el === null || el === undefined) return []
  if (typeof el !== 'object' && typeof el !== 'function') return [String(el)]
  return el.node.kids.flatMap(textOf)
}

/** The first element with this id, or null. */
export function findId(el, id) {
  if (typeof el !== 'object' && typeof el !== 'function') return null
  if (el.node.calls.id?.[0] === id) return el
  for (const kid of el.node.kids) {
    const hit = findId(kid, id)
    if (hit) return hit
  }
  return null
}
