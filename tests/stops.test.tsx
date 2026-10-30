import { expect } from 'claude-code/testing'
import { BATCH_MS } from '../hooks/defaults'
import { active } from '../hooks/state'
import type { Job } from '../types'
import { start, stopAll, test } from './harness'
import { W, turnEnd, check, codex, spawnBusy, jobOf, spawnArgs, reportW } from './workerkit'

// Stops and held messages: job writes that survive what lands meanwhile, reported jobs still watched (Job.tail), and a stop that is final.

test('a stop while a WAIT.json check runs stays stopped', async ($, on) => {
  const { clock, typed, files, store, gate } = await start($, on)
  await spawnBusy($, 'builder')
  files[`${W}/WAIT.json`] = '{"for":"ci","check":"ci","every":1,"max":60}'
  const release = gate(check)
  await clock.advance(60_000)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  const before = typed.length
  release()
  await clock.settle()
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', closed: true })
  expect(typed.length).toBe(before)
})

test('a message held while a WAIT.json check runs is not lost', async ($, on) => {
  const { clock, typed, files, finish, gate, runs } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/WAIT.json`] = '{"for":"ci","check":"ci","every":1,"max":60}'
  runs.set('/bin/bash -c ci', [{ exitCode: 1 }])
  const release = gate(check)
  await clock.advance(60_000)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  release()
  await clock.settle()
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(typed.at(-1)).toMatch(/Messages from your coordinator, sent while you worked, are in .*MESSAGE-/)
})

test('a wait that passes after its worker was stopped prompts nothing', async ($, on) => {
  const { clock, typed, files, gate, runs } = await start($, on)
  await spawnBusy($, 'builder')
  files[`${W}/WAIT.json`] = '{"for":"ci","check":"ci","every":1,"max":60}'
  runs.set('/bin/bash -c ci', [{ exitCode: 0 }])
  const release = gate(check)
  await clock.advance(60_000)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  const before = typed.length
  release()
  await clock.settle()
  expect(typed.length).toBe(before)
  expect(`${W}/WAIT.json` in files).toBe(false)
})

test('a message held while a report is being delivered is listed, not lost', async ($, on) => {
  const { clock, submitted, gone, kill, gate } = await start($, on, codex)
  await spawnBusy($, 'x')
  // No RESULT.md and the terminal gone: deliver awaits `hc read` for the screen.
  const release = gate(argv => argv.join(' ').startsWith('hc read w-busy --lines 40'))
  gone.add('w-busy')
  await kill('w-busy')
  await clock.advance(60_000)
  const second = clock.advance(60_000)
  // The second sweep is now held at `hc read`, inside deliver.
  await clock.settle()
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Too late.' })
  release()
  await second
  await clock.advance(BATCH_MS)
  const report = submitted.find(t => t.includes('<herdr-agent name="w-busy"')) ?? ''
  expect(report).toMatch(/1 message\(s\) held for it were not sent, as it did not finish \(gone\): .*MESSAGE-/)
})

test('a message that lands between a report and its queued prompt is held, not typed', async ($, on) => {
  const { clock, typed, files, store, gate, finish } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'First.' })
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone.`
  // The queued prompt's first call removes RESULT.md.
  const release = gate(argv => argv.join(' ') === `rm -f ${W}/RESULT.md`)
  await finish('w-busy')
  const before = typed.length
  const sent = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Second.' })
  await clock.settle()
  release()
  const out = JSON.stringify(await sent)
  expect(out).toMatch(/held/)
  await clock.settle()
  expect(typed.length).toBe(before + 1)
  expect(typed.at(-1)).toMatch(/Messages from your coordinator/)
  expect(jobOf(store, 'w-busy').queued).toHaveLength(1)
})

