import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SENT_HIDE_MS, UNDO_MS, doneAction } from '../mods/herdr-agents/model.js'
import { Outbox } from '../mods/herdr-agents/outbox.js'

function setup({ fail = false } = {}) {
  const t = { now: 1000, sends: [], notes: [], timers: [], gate: null, notified: 0 }
  const send = async (session, action, id) => {
    t.sends.push({ session, action, id })
    if (t.gate) await t.gate
    if (fail) throw new Error('mv failed')
  }
  const box = new Outbox({ send, notify: n => t.notes.push(n), now: () => t.now })
  const jobs = []
  const cx = {
    timer: { after: (ms, fn) => t.timers.push({ ms, fn }) },
    spawn: fn => jobs.push(fn({ notify: () => t.notified++ })),
    jobs,
  }
  return { t, box, cx }
}

test('schedule hides the item, shows it as waiting and sets one timer after UNDO_MS', () => {
  const { t, box, cx } = setup()
  const id = box.schedule(cx, 's', doneAction('T1'))
  assert.deepEqual([...box.hidden()], ['s:T1'])
  assert.deepEqual(
    box.waiting('s').map(q => q.id),
    [id],
  )
  assert.deepEqual(box.waiting('other'), [])
  assert.equal(t.timers[0].ms, UNDO_MS + 50)
  assert.equal(t.sends.length, 0)
})

test('undo before the timer: nothing is sent and the item shows again', async () => {
  const { t, box, cx } = setup()
  const id = box.schedule(cx, 's', doneAction('T1'))
  box.undo(id)
  t.now += UNDO_MS + 50
  t.timers[0].fn(cx)
  await Promise.all(cx.jobs)
  assert.equal(t.sends.length, 0)
  assert.equal(box.hidden().size, 0)
})

test('flush before the time is up sends nothing; after it sends once, in a file named by the id', async () => {
  const { t, box, cx } = setup()
  const id = box.schedule(cx, 's', doneAction('T1'))
  box.flush(cx)
  assert.equal(cx.jobs.length, 0)
  t.now += UNDO_MS + 50
  t.timers[0].fn(cx)
  box.flush(cx) // a second flush finds nothing
  await Promise.all(cx.jobs)
  assert.equal(t.sends.length, 1)
  assert.equal(t.sends[0].id, id)
  assert.deepEqual(t.sends[0].action, doneAction('T1'))
  assert.equal(t.notified, 1)
  assert.equal(box.queue.length, 0)
  assert.deepEqual([...box.hidden()], ['s:T1'], 'sent: stays hidden until the board settles')
})

test('mid-send the action is already in sent: the item stays hidden and does not come back', async () => {
  const { t, box, cx } = setup()
  let open
  t.gate = new Promise(r => (open = r))
  box.schedule(cx, 's', doneAction('T1'))
  t.now += UNDO_MS + 50
  box.flush(cx)
  await Promise.resolve()
  assert.equal(box.queue.length, 0)
  assert.deepEqual([...box.hidden()], ['s:T1'])
  open()
  await Promise.all(cx.jobs)
})

test('a failed send notifies and brings the item back', async () => {
  const { t, box, cx } = setup({ fail: true })
  box.schedule(cx, 's', doneAction('T1'))
  t.now += UNDO_MS + 50
  box.flush(cx)
  await Promise.all(cx.jobs)
  assert.equal(t.notes.length, 1)
  assert.equal(t.notes[0].title, 'Could not send')
  assert.equal(t.notes[0].body, 'mv failed')
  assert.equal(box.hidden().size, 0)
})

test('a sent action stops hiding its item after SENT_HIDE_MS if the board never answers', async () => {
  const { t, box, cx } = setup()
  box.schedule(cx, 's', doneAction('T1'))
  t.now += UNDO_MS + 50
  box.flush(cx)
  await Promise.all(cx.jobs)
  t.now += SENT_HIDE_MS - 1
  assert.equal(box.hidden().size, 1)
  t.now += 1
  assert.equal(box.hidden().size, 0)
})

test('settle drops what the board settled and reports ok:false once', async () => {
  const { t, box, cx } = setup()
  const id = box.schedule(cx, 's', doneAction('T1'))
  t.now += UNDO_MS + 50
  box.flush(cx)
  await Promise.all(cx.jobs)
  const open = { session: 's', needs: [{ key: 'T1', kind: 'know', isOpen: true }] }
  assert.equal(box.settle([open]), false)
  assert.equal(box.settle([{ ...open, actions: [{ id, ok: false, message: 'no such item' }] }]), true)
  assert.equal(box.sent.length, 0)
  assert.deepEqual(
    t.notes.map(n => [n.title, n.body]),
    [['Action failed', 'no such item']],
  )
})
