// The reader's gates: a watcher event whose text did not change redraws nothing (#151).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoardReader } from '../mods/herdr-agents/boardreader.js'

const DIR = '/b'
const text = (at, needs = []) => JSON.stringify({ session: 's', at, needs })

// A reader on fake files. `report(names)` is one watcher event; it resolves once the reader has handled it.
function rig(files) {
  let wake
  const settle = () => new Promise(r => setTimeout(r, 0))
  const reader = new BoardReader({
    dir: () => DIR,
    exec: async cmd => ({ stdout: cmd === 'ls' ? Object.keys(files).join('\n') : DIR }),
    readTextFile: async path => {
      const name = path.slice(DIR.length + 1)
      if (name === 'broken.json') throw new Error('unreadable')
      return files[name] ?? null
    },
    watchFolder: () => new Promise(r => (wake = r)),
  })
  const changes = { count: 0 }
  const cx = { spawn: f => void f(cx) }
  const onChange = () => changes.count++
  const report = async (...names) => {
    wake(names.map(n => `${DIR}/${n}`))
    await settle()
  }
  return { reader, changes, cx, onChange, report, settle }
}

test('load: true when the text differs from the last read, false when it does not or the file cannot be read', async () => {
  const files = { 's.json': text(1) }
  const { reader } = rig(files)
  assert.equal(await reader.load(DIR, 's'), true)
  assert.equal(await reader.load(DIR, 's'), false, 'same text')
  files['s.json'] = text(2)
  assert.equal(await reader.load(DIR, 's'), true)
  assert.equal(reader.list()[0].at, 2)
  assert.equal(await reader.load(DIR, 'broken'), false)
  delete files['s.json']
  assert.equal(await reader.load(DIR, 's'), true, 'a board that went')
  assert.deepEqual(reader.list(), [])
})

test('start: an event with the same text calls nobody, a changed file does', async () => {
  const files = { 's.json': text(1) }
  const { reader, changes, cx, onChange, report, settle } = rig(files)
  reader.start(cx, onChange)
  await settle()
  assert.equal(changes.count, 1, 'the first read')
  await report('s.json')
  assert.equal(changes.count, 1)
  files['s.json'] = text(2)
  await report('s.json')
  assert.equal(changes.count, 2)
})

test('startOne: unchanged text and other files call nobody, a changed board does', async () => {
  const files = { 's.json': text(1), 'o.json': text(1) }
  const { reader, changes, cx, onChange, report, settle } = rig(files)
  reader.startOne(cx, 's', JSON.parse(files['s.json']), onChange)
  assert.equal(reader.list().length, 1, 'the passed board shows at once')
  await settle()
  assert.equal(changes.count, 1, 'the re-read')
  await report('s.json')
  assert.equal(changes.count, 1)
  files['o.json'] = text(2)
  await report('o.json')
  assert.equal(changes.count, 1)
  files['s.json'] = text(2)
  await report('s.json')
  assert.equal(changes.count, 2)
  assert.equal(reader.list()[0].at, 2)
})
