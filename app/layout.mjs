// Makes layouts/coordinator.json from layouts/main.json: the same window with the pin bar under the tabs, the strip
// under the work area (the strip draws the answer card above its tabs) and the version at the right of the status bar. Written only if absent, and never switched to
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

/** The context sheet: a floating block over the `main` block, at the top edge, centred. Like the card it draws nothing
 *  while closed, so the terminal's size never changes. */
const sheetBlock = () => ({
  id: 'hrd-sheet',
  content: { mod: 'herdr-agents', props: { role: 'sheet' } },
  edge: 'top',
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

/** Removes the answer card's old blocks from `layout`, in place: the hidden `hrd-card` row (the panel of S5) and the floating
 *  `hrd-card` (the strip's copy draws the card now, above the tab it opened from). A dragged one goes too: it is not drawn
 *  any more. true if anything was removed. */
export function removeCard(layout) {
  let removed = false
  const walk = node => {
    for (const key of ['children', 'floating']) {
      const kids = node?.[key]
      if (!Array.isArray(kids)) continue
      const keep = kids.filter(c => c?.id !== 'hrd-card')
      if (keep.length !== kids.length) {
        removed = true
        if (key === 'floating' && keep.length === 0) delete node.floating
        else node[key] = keep
      }
      node[key]?.forEach(walk)
    }
  }
  walk(layout)
  return removed
}

/** Whether any node already floats a block with this `id` (the owner may have dragged it: its saved spot stays). */
function hasFloating(node, id) {
  if ((node?.floating ?? []).some(f => f?.id === id)) return true
  return (node?.children ?? []).some(c => hasFloating(c, id))
}

/** Adds the floating `hrd-sheet` to the `main` block unless one floats already. true if the layout changed; nothing is
 *  added when there is no `main` block. */
export function addSheet(layout) {
  if (hasFloating(layout, 'hrd-sheet')) return false
  const main = findNode(layout, 'main')
  if (!main) return false
  main.floating = [...(main.floating ?? []), sheetBlock()]
  return true
}

const VERSION_WIDTH = 190

/** Puts the `status` block in a row with a fixed `hrd-version` block of this mod at its right, in place. The block keeps
 *  its id, so its saved clicks stay. true if it changed anything; only a block still on Herdr's own status mod is touched,
 *  and only once. */
export function addVersion(layout) {
  if (findNode(layout, 'hrd-version')) return false
  const wrap = node => {
    const kids = node?.children
    if (!Array.isArray(kids)) return false
    const at = kids.findIndex(c => c?.id === 'status' && c.content?.mod === 'workspace-status')
    if (at < 0) return kids.some(wrap)
    const { size, ...status } = kids[at]
    kids[at] = {
      id: 'hrd-status-row',
      type: 'row',
      size,
      resizable: false,
      children: [{ ...status, size: { weight: 1 } }, block('hrd-version', VERSION_WIDTH, 'version')],
    }
    return true
  }
  return wrap(layout)
}

const USAGE_WIDTH = 290

/** Puts a fixed `hrd-usage` block just left of the version block, in place. true if it changed anything; nothing is added
 *  when the version block is not in its row (`addVersion` makes that row, so run it first). */
export function addUsage(layout) {
  if (findNode(layout, 'hrd-usage')) return false
  const row = findNode(layout, 'hrd-status-row')
  const at = row?.children?.findIndex(c => c?.id === 'hrd-version') ?? -1
  if (at < 0) return false
  row.children.splice(at, 0, block('hrd-usage', USAGE_WIDTH, 'usage'))
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

const spacesList = { mod: 'herdr-agents', props: { role: 'spaces' } }

/** Points the `spaces` block (Herdr's Spaces list) at this mod's copy, which has the CPU, RAM and disk line under each
 *  machine. Edits `layout` in place; true if it changed anything. Only a block that still shows Herdr's own `spaces` mod is touched. */
export function repointSpaces(layout) {
  const find = node => {
    if (node?.id === 'spaces' && node.content?.mod === 'spaces') return node
    for (const child of node?.children ?? []) {
      const found = find(child)
      if (found) return found
    }
    return null
  }
  const node = find(layout)
  if (!node) return false
  node.content = { ...node.content, ...structuredClone(spacesList), props: { ...node.content.props, ...spacesList.props } }
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
  repointSpaces(layout)
  removeCard(layout)
  addSheet(layout)
  addVersion(layout)
  addUsage(layout)
  layout.cloned_from = version ? { name: 'main', version } : { name: 'main' }
  return layout
}

/** Writes <home>/layouts/coordinator.json unless it exists. Returns 'written', 'exists' or 'updated'. A file that exists keeps
 *  everything but what `repointAgents`, `repointSpaces`, `removeCard`, `addSheet`, `addVersion` and `addUsage` bring up to date (then 'updated'). */
export function writeCoordinatorLayout(home) {
  const target = join(home, 'layouts', 'coordinator.json')
  if (existsSync(target)) {
    let layout
    try {
      layout = JSON.parse(readFileSync(target, 'utf8'))
    } catch {
      return 'exists'
    }
    // All the edits run: `||` would skip the later ones.
    const [repointed, uncarded, sheeted, versioned, spaced, usaged] = [
      repointAgents(layout),
      removeCard(layout),
      addSheet(layout),
      addVersion(layout),
      repointSpaces(layout),
      addUsage(layout),
    ]
    if (!repointed && !uncarded && !sheeted && !versioned && !spaced && !usaged) return 'exists'
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
          ? 'Layout "coordinator" exists; only its agents and Spaces lists, answer card block, sheet and version block were brought up to date.'
          : 'Layout "coordinator" exists; left as it is.',
    )
  } catch (e) {
    // Not fatal: the install carries on without the layout.
    console.log(`Layout "coordinator" not made: ${e.message}`)
  }
}
