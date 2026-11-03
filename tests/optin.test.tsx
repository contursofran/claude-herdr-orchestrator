import { expect } from 'claude-code/testing'
import { BATCH_MS, SAVE_WAIT_MS } from '../hooks/defaults'
import { command, spawn, start, stopAll, test } from './harness'

// Orchestrating is opt-in (#249): a session that did not run /hrd-orchestrate gets none of the coordinator's
// guidance; one that did gets all of it. Reports for workers it was asked to start arrive either way.

const PLAYBOOK = /You coordinate worker agents/
const NUDGE = /workers working/
const ROLES = /`builder` does all code changes; `reviewer` reviews every builder PR/

async function reportOnce($: Parameters<typeof spawn>[0], ctx: Awaited<ReturnType<typeof start>>) {
  const { clock, emit, typed, files, submitted } = ctx
  await spawn($, ['w-a'])
  await emit('w-a', 'working')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${token} -->\nDone: approve.`
  await clock.advance(2 * 3000)
  await clock.advance(BATCH_MS)
  return submitted.join('\n')
}

test('a session without /hrd-orchestrate gets the report of a worker it started, and no playbook or nudge', async ($, on) => {
  const ctx = await start($, on)
  const all = await reportOnce($, ctx)
  expect(all).toMatch(/<herdr-agent name="w-a"/)
  expect(all).not.toMatch(PLAYBOOK)
  expect(all).not.toMatch(NUDGE)
  expect(all).not.toMatch(ROLES)
  await stopAll($, ctx.clock, ['w-a'])
})

test('a session with /hrd-orchestrate gets the playbook, the roles and the nudge', async ($, on) => {
  const ctx = await start($, on)
  await command($, 'hrd-orchestrate', 'ship it')
  const all = await reportOnce($, ctx)
  expect(all).toMatch(PLAYBOOK)
  expect(all).toMatch(ROLES)
  expect(all).toMatch(NUDGE)
  await stopAll($, ctx.clock, ['w-a'])
})

// The playbook reaches the model again after each compaction, in a coordinator only.
async function compacted($: Parameters<typeof spawn>[0], on: Parameters<typeof start>[1], orchestrate: boolean) {
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }) as never)
  on('session.measure', () => ({ changed: ['context'] }))
  const { clock, files, submitted } = await start($, on, { resetAt: 1000 })
  if (orchestrate) await command($, 'hrd-orchestrate', 'ship it')
  files['/repo/COORDINATOR-STATE.md'] = '# S\n'
  await spawn($, ['w-a'])
  const measure = (tokens: number) => $.session.measure({ context: { tokens, window: 200_000 }, rateLimits: [], changed: ['context'] })
  await measure(5000)
  await clock.advance(1000)
  await clock.advance(SAVE_WAIT_MS)
  await measure(5000)
  await clock.advance(3000)
  await stopAll($, clock, ['w-a'])
  return submitted.join('\n')
}

test('a plain session with workers gets no save-state or compaction prompt', async ($, on) => {
  const plain = await compacted($, on, false)
  expect(plain).not.toMatch(/The conversation was compacted/)
  expect(plain).not.toMatch(/Update .* now so a fresh context/)
  expect(plain).not.toMatch(PLAYBOOK)
})

test('a plain session with workers gets no wrap-up prompt from /hrd-wrap-up, on or off', async ($, on) => {
  const { submitted, clock } = await start($, on)
  await spawn($, ['w-a'])
  await command($, 'hrd-wrap-up')
  await command($, 'hrd-wrap-up', 'off')
  await clock.advance(BATCH_MS)
  const all = submitted.join('\n')
  expect(all).not.toMatch(/wrapping up|ended the wrap-up|keep \d+ workers busy/)
  await stopAll($, clock, ['w-a'])
})

test('wrapUp: true in the config gives a plain session no wrap-up line with a report', async ($, on) => {
  const ctx = await start($, on, { wrapUp: true })
  const all = await reportOnce($, ctx)
  expect(all).toMatch(/<herdr-agent name="w-a"/)
  expect(all).not.toMatch(/Wrapping up/)
  expect(all).not.toMatch(/update the state file/)
  await stopAll($, ctx.clock, ['w-a'])
})

test('after a compaction a coordinator gets the playbook and the roles', async ($, on) => {
  const coordinator = await compacted($, on, true)
  expect(coordinator).toMatch(/The conversation was compacted/)
  expect(coordinator).toMatch(PLAYBOOK)
  expect(coordinator).toMatch(ROLES)
})