test('a message to a worker reported meanwhile does not bring back running', async ($, on) => {
  const { clock, submitted, typed, files, store, gate, finish } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  const release = gate(argv => argv[0] === 'fs.write' && argv[1]!.includes('/MESSAGE-'))
  const sent = $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Late one.' })
  await clock.settle()
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone.`
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  release()
  await sent
  await clock.advance(3 * 60_000)
  expect(submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))).toHaveLength(1)
  // The message went out as its own prompt, with a new token.
  expect(typed.at(-1)).toContain('Late one.')
  expect(jobOf(store, 'w-busy').token).not.toBe(token)
})

const reportsOf = (submitted: string[]) => submitted.filter(t => t.includes('<herdr-agent name="w-busy"'))

test('a non-Claude worker reported early gets messages held until its turn ends', async ($, on) => {
  const { clock, submitted, typed, files, finish } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  expect(reportsOf(submitted)).toHaveLength(1)
  const before = typed.length
  const held = await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  expect(JSON.stringify(held)).toMatch(/still finishing its turn after its report/)
  expect(typed.length).toBe(before)
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(typed.at(-1)).toMatch(/Messages from your coordinator, sent while you worked, are in .*MESSAGE-/)
  // Sent as a prompt: no further report.
  expect(reportsOf(submitted)).toHaveLength(1)
})

test('a Claude worker reported early still gets its message typed in', async ($, on) => {
  const { clock, typed, files } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  const before = typed.length
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  expect(typed.length).toBe(before + 1)
  expect(typed.at(-1)).toMatch(/Also check the docs\./)
})

test('a worker that blocks after its early report is reported blocked once', async ($, on) => {
  const { clock, submitted, typed, files, toasts, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', tail: 'early' })
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  const reports = reportsOf(submitted)
  expect(reports).toHaveLength(2)
  expect(reports[1]).toMatch(/status="blocked">\nAfter its report/)
  expect(toasts.filter(t => t.includes('w-busy is blocked'))).toHaveLength(1)
  expect(jobOf(store, 'w-busy')).toMatchObject({ tail: 'blocked', reportStatus: 'done' })
  await clock.advance(3 * 60_000)
  expect(reportsOf(submitted)).toHaveLength(2)
})

test('a worker blocked without a report is collected once the owner answers in its tab', async ($, on) => {
  const { clock, submitted, typed, files, emit, finish, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)[0]).toMatch(/status="blocked">\nThe worker is waiting at an approval/)
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', tail: 'blocked' })
  await emit('w-busy', 'working')
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nAnswered, and done.`
  // The report check finds it while the worker still works; its turn's end then closes the watch.
  await clock.advance(6000 + BATCH_MS)
  const reports = reportsOf(submitted)
  expect(reports).toHaveLength(2)
  expect(reports[1]).toMatch(/status="done">\nAnswered, and done\./)
  expect(jobOf(store, 'w-busy').tail).toBe('early')
  await finish('w-busy')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)).toHaveLength(2)
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
})

