// A stand-in for the app's `gpui-kit` and `herdr` modules, so a view can really be built in a test. It is stricter than
// `herdr-app check`: a colour must be a hex string, and a bare number as a line height is refused (with one, the panel drew
// no text; with "20px" it does).
import { registerHooks } from 'node:module'

const COLOUR = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i
const COLOUR_CALLS = new Set(['bg', 'text_color', 'border_color'])

function makeElement() {
  const node = { calls: {}, kids: [] }
  const el = new Proxy(node, {
    get(_t, name) {
      if (name === 'node') return node
      if (name === 'when') return (cond, f) => (cond ? f(el) : el)
      if (name === 'child') {
        return kid => {
          node.kids.push(kid)
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
export const app = { props: null, store: {}, opened: [], closed: [], viewport: null }

globalThis.__fakeGpui = {
  div: makeElement,
  svg: makeElement,
  View: class {},
  closeOverlay: id => app.closed.push(id),
  openOverlay: o => {
    app.opened.push(o)
    return `o${app.opened.length}`
  },
  props: () => app.props,
  setShared: (k, v) => {
    app.store[k] = v
  },
  shared: k => app.store[k],
}

const names = {
  'gpui-kit': ['div', 'svg', 'View'],
  herdr: [
    'closeOverlay',
    'exec',
    'focused',
    'hc',
    'home',
    'nextCommand',
    'notify',
    'openOverlay',
    'props',
    'readTextFile',
    'run',
    'setShared',
    'shared',
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
