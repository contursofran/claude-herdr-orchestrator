// Makes layouts/coordinator.json from layouts/main.json: the same window with two always-present rows,
// the pin bar under the tabs and the strip under the work area, and the answer card floating over the terminal. Written only if absent, and never switched to
// (layout.clone would switch the owner's window).
//
//   node app/layout.mjs [app home]      default: $HERDR_APP_HOME or ~/.config/herdr-app
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const block = (id, px, role) => ({
  id,
  type: 'block',
  size: { px },
  resizable: false,
  content: { mod: 'herdr-agents', props: { role } },
})

/** The answer card: a floating block over the `main` block, at the bottom edge, centred. Herdr draws its frame and the
 *  mod draws nothing while no card is open, so the terminal's size never changes. */
const cardBlock = () => ({
  id: 'hrd-card',
  content: { mod: 'herdr-agents', props: { role: 'card' } },
  edge: 'bottom',
  align: 'center',
})

const findNode = (node, id) => {
  if (node?.id === id) return node
  for (const child of node?.children ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return null
}

/** Removes the old hidden `hrd-card` row (the panel of S5) from whichever node holds it, in place. true if it was there. */
function removeCardRow(node) {
  const kids = node?.children
  if (!Array.isArray(kids)) return false
  const at = kids.findIndex(c => c?.id === 'hrd-card')
  if (at >= 0) {
    kids.splice(at, 1)
    return true
  }
  return kids.some(removeCardRow)
}

/** Whether any node already floats an `hrd-card` (the owner may have dragged it: its saved spot stays as it is). */
function hasFloatingCard(node) {
  if ((node?.floating ?? []).some(f => f?.id === 'hrd-card')) return true
  return (node?.children ?? []).some(hasFloatingCard)
}

/** Brings the answer card up to date in `layout`, in place: the old hidden row goes, and a floating `hrd-card` is added
 *  to the `main` block unless one floats already (that one is left alone, spot and all). true if anything changed;
 *  nothing is added when there is no `main` block. */
export function addCard(layout) {
  let changed = removeCardRow(layout)
  if (hasFloatingCard(layout)) return changed
  const main = findNode(layout, 'main')
  if (!main) return changed
  main.floating = [...(main.floating ?? []), cardBlock()]
  return true
}

const agentsList = { mod: 'herdr-agents', props: { role: 'agents' } }

/** Points the `agents` block (Herdr's agents list) at this mod's copy, which has the Orchestrators section.
 *  Edits `layout` in place; true if it changed anything. Only a block that still shows Herdr's own `agents` mod is touched. */
export function repointAgents(layout) {
  const find = node => {
    if (node?.id === 'agents' && node.content?.mod === 'agents') return node
    for (const child of node?.children ?? []) {
      const found = find(child)
      if (found) return found
    }
    return null
  }
  const node = find(layout)
  if (!node) return false
  node.content = { ...node.content, ...structuredClone(agentsList), props: { ...node.content.props, ...agentsList.props } }
  return true
}

/** `main` with (`version` is the app's, for `cloned_from`) the pin bar after `tabs` and the strip after `work-body`, both in the `work` column, and the `agents` block on this mod's list. Throws if main has another shape. */
export function coordinatorLayout(main, version) {
  const layout = structuredClone(main)
  const find = (node, id) => {
    if (node?.id === id) return node
    for (const child of node?.children ?? []) {
      const found = find(child, id)
      if (found) return found
    }
    return null
  }
  const work = find(layout, 'work')
  const kids = work?.children
  const tabs = kids?.findIndex(c => c.id === 'tabs')
  const body = kids?.findIndex(c => c.id === 'work-body')
  if (!kids || tabs < 0 || body < 0 || body < tabs) throw new Error('layouts/main.json has no work column with tabs and work-body')
  if (find(layout, 'hrd-pins') || find(layout, 'hrd-strip')) throw new Error('layouts/main.json already has the pin bar or strip')
  kids.splice(body + 1, 0, block('hrd-strip', 34, 'strip'))
  kids.splice(tabs + 1, 0, block('hrd-pins', 38, 'pinbar'))
  repointAgents(layout)
  addCard(layout)
  layout.cloned_from = version ? { name: 'main', version } : { name: 'main' }
  return layout
}

/** Writes <home>/layouts/coordinator.json unless it exists. Returns 'written' or 'exists'. A file that exists keeps
 *  everything but one thing: an `agents` block still on Herdr's own mod is repointed (then 'updated'). */
export function writeCoordinatorLayout(home) {
  const target = join(home, 'layouts', 'coordinator.json')
  if (existsSync(target)) {
    let layout
    try {
      layout = JSON.parse(readFileSync(target, 'utf8'))
    } catch {
      return 'exists'
    }
    // Both edits run: `||` would skip the second one.
    const changed = [repointAgents(layout), addCard(layout)].some(Boolean)
    if (!changed) return 'exists'
    writeFileSync(`${target}.tmp`, `${JSON.stringify(layout, null, 2)}\n`)
    renameSync(`${target}.tmp`, target)
    return 'updated'
  }
  const main = JSON.parse(readFileSync(join(home, 'layouts', 'main.json'), 'utf8'))
  let version
  try {
    version = execFileSync('herdr-app', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).match(
      /\d[\w.+-]*/,
    )?.[0]
  } catch {}
  // The app reads this folder live: write beside it and rename.
  writeFileSync(`${target}.tmp`, `${JSON.stringify(coordinatorLayout(main, version), null, 2)}\n`)
  renameSync(`${target}.tmp`, target)
  return 'written'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const home = process.argv[2] ?? process.env.HERDR_APP_HOME ?? join(homedir(), '.config', 'herdr-app')
  try {
    const result = writeCoordinatorLayout(home)
    console.log(
      result === 'written'
        ? 'Layout "coordinator" added; switch to it yourself (layout.switch {name: "coordinator"}).'
        : result === 'updated'
          ? 'Layout "coordinator" exists; only its agents list and answer card were brought up to date.'
          : 'Layout "coordinator" exists; left as it is.',
    )
  } catch (e) {
    // Not fatal: the install carries on without the layout.
    console.log(`Layout "coordinator" not made: ${e.message}`)
  }
}