test('a worker whose CLI errored is reported at once, and a report it writes after recovering is delivered too', async ($, on) => {
  const { clock, submitted, typed, files, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  await emit('w-busy', 'error')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)[0]).toMatch(/status="error">\nThe worker stopped \(its CLI reported an error\)/)
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', tail: 'blocked' })
  await emit('w-busy', 'working')
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nRecovered, and done.`
  await clock.advance(6000 + BATCH_MS)
  const reports = reportsOf(submitted)
  expect(reports).toHaveLength(2)
  expect(reports[1]).toMatch(/status="done">\nRecovered, and done\./)
})

test('a worker blocked after its early report that ends its turn without a new report sends nothing more', async ($, on) => {
  const { clock, submitted, typed, files, emit, finish, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted)).toHaveLength(2)
  await finish('w-busy')
  await clock.advance(3 * 60_000)
  expect(reportsOf(submitted)).toHaveLength(2)
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
})

test('a tail job whose wait child died is flushed by the sweep', async ($, on) => {
  const { clock, typed, files, kill, status, store } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  const before = typed.length
  await kill('w-busy')
  status['w-busy'] = 'idle'
  await clock.advance(60_000)
  expect(typed.length).toBe(before + 1)
  expect(typed.at(-1)).toMatch(/Messages from your coordinator/)
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
})

test('stop clears the tail: a later block is not reported', async ($, on) => {
  const { clock, submitted, typed, files, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS + 3 * 60_000)
  expect(reportsOf(submitted)).toHaveLength(1)
})

test('a held message to a tail job whose tab is gone is not typed', async ($, on) => {
  const { clock, typed, files, gone, store } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  const before = typed.length
  gone.add('w-busy')
  await clock.advance(3 * 60_000)
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
  expect(typed.length).toBe(before)
})

test('held messages of a tail job whose tab is gone are reported, and queued is cleared', async ($, on) => {
  const { clock, submitted, typed, files, gone, store } = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  expect(jobOf(store, 'w-busy').queued).toHaveLength(1)
  gone.add('w-busy')
  await clock.advance(3 * 60_000)
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
  expect(jobOf(store, 'w-busy').queued ?? []).toEqual([])
  const notice = reportsOf(submitted).at(-1) ?? ''
  expect(notice).toMatch(/1 message\(s\) held for it were not sent, as its tab is gone: .*MESSAGE-/)
})

test('the prune of old jobs and the idle close both leave a watched job alone', async ($, on) => {
  const day = 24 * 60 * 60_000
  const job = {
    name: 'w-tail',
    profile: 'builder',
    cwd: '/repo/wt',
    dir: '/repo/wt/.herdr-agents/w-tail',
    startedAt: 1_000_000 - 30 * day,
    endedAt: 1_000_000 - 8 * day,
    status: 'reported',
    token: 'tok',
    tail: 'early',
  }
  const { clock, store } = await start($, on, {}, { 'jobs:session-1234': { at: 990_000, jobs: { 'w-tail': job } } })
  await clock.settle()
  expect(Object.keys((store.get('jobs:session-1234') as { jobs: object }).jobs)).toEqual(['w-tail'])
})

const stopW = ($: Parameters<typeof start>[0]) => $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-busy' })

const stopStubborn = async ($: Parameters<typeof start>[0], s: Awaited<ReturnType<typeof start>>) => {
  s.stubborn['w-busy'] = 99
  const stopping = stopW($)
  await s.clock.advance(1000)
  return JSON.stringify(await stopping)
}

const sentFor = (s: Awaited<ReturnType<typeof start>>, re: RegExp) => s.submitted.filter(t => re.test(t))

test('a stop drops the blocked notice held after an early report', async ($, on) => {
  const s = await start($, on)
  await spawnBusy($, 'builder')
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nEarly report.`
  await s.clock.advance(2 * 3000 + BATCH_MS)
  expect(reportsOf(s.submitted)).toHaveLength(1)
  await $.turn.start({ text: 'Reading.', turnId: 't1' })
  await s.emit('w-busy', 'blocked')
  await s.clock.advance(60_000)
  expect(JSON.stringify(await stopW($))).toContain('dropped')
  await $.turn.complete(turnEnd('t1'))
  await s.clock.advance(BATCH_MS)
  await s.clock.advance(BATCH_MS)
  expect(sentFor(s, /waits at an approval or question/)).toHaveLength(0)
})

test('a stop drops the gone notice held for a worker whose wait was open', async ($, on) => {
  const s = await start($, on, { closeIdleMinutes: 0 })
  await reportW($, s)
  s.files[`${W}/WAIT.json`] = '{"for":"ci","check":"ci","every":30,"max":720}'
  s.runs.set('/bin/bash -c ci', [{ exitCode: 1 }])
  await s.clock.advance(60_000)
  s.gone.add('w-busy')
  await s.kill('w-busy')
  await s.clock.advance(60_000)
  await $.turn.start({ text: 'Reading.', turnId: 't1' })
  await s.clock.advance(5 * 60_000)
  expect(jobOf(s.store, 'w-busy')).toMatchObject({ closed: true })
  await stopW($)
  await $.turn.complete(turnEnd('t1'))
  await s.clock.advance(BATCH_MS)
  await s.clock.advance(BATCH_MS)
  expect(sentFor(s, /tab is gone while/)).toHaveLength(0)
})

