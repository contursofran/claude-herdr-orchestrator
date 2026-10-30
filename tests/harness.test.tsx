import { expect } from 'claude-code/testing'
import { pause, resting, spawn, start, test } from './harness'

// The kit lets go of what a hook holds past its budget, ten seconds of real time (see CLOCK_HOLD). A test can't wait
// that long, so these rest for 100 ms: what is handed back that often must work as if it were held throughout. Much
// shorter and clock.settle() may never see the hooks quiet.

test('a clock wait handed back while real time passes still comes due, once, at its time', async ($, on) => {
  resting.ms = 100
  try {
    const { clock, calls } = await start($, on)
    await spawn($, ['w-a'])
    await pause(300)
    const lists = () => calls.filter(c => c[1] === 'ls').length
    const before = lists()
    await clock.advance(59_000)
    expect(lists()).toBe(before)
    await clock.advance(2000)
    expect(lists()).toBe(before + 1)
  } finally {
    resting.ms = 5000
  }
})

test("a worker's quiet events stream stays open while real time passes, and still brings its status", async ($, on) => {
  resting.ms = 100
  try {
    const { clock, submitted, streams, finish, typed, files } = await start($, on)
    await spawn($, ['w-a'])
    await pause(300)
    expect(streams.filter(s => s.name === 'w-a')).toHaveLength(1)
    const token = typed[0]?.match(/<!-- report (\S+) -->/)?.[1]
    files['/repo-w-a/.herdr-agents/w-a/RESULT.md'] = `<!-- report ${token} -->\nDone.`
    await finish('w-a')
    await clock.advance(3000)
    expect(submitted.filter(t => t.includes('<herdr-agent name="w-a"'))).toHaveLength(1)
  } finally {
    resting.ms = 5000
  }
})
