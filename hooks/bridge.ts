import type { EngineInterface } from 'claude-code'
import { BRIDGE_ACTIONS_KEPT, BRIDGE_DIR, BRIDGE_REWRITE_MS } from './defaults'
import { boardAct, boardInputs, boardSnapshot, type BoardAction } from './side'

// The board for apps outside Claude Code, such as contr (a native herdr client):
// ~/.herdr-agents/board/<session id>.json holds what the sidebar shows, rewritten when it
// changes and once a minute (docs/board-schema.json), and each file the app drops in <session id>.actions/
// is one press of a sidebar button, done on the next pass and removed. What came of the
// last few is in the snapshot's `actions`.

// What the snapshot last written was built from, the snapshot itself without its time, when it was written, and what came of the last actions.
let written = ''
let shown = ''
let writtenAt = 0
let results: { id: string; ok: boolean; message: string }[] = []

async function paths($: EngineInterface) {
  const dir = `${(await $.env.get('HOME')) ?? ''}/${BRIDGE_DIR}`
  const id = await $.session.id()
  return { dir, file: `${dir}/${id}.json`, inbox: `${dir}/${id}.actions` }
}

// Runs with the band's refresh: the actions waiting first, so the snapshot shows what they did.
export async function publishBoard($: EngineInterface) {
  const { file, inbox } = await paths($)
  await takeActions($, inbox)
  const inputs = (await boardInputs($)) + JSON.stringify(results)
  const now = await $.clock.now()
  const due = now - writtenAt >= BRIDGE_REWRITE_MS
  if (inputs === written && !due) return
  const snap = { ...(await boardSnapshot($)), actions: results }
  // The inputs hold the minute and a wait's last check: when they move and the snapshot says the same, there is nothing to tell (#151),
  // beyond the one write a minute that keeps `at` moving.
  const same = JSON.stringify({ ...snap, at: 0 })
  if (same === shown && !due) {
    written = inputs
    return
  }
  await $.process.run(['mkdir', '-p', inbox])
  // Written beside it and moved over it, so a reader never sees half a file.
  await $.fs.write(`${file}.tmp`, JSON.stringify(snap, null, 2))
  const moved = await $.process.run(['mv', '-f', `${file}.tmp`, file])
  if (moved.exitCode === 0) {
    written = inputs
    shown = same
    writtenAt = now
  }
}

async function takeActions($: EngineInterface, inbox: string) {
  if (!(await $.fs.exists(inbox))) return
  const files = (await $.fs.list(inbox))
    .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    .map(f => f.name)
    .sort()
  for (const name of files) {
    const path = `${inbox}/${name}`
    let result: (typeof results)[number]
    try {
      const a = JSON.parse(await $.fs.read(path)) as BoardAction
      result = { id: name, ok: true, message: await boardAct($, a) }
    } catch (err) {
      result = { id: name, ok: false, message: String(err instanceof Error ? err.message : err).slice(0, 200) }
    }
    await $.process.run(['rm', '-f', path])
    results = [...results, result].slice(-BRIDGE_ACTIONS_KEPT)
  }
}

// The session is ending: its board and inbox go.
export async function removeBoard($: EngineInterface) {
  const { file, inbox } = await paths($)
  await $.process.run(['rm', '-rf', file, `${file}.tmp`, inbox])
}