test('a stop drops the held-messages notice of a tail job whose tab is gone', async ($, on) => {
  const s = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await s.clock.advance(6000 + BATCH_MS)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  await $.turn.start({ text: 'Reading.', turnId: 't1' })
  s.gone.add('w-busy')
  await s.clock.advance(3 * 60_000)
  expect(jobOf(s.store, 'w-busy').queued ?? []).toEqual([])
  await stopW($)
  await $.turn.complete(turnEnd('t1'))
  await s.clock.advance(BATCH_MS)
  await s.clock.advance(BATCH_MS)
  expect(sentFor(s, /were not sent, as its tab is gone/)).toHaveLength(0)
})

test('a stop drops the failed report held for a worker that did not start', async ($, on) => {
  const s = await start($, on)
  s.fail.start = 1
  await $.turn.start({ text: 'Reading.', turnId: 't1' })
  await $.tool.call(spawnArgs)
  await s.clock.settle()
  expect(jobOf(s.store, 'w-busy')).toMatchObject({ status: 'reported', reportStatus: 'failed' })
  await stopW($)
  await $.turn.complete(turnEnd('t1'))
  await s.clock.advance(BATCH_MS)
  await s.clock.advance(BATCH_MS)
  expect(reportsOf(s.submitted)).toHaveLength(0)
})

test('a stop whose tab fails to close lets no later report, wake or notice through', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First draft.')
  const out = await stopStubborn($, s)
  expect(out).toContain('closing its tab failed')
  expect(jobOf(s.store, 'w-busy')).toMatchObject({ stopped: true })
  const before = s.typed.length
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nAfter the stop.`
  s.files[`${W}/WAIT.json`] = '{"for":"ci","check":"ci","every":1,"max":60}'
  s.runs.set('/bin/bash -c ci', [{ exitCode: 0 }])
  await s.clock.advance(5 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(sentFor(s, /After the stop\./)).toHaveLength(0)
  s.files[`${W}/RESULT.md`] = 'No token, after the stop.'
  await s.clock.advance(5 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(sentFor(s, /without its token line/)).toHaveLength(0)
  expect(s.typed.length).toBe(before)
})

test('a report written while a stop is closing the tab is not sent', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First draft.')
  const release = s.gate(argv => argv[0] === 'hc' && argv[1] === 'kill')
  const stopping = stopW($)
  await s.clock.settle()
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDuring the close.`
  await s.clock.advance(3 * 60_000)
  await s.clock.advance(BATCH_MS)
  release()
  await stopping
  await s.clock.advance(BATCH_MS)
  expect(sentFor(s, /During the close\./)).toHaveLength(0)
})

