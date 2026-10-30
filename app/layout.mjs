// Makes layouts/coordinator.json from layouts/main.json: the same window with two always-present rows,
// the pin bar under the tabs and the strip under the work area. Written only if absent, and never switched to
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

/** `main` with (`version` is the app's, for `cloned_from`) the pin bar after `tabs` and the strip after `work-body`, both in the `work` column. Throws if main has another shape. */
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
  layout.cloned_from = version ? { name: 'main', version } : { name: 'main' }
  return layout
}

/** Writes <home>/layouts/coordinator.json unless it exists. Returns 'written' or 'exists'. */
export function writeCoordinatorLayout(home) {
  const target = join(home, 'layouts', 'coordinator.json')
  if (existsSync(target)) return 'exists'
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
        : 'Layout "coordinator" exists; left as it is.',
    )
  } catch (e) {
    // Not fatal: the install carries on without the layout.
    console.log(`Layout "coordinator" not made: ${e.message}`)
  }
}
