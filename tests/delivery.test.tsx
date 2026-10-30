import { expect } from 'claude-code/testing'
import { BATCH_MS } from '../hooks/defaults'
import { settled, spawn, start, stopAll, test } from './harness'
import { EVENTS, watches, W, turnEnd, spawnBusy, jobOf, reportW } from './workerkit'

// How a report reaches the coordinator: at its worker's turn end or within two ticks, once, and as rewritten (#117).

test('a report is delivered the moment hc sees the worker finish, and only once', async ($, on) => {
  const { clock, submitted, calls, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  expect(calls).toContainEqual(EVENTS('w-busy'))
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  // No clock advance before the finish: hc's status event is what delivers the report.
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done">\nReviewed: approve\./)
  await clock.advance(3 * 60_000)
  expect(reports()).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test("a report that lands while its worker still works is delivered within two ticks, and its turn's end adds nothing", async ($, on) => {
  const { clock, submitted, typed, closed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  // hc still shows the worker working: its wait has not ended, and its turn goes on after the report.
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(2 * 3000 + BATCH_MS)
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toMatch(/^<herdr-agent name="w-busy" profile="builder" status="done">\nReviewed: approve\./)
  // The report prompts nothing in the worker and closes nothing.
  expect(typed).toHaveLength(1)
  expect(closed).toEqual([])
  // Its turn ends: the wait it still holds settles on a job already reported, so nothing more goes out.
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(reports()).toHaveLength(1)
  expect(typed).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test("a RESULT.md with another prompt's token is not delivered; this prompt's is, within two ticks", async ($, on) => {
  const { clock, submitted, typed, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = '<!-- report 0ld0ld00 -->\nReviewed: approve.'
  await clock.advance(30_000)
  expect(reports()).toEqual([])
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toContain('Reviewed: approve.')
  await stopAll($, clock, ['w-busy'])
})

test('an early report written in two parts is delivered whole, once', async ($, on) => {
  const { clock, submitted, typed, files } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  const file = '/repo/wt/.herdr-agents/w-busy/RESULT.md'
  files[file] = `<!-- report ${token} -->\nHeader only.`
  await clock.advance(3000)
  expect(reports()).toEqual([])
  files[file] += '\nThe appended line.'
  await clock.advance(3000)
  expect(reports()).toEqual([])
  await clock.advance(3000 + BATCH_MS)
  expect(reports()).toHaveLength(1)
  expect(reports()[0]).toContain('The appended line.')
  expect(files[`/repo/wt/.herdr-agents/w-busy/RESULT-${token}.md`]).toContain('The appended line.')
  await stopAll($, clock, ['w-busy'])
})

test('a report found at turn end is delivered at once, without waiting a tick', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test('a report that lands while a non-Claude worker has messages held waits for its turn to end', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on, { profiles: { x: { kind: 'codex', args: [] } } })
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'x', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  // Held: a codex worker takes no typed input mid-task, so the message goes out once it reports.
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await clock.advance(3000)
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  expect(reports()).toEqual([])
  expect(typed).toHaveLength(1)
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(reports()).toHaveLength(1)
  expect(typed.at(-1)).toMatch(/Messages from your coordinator, sent while you worked, are in/)
  await stopAll($, clock, ['w-busy'])
})

test(
  "a worker's tab stays open while hc shows it working after its early report, and closes once it has sat idle",
  { timeoutMs: 20_000 },
  async ($, on) => {
    const { clock, submitted, typed, closed, files, emit } = await start($, on, { closeIdleMinutes: 1 })
    await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
    await settled()
    const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
    files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
    await clock.advance(2 * 3000 + BATCH_MS)
    expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
    // Ten minutes past its report, hc still shows it working: the tab stays.
    await clock.advance(10 * 60_000)
    expect(closed).toEqual([])
    // Its turn ends: the sweep closes the tab once it has sat idle.
    await emit('w-busy', 'done')
    await clock.advance(60_000)
    expect(closed).toEqual(['w-busy'])
  },
)

test("a worker's own session delivers its report within two ticks, with no hc call", async ($, on) => {
  const { clock, submitted, typed, files, calls } = await start($, on, {}, {}, { HERDR_AGENTS_ROLE: 'worker' })
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  calls.length = 0
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  expect(calls).toEqual([])
  await stopAll($, clock, ['w-busy'])
})

test('a worker hc shows blocked is reported blocked at once', async ($, on) => {
  const { clock, submitted } = await start($, on)
  await spawn($, ['w-stuck'])
  // The first line of the events stream is the snapshot, which already says blocked: the report needs no clock advance, only its batch's wait.
  await clock.settle()
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(
    /^<herdr-agent name="w-stuck" profile="reviewer" status="blocked">\nThe worker is waiting at an approval/,
  )
  await stopAll($, clock, ['w-stuck'])
})

test('a worker that ends its turn without a report is woken by its next turn, not polled', async ($, on) => {
  const { clock, submitted, calls, typed, files, emit, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  // The turn ends with no report: the watch ends, and the next one waits for the next turn to start.
  await emit('w-busy', 'idle')
  expect(submitted.filter(t => t.includes('<herdr-agent'))).toEqual([])
  // The turn ended with no report, so a second watch waits for the next turn to start.
  expect(watches(calls, 'w-busy')).toBe(2)
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test('a wait child that dies does not hold up its report: the report check delivers it within two ticks', async ($, on) => {
  const { clock, submitted, typed, files, kill } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  // The worker's terminal finishes under the watch: the child is gone, and nothing reports for it.
  await kill('w-busy')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nReviewed: approve.`
  const reports = () => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  await clock.advance(2 * 3000 + BATCH_MS)
  expect(reports()).toHaveLength(1)
  await stopAll($, clock, ['w-busy'])
})

test("a delivered report and a stopped worker's screen are copied to the reports archive", async ($, on) => {
  const { clock, typed, files, finish, screens } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'builder', cwd: '/repo/wt', task: 'Fix it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  const dir = '/home/t/.herdr-agents/reports/repo/wt/.herdr-agents/w-busy'
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${token} -->\nDone, all green.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(files[`/repo/wt/.herdr-agents/w-busy/RESULT-${token}.md`]).toContain('Done, all green.')
  expect(files[`${dir}/RESULT-${token}.md`]).toBe(files[`/repo/wt/.herdr-agents/w-busy/RESULT-${token}.md`])

  screens['w-quiet'] = '⏺ Done.\n────\n❯ \n────\n  aerolab · wt · Haiku 5.5 (xhigh)'
  await spawn($, ['w-quiet'])
  await clock.advance(7 * 60_000)
  await clock.advance(BATCH_MS)
  const copies = Object.keys(files).filter(f => f.startsWith('/home/t/.herdr-agents/reports/repo-w-quiet/.herdr-agents/w-quiet/SCREEN-'))
  expect(copies).toHaveLength(1)
  const own = Object.keys(files).find(f => f.startsWith('/repo-w-quiet/.herdr-agents/w-quiet/SCREEN-'))!
  expect(files[copies[0]!]).toBe(files[own])
  await stopAll($, clock, ['w-busy', 'w-quiet'])
})

test('a header verdict reaches the coordinator on the prompt tag', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on)
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-busy', profile: 'reviewer', cwd: '/repo/wt', task: 'Review it.' })
  await settled()
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files['/repo/wt/.herdr-agents/w-busy/RESULT.md'] =
    `<!-- report ${token} -->\n\`\`\`report\nstatus: done\npr: 12\nverdict: approve\nhead: abc1234\nsummary: Fine.\n\`\`\``
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(submitted.at(-1)).toMatch(
    /^<herdr-agent name="w-busy" profile="reviewer" status="done" result="done" pr="12" verdict="approve">\n/,
  )
  await stopAll($, clock, ['w-busy'])
})

test('a stop while a report is being delivered sends nothing for the stopped worker', async ($, on) => {
  const s = await start($, on)
  await spawnBusy($, 'builder')
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nOlder draft.`
  const release = s.gate(argv => argv[0] === 'fs.write' && argv[1] === `${W}/RESULT-${token}.md`)
  await s.finish('w-busy')
  await s.clock.settle()
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  release()
  await s.clock.settle()
  await s.clock.advance(BATCH_MS)
  await s.clock.advance(3 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(s.submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(0)
  expect(jobOf(s.store, 'w-busy')).toMatchObject({ status: 'reported', reportStatus: 'stopped', closed: true })
})

test('a report rewritten while it is being delivered reaches the coordinator with the newest text only', async ($, on) => {
  const s = await start($, on)
  await spawnBusy($, 'builder')
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nOlder draft.`
  const release = s.gate(argv => argv[0] === 'fs.write' && argv[1] === `${W}/RESULT-${token}.md`)
  await s.finish('w-busy')
  await s.clock.settle()
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nNewest text.`
  // The coordinator is busy, so the older text is still held when the newest one arrives.
  await $.turn.start({ text: 'Reading.', turnId: 't1' })
  release()
  await s.clock.settle()
  await s.clock.advance(3 * 60_000)
  await $.turn.complete(turnEnd('t1'))
  await s.clock.advance(BATCH_MS)
  await s.clock.advance(3 * 60_000)
  await s.clock.advance(BATCH_MS)
  const sent = s.submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))
  expect(sent.filter(t => t.includes('Newest text.'))).toHaveLength(1)
  expect(sent.filter(t => t.includes('Older draft.'))).toHaveLength(0)
})

test('rewrites held while the coordinator works are one message with the newest text', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First draft.')
  await $.turn.start({ text: 'Reading.', turnId: 't1' })
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nSecond draft.`
  await s.clock.advance(2 * 60_000)
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nThird draft.`
  await s.clock.advance(2 * 60_000)
  expect(s.submitted.filter(t => t.includes('draft.'))).toHaveLength(1)
  await $.turn.complete(turnEnd('t1'))
  await s.clock.advance(BATCH_MS)
  const after = s.submitted.slice(1).join('\n')
  expect(after).toContain('Third draft.')
  expect(after).not.toContain('Second draft.')
  await stopAll($, s.clock, ['w-busy'])
})

test('a further report after one that already went out follows it, newest last', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First draft.')
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nSecond draft.`
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nThird draft.`
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  const sent = s.submitted.filter(t => t.includes('<herdr-agent name="w-busy"')).join('\n')
  expect(sent.indexOf('First draft.')).toBeGreaterThan(-1)
  expect(sent.indexOf('Second draft.')).toBeGreaterThan(sent.indexOf('First draft.'))
  expect(sent.indexOf('Third draft.')).toBeGreaterThan(sent.indexOf('Second draft.'))
  await stopAll($, s.clock, ['w-busy'])
})

test('a stop drops a rewrite held for the coordinator: nothing arrives when its turn ends', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First draft.')
  await $.turn.start({ text: 'Reading.', turnId: 't1' })
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nOlder rewrite.`
  await s.clock.advance(2 * 60_000)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  await $.turn.complete(turnEnd('t1'))
  await s.clock.advance(BATCH_MS)
  await s.clock.advance(5 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(s.submitted.filter(t => t.includes('Older rewrite.'))).toHaveLength(0)
})

test('a rewrite without its token line gets one short notice per change, and none after a stop', async ($, on) => {
  const s = await start($, on)
  await reportW($, s, 'First draft.')
  const notices = () => s.submitted.filter(t => t.includes('without its token line'))
  s.files[`${W}/RESULT.md`] = 'Final result, no token.'
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(notices()).toHaveLength(1)
  expect(notices()[0]).toContain(`${W}/RESULT.md`)
  expect(notices()[0]).toContain('w-busy')
  // The same text again sends nothing.
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(notices()).toHaveLength(1)
  s.files[`${W}/RESULT.md`] = 'Final result, edited.'
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(notices()).toHaveLength(2)
  expect(s.submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  s.files[`${W}/RESULT.md`] = 'Changed after the stop.'
  await s.clock.advance(5 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(notices()).toHaveLength(2)
})

test('a report rewritten without its token line after delivery is not delivered again', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First draft.')
  s.files[`${W}/RESULT.md`] = 'Rewritten, no token.'
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(s.submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  expect(token).toBeTruthy()
  await stopAll($, s.clock, ['w-busy'])
})

test('a stop after a report sends nothing for a rewrite of it', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First draft.')
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nRewritten after stop.`
  await s.clock.advance(5 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(s.submitted.filter(t => t.includes('Rewritten after stop.'))).toHaveLength(0)
})

test('a rewritten report with the same DECISION line pins it once', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First.\nDECISION: [Pick] Which one? | A | B')
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nSecond.\nDECISION: [Pick] Which one? | A | B`
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  const sent = s.submitted.filter(t => t.includes('Second.'))
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Pinned for the owner as D1.')
  await stopAll($, s.clock, ['w-busy'])
})

test('a rewrite whose DECISION line has other options is pinned as a new question', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First.\nDECISION: [Pick] Which one? | A | B')
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nSecond.\nDECISION: [Pick] Which one? | C | D`
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  const sent = s.submitted.filter(t => t.includes('Second.'))
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Pinned for the owner as D2.')
  await stopAll($, s.clock, ['w-busy'])
})

test('a rewrite does not pin again a question already settled for that report', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First.\nDECISION: [Pick] Which one? | A | B')
  await $.tool.call({ tool: 'mcp__herdr-agents__decided', ids: ['D1'], answer: 'A', by: 'owner' })
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nSecond.\nDECISION: [Pick] Which one? | A | B`
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  const sent = s.submitted.filter(t => t.includes('Second.'))
  expect(sent).toHaveLength(1)
  expect(sent[0]).not.toContain('Pinned for the owner')
  await stopAll($, s.clock, ['w-busy'])
})