test('a message to a worker whose stop left its tab open is refused', async ($, on) => {
  const s = await start($, on)
  await reportW($, s)
  await stopStubborn($, s)
  const out = JSON.stringify(await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Hello again.' }))
  expect(out).toContain('tab is closed')
})

test('a stop while queued messages are being sent after a report sends no report', async ($, on) => {
  const s = await start($, on, codex)
  await spawnBusy($, 'x')
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Also check the docs.' })
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone.`
  const release = s.gate(argv => argv[0] === 'hc' && argv[1] === 'send')
  await s.finish('w-busy')
  await s.clock.advance(3 * 60_000)
  await stopW($)
  release()
  await s.clock.settle()
  await s.clock.advance(BATCH_MS)
  await s.clock.advance(BATCH_MS)
  expect(reportsOf(s.submitted)).toHaveLength(0)
})

test('a tokenless RESULT.md of a later turn gets its own notice though the text is the same', async ($, on) => {
  const s = await start($, on)
  await reportW($, s, 'First draft.')
  const notices = () => sentFor(s, /without its token line/)
  s.files[`${W}/RESULT.md`] = 'Same tokenless text.'
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(notices()).toHaveLength(1)
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Go on.' })
  const token = s.typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nSecond turn report.`
  await s.finish('w-busy')
  await s.clock.advance(BATCH_MS)
  s.files[`${W}/RESULT.md`] = 'Same tokenless text.'
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  expect(notices()).toHaveLength(2)
  await stopAll($, s.clock, ['w-busy'])
})

test('a stop during a flush whose submit fails does not put the dropped report back', async ($, on) => {
  const s = await start($, on)
  await spawnBusy($, 'builder')
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone.`
  const release = s.gate(argv => argv[0] === 'prompt.submit')
  s.refuse.next = 1
  await s.finish('w-busy')
  await s.clock.advance(BATCH_MS)
  await s.clock.settle()
  await stopW($)
  release()
  await s.clock.settle()
  await s.clock.advance(BATCH_MS)
  await s.clock.advance(BATCH_MS)
  await s.clock.advance(60_000)
  expect(reportsOf(s.submitted)).toHaveLength(0)
})

test('a replaced held report keeps the note of messages not sent', async ($, on) => {
  const s = await start($, on, codex)
  await spawnBusy($, 'x')
  const token = s.typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  const release = s.gate(argv => argv.join(' ').startsWith('hc read w-busy --lines 40'))
  s.gone.add('w-busy')
  await s.kill('w-busy')
  await s.clock.advance(60_000)
  const second = s.clock.advance(60_000)
  await s.clock.settle()
  await $.tool.call({ tool: 'mcp__herdr-agents__message', worker: 'w-busy', text: 'Too late.' })
  await $.turn.start({ text: 'Reading.', turnId: 't1' })
  release()
  await second
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nWritten after all.`
  await s.clock.advance(2 * 60_000)
  await $.turn.complete(turnEnd('t1'))
  await s.clock.advance(BATCH_MS)
  const sent = reportsOf(s.submitted)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Written after all.')
  expect(sent[0]).toMatch(/1 message\(s\) held for it were not sent, as it did not finish \(gone\)/)
})

test('the stop result names a report that was held and dropped', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First draft.')
  await $.turn.start({ text: 'Reading.', turnId: 't1' })
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nNever seen.`
  await s.clock.advance(2 * 60_000)
  const out = JSON.stringify(await stopW($))
  expect(out).toContain('still held for you were dropped')
  expect(out).toContain(`${W}/RESULT-${token}.md`)
  await $.turn.complete(turnEnd('t1'))
})

test('a rewrite that changes a still open question replaces its pin', async ($, on) => {
  const s = await start($, on)
  const token = await reportW($, s, 'First.\nDECISION: [Pick] Which one? | A | B')
  s.files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nSecond.\nDECISION: [Pick] Which one? | C | D`
  await s.clock.advance(2 * 60_000)
  await s.clock.advance(BATCH_MS)
  const out = JSON.stringify(await $.tool.call({ tool: 'mcp__herdr-agents__decided', ids: ['D1'], answer: 'x', by: 'owner' }))
  expect(out).toContain('Unpinned 0')
  const d2 = JSON.stringify(await $.tool.call({ tool: 'mcp__herdr-agents__decided', ids: ['D2'], answer: 'C', by: 'owner' }))
  expect(d2).toContain('Unpinned 1')
  await stopAll($, s.clock, ['w-busy'])
})

test('the idle close is not a stop: it marks the tab closed and nothing more', async ($, on) => {
  const s = await start($, on, { closeIdleMinutes: 1 })
  await reportW($, s, 'First draft.')
  await s.emit('w-busy', 'idle')
  await s.clock.advance(2 * 60_000)
  expect(jobOf(s.store, 'w-busy')).toMatchObject({ closed: true })
  expect(jobOf(s.store, 'w-busy').stopped).toBeUndefined()
})

// #191: a worker that leaves a prompt with no report written is a running worker again.
// The count as belowTarget (hooks/target.ts) takes it.
const counted = (store: Map<string, unknown>) =>
  Object.values((store.get('jobs:session-1234') as { jobs: Record<string, Job> }).jobs).filter(j => active(j) && !j.wait).length

