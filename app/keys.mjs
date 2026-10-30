// Merges app/keys.json into the app's keys.json: adds missing keys, never replaces one that is bound, prints what it skipped.
//
//   node app/keys.mjs [app home]      default: $HERDR_APP_HOME or ~/.config/herdr-app
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Returns {keys, added, skipped}: skipped are "section key" strings bound to another action. */
export function mergeKeys(existing, wanted) {
  const keys = structuredClone(existing)
  const added = []
  const skipped = []
  for (const [section, map] of Object.entries(wanted)) {
    for (const [key, action] of Object.entries(map)) {
      const bound = keys[section]?.[key]
      if (bound === undefined) {
        keys[section] ??= {}
        keys[section][key] = action
        added.push(`${section} ${key}`)
      } else if (bound !== action) skipped.push(`${section} ${key}`)
    }
  }
  return { keys, added, skipped }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const home = process.argv[2] ?? process.env.HERDR_APP_HOME ?? join(homedir(), '.config', 'herdr-app')
  const target = join(home, 'keys.json')
  try {
    const wanted = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'keys.json'), 'utf8'))
    const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {}
    const { keys, added, skipped } = mergeKeys(existing, wanted)
    if (added.length) {
      writeFileSync(`${target}.tmp`, `${JSON.stringify(keys, null, 2)}\n`)
      renameSync(`${target}.tmp`, target)
    }
    for (const s of skipped) console.log(`Key not added, already bound: ${s}`)
  } catch (e) {
    // Not fatal: the install carries on without the keys.
    console.log(`Keys not merged: ${e.message}`)
  }
}