test('a worker blocked without a report counts as working once it leaves the prompt', async ($, on) => {
  const { clock, submitted, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  expect(counted(store)).toBe(0)
  await emit('w-busy', 'working')
  await clock.advance(60_000)
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'running' })
  expect(jobOf(store, 'w-busy').tail).toBeUndefined()
  expect(counted(store)).toBe(1)
  // The line the coordinator gets counts it: a second worker's stop adds its own count to the result.
  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'w-other', profile: 'builder', cwd: '/repo/other', task: 'Other.' })
  await clock.advance(BATCH_MS)
  const stop = await $.tool.call({ tool: 'mcp__herdr-agents__stop', worker: 'w-other' })
  expect(JSON.stringify(stop)).toMatch(/\[1 of \d+ workers working/)
  // Blocked again: it is reported again, and stops counting.
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted).filter(r => r.includes('status="blocked"'))).toHaveLength(2)
  expect(counted(store)).toBe(0)
})

test('a worker whose CLI error passes counts as working again', async ($, on) => {
  const { clock, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  await emit('w-busy', 'error')
  await clock.advance(BATCH_MS)
  expect(counted(store)).toBe(0)
  await emit('w-busy', 'working')
  await clock.advance(60_000)
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'running' })
  expect(counted(store)).toBe(1)
})

test('a worker that left a prompt and ends its turn with no report is reported by the quiet rule', async ($, on) => {
  const { clock, submitted, emit } = await start($, on)
  await spawnBusy($, 'builder')
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  await emit('w-busy', 'working')
  await clock.advance(60_000)
  await emit('w-busy', 'idle')
  await clock.advance(10 * 60_000)
  expect(reportsOf(submitted).at(-1)).toMatch(/The worker stopped \(idle, screen unchanged/)
})

test('a worker that left a prompt after its report stays out of the count: the report is out', async ($, on) => {
  const { clock, typed, files, emit, store } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  await emit('w-busy', 'working')
  await clock.advance(60_000)
  expect(jobOf(store, 'w-busy')).toMatchObject({ status: 'reported', tail: 'early' })
  expect(counted(store)).toBe(0)
})

const REFUSES = '⏵ Dangerous rm operation\n│ Auto mode will automatically │\n│ block this request in 2 min │\n'

test('the blocked report says when the prompt refuses itself, and does not ping the person', async ($, on) => {
  const { clock, submitted, toasts, emit, screens } = await start($, on)
  await spawnBusy($, 'builder')
  screens['w-busy'] = REFUSES
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  const report = reportsOf(submitted).at(-1)
  expect(report).toMatch(/refuses itself/)
  expect(report).not.toMatch(/Ask the person/)
  expect(toasts.filter(t => t.includes('w-busy is blocked'))).toHaveLength(0)
})

test('a block after an early report says the same when the prompt refuses itself', async ($, on) => {
  const { clock, submitted, typed, files, toasts, emit, screens } = await start($, on)
  await spawnBusy($, 'builder')
  const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
  files[`${W}/RESULT.md`] = `<!-- report ${token} -->\nDone for now.`
  await clock.advance(6000 + BATCH_MS)
  screens['w-busy'] = REFUSES
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  const report = reportsOf(submitted).at(-1)
  expect(report).toMatch(/After its report.*refuses itself/)
  expect(report).not.toMatch(/Ask the person/)
  expect(toasts.filter(t => t.includes('w-busy is blocked'))).toHaveLength(0)
})

test('words higher up the screen are only a quote: the blocked report still asks the person', async ($, on) => {
  const { clock, submitted, toasts, emit, screens } = await start($, on)
  await spawnBusy($, 'builder')
  screens['w-busy'] = `Issue says it will automatically block this request.\n${'line\n'.repeat(25)}Allow this command?`
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted).at(-1)).toMatch(/Ask the person to answer it there/)
  expect(toasts.filter(t => t.includes('w-busy is blocked'))).toHaveLength(1)
})

test('a screen that cannot be read leaves the blocked report as it was', async ($, on) => {
  const { clock, submitted, emit, fail } = await start($, on)
  await spawnBusy($, 'builder')
  fail.pane = 1
  await emit('w-busy', 'blocked')
  await clock.advance(BATCH_MS)
  expect(reportsOf(submitted).at(-1)).toMatch(/Ask the person to answer it there/)
})
