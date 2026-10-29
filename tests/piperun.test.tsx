import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { issueLines } from '../hooks/coordinator'
import type { Settings } from '../types'
import { BATCH_MS, SWEEP_MS } from '../hooks/defaults'
import { oneLine } from '../view/hooks/format'
import { settled, spawn as spawnReviewers, start, stopAll, until } from './harness'

// The PR pipeline's runner: a builder's report with one PR starts a review, a review with changes
// starts a fix round, and an approved, green PR is the one prompt the coordinator gets.

const REPO = 'acme/app-client'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const GREEN = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }]
const CWD = '/repo/wt'
const call = ($: Engine, tool: string, input: Record<string, unknown>) => $.tool.call({ tool: `mcp__herdr-agents__${tool}`, ...input })

const pr = (head: string, extra: Record<string, unknown> = {}) => ({
  state: 'OPEN',
  headRefOid: head,
  title: 'A change',
  statusCheckRollup: GREEN,
  mergeStateStatus: 'CLEAN',
  files: [],
  ...extra,
})

// Starts the harness with the pipeline on, and gives helpers to spawn a worker and make it report.
async function setup(
  $: Engine,
  on: Parameters<typeof start>[1],
  pipeline: Record<string, unknown> = {},
  stored: Record<string, unknown> = {},
  extra: Settings = {},
) {
  const h = await start($, on, { ...extra, pipeline: { enabled: true, ...pipeline } }, stored)
  const tokenOf = (name: string) =>
    h.typed
      .filter(t => t.includes(`/.herdr-agents/${name}/`))
      .at(-1)
      ?.match(/<!-- report (\S+) -->/)?.[1]
  const dirOf = (name: string) => `${CWD}/.herdr-agents/${name}`
  const builder = async (name: string, cwd = CWD) => {
    await call($, 'spawn', { worker: name, profile: 'builder', cwd, task: 'Build it (issue #3).' })
    await settled()
    await h.clock.settle()
  }
  // The worker writes its report and ends its turn.
  const report = async (name: string, header: string, body = 'Done.') => {
    h.files[`${dirOf(name)}/RESULT.md`] = `<!-- report ${tokenOf(name)} -->\n\`\`\`report\n${header}\n\`\`\`\n${body}`
    await h.finish(name)
    await h.clock.settle()
  }
  const started = (name: string) => h.calls.filter(c => c[1] === 'tab' && c[2] === 'create' && c.includes(name)).length
  return { ...h, builder, report, tokenOf, dirOf, started }
}

const said = (submitted: string[]) => submitted.join('\n---\n')

test('a builder report with one PR starts a review and posts nothing; changes start a fix round; approve and green is one prompt', async ($, on) => {
  const t = await setup($, on)
  t.prs[`${REPO}#5`] = pr(A)
  await t.builder('b5')
  await t.report('b5', 'status: done\npr: 5\nsummary: Opened it.')
  await until(t.clock, () => t.started('r5') === 1)
  expect(t.started('r5')).toBe(1)
  // the mod wrote the reviewer's brief
  const review = t.files[`${t.dirOf('r5')}/TASK.md`]
  expect(review).toMatch(/^Review PR #5 \(acme\/app-client\)/)
  expect(review).toContain(`head ${A}`)
  expect(review).toContain('verdict: approve or verdict: changes')
  expect(t.typed.some(p => p.includes(`${t.dirOf('r5')}/TASK.md`))).toBe(true)
  await t.clock.advance(BATCH_MS)
  expect(t.submitted).toEqual([])

  // changes: the builder that wrote the PR is stopped and a fresh one starts with the review's path
  await t.report('r5', `status: done\nverdict: changes\nhead: ${A}\nsummary: One blocker.`, 'Blocker: x.')
  await until(t.clock, () => t.started('f5-1') === 1)
  expect(t.closed).toContain('t-b5')
  const fix = t.files[`${t.dirOf('f5-1')}/TASK.md`]
  expect(fix).toMatch(/^Fix round 1 for PR #5 \(acme\/app-client\)/)
  expect(fix).toContain('First git pull --ff-only.')
  expect(fix).toContain(`${t.dirOf('r5')}/RESULT-${t.tokenOf('r5')}.md`)
  await t.clock.advance(BATCH_MS)
  expect(t.submitted).toEqual([])

  // the fix pushed a new head: a re-review reads only the new diff
  t.prs[`${REPO}#5`] = pr(B)
  await t.report('f5-1', 'status: done\npr: 5\nsummary: Fixed.')
  await until(t.clock, () => t.started('r5-2') === 1)
  const again = t.files[`${t.dirOf('r5-2')}/TASK.md`]
  expect(again).toContain(`Re-review: read only git diff ${A}..HEAD`)
  expect(again).toContain(`${t.dirOf('r5')}/RESULT-${t.tokenOf('r5')}.md`)
  await t.clock.advance(BATCH_MS)
  expect(t.submitted).toEqual([])

  // approve at the head, CI green: the coordinator gets exactly one prompt
  await t.report('r5-2', `status: done\nverdict: approve\nhead: ${B}\nsummary: Good.`)
  await t.clock.advance(BATCH_MS)
  expect(t.submitted).toHaveLength(1)
  const ready = t.submitted[0]!
  expect(ready).toMatch(/^<herdr-pipeline event="ready" pr="5" repo="acme\/app-client" head="bbbbbbbb">/)
  expect(ready).toContain(`gh pr merge 5 -R ${REPO} --squash --delete-branch --match-head-commit ${B}`)
  expect(ready).toContain('Pipeline since your last prompt:')
  expect(ready).toMatch(/- \d\d:\d\d #5 r5 started/)
  expect(ready).toMatch(/- \d\d:\d\d #5 f5-1 started/)
  expect(ready).toContain('</herdr-pipeline>')
  await stopAll($, t.clock, ['f5-1', 'r5-2'])
})

test('approved with CI still running is said in the ready prompt; a gh error is too', async ($, on) => {
  const t = await setup($, on)
  t.prs[`${REPO}#5`] = pr(A, { statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }] })
  await t.builder('b5')
  await t.report('b5', 'status: done\npr: 5\nsummary: Opened it.')
  await until(t.clock, () => t.started('r5') === 1)
  await t.report('r5', `status: done\nverdict: approve\nhead: ${A}\nsummary: Good.`)
  await t.clock.advance(BATCH_MS)
  expect(t.submitted).toHaveLength(1)
  expect(t.submitted[0]).toMatch(/event="ready" pr="5"[^>]*>\nApproved at aaaaaaaa; CI pending\./)
  await stopAll($, t.clock, ['r5'])
})

test('reports the pipeline does not enroll go to the coordinator as before', async ($, on) => {
  const t = await setup($, on)
  t.prs[`${REPO}#5`] = pr(A)
  // a question for the coordinator
  await t.builder('b5')
  await t.report('b5', 'status: done\npr: 5\nask: Base or develop?\nsummary: Opened it.')
  await t.clock.advance(BATCH_MS)
  expect(said(t.submitted)).toContain('<herdr-agent name="b5"')
  expect(t.started('r5')).toBe(0)
  // several PRs, and no PR
  await t.builder('b6', '/repo/wt6')
  t.files['/repo/wt6/.herdr-agents/b6/RESULT.md'] =
    `<!-- report ${t.tokenOf('b6')} -->\n\`\`\`report\nstatus: done\npr: 6, 7\nsummary: Two.\n\`\`\``
  await t.finish('b6')
  await t.clock.advance(BATCH_MS)
  expect(said(t.submitted)).toContain('<herdr-agent name="b6"')
  expect(t.started('r6')).toBe(0)
  // a PR that is not open
  t.prs[`${REPO}#8`] = pr(A, { state: 'MERGED' })
  await t.builder('b8', '/repo/wt8')
  t.files['/repo/wt8/.herdr-agents/b8/RESULT.md'] =
    `<!-- report ${t.tokenOf('b8')} -->\n\`\`\`report\nstatus: done\npr: 8\nsummary: Done.\n\`\`\``
  await t.finish('b8')
  await t.clock.advance(BATCH_MS)
  expect(said(t.submitted)).toContain('<herdr-agent name="b8"')
  expect(t.started('r8')).toBe(0)
  expect(said(t.submitted)).not.toContain('herdr-pipeline')
  await stopAll($, t.clock, ['b5', 'b6', 'b8'])
})

test('a reviewer without a verdict, or stopped by hand, hands the PR back with one prompt', async ($, on) => {
  const t = await setup($, on)
  t.prs[`${REPO}#5`] = pr(A)
  await t.builder('b5')
  await t.report('b5', 'status: done\npr: 5\nsummary: Opened it.')
  await until(t.clock, () => t.started('r5') === 1)
  await t.report('r5', 'status: done\nsummary: Looks fine.')
  await t.clock.advance(BATCH_MS)
  expect(t.submitted).toHaveLength(1)
  expect(t.submitted[0]).toMatch(/<herdr-pipeline event="handed" pr="5"/)
  expect(t.submitted[0]).toContain('Handed back to you: no verdict.')
  expect(t.submitted[0]).toContain(`${t.dirOf('r5')}/RESULT-`)

  // the worktree is the coordinator's again
  const spawned = await call($, 'spawn', { worker: 'x1', profile: 'reviewer', cwd: CWD, task: 'x' })
  expect(JSON.stringify(spawned)).not.toMatch(/run by the pipeline/)
  await stopAll($, t.clock, ['x1'])
})

test('a step that cannot start hands the PR back with the reason', async ($, on) => {
  const t = await setup($, on, {}, {}, { disable: ['reviewer'] })
  t.prs[`${REPO}#5`] = pr(A)
  await t.builder('b5')
  await t.report('b5', 'status: done\npr: 5\nsummary: Opened it.')
  await t.clock.advance(BATCH_MS)
  expect(t.started('r5')).toBe(0)
  expect(t.submitted).toHaveLength(1)
  expect(t.submitted[0]).toMatch(/event="handed" pr="5"/)
  expect(t.submitted[0]).toContain('could not start r5: reviewer is turned off')
  await stopAll($, t.clock, ['b5'])
})

test('stopping the worker a pipe waits for hands the PR back', async ($, on) => {
  const t = await setup($, on)
  t.prs[`${REPO}#5`] = pr(A)
  await t.builder('b5')
  await t.report('b5', 'status: done\npr: 5\nsummary: Opened it.')
  await until(t.clock, () => t.started('r5') === 1)
  await call($, 'stop', { worker: 'r5' })
  await t.clock.advance(BATCH_MS)
  expect(t.submitted).toHaveLength(1)
  expect(t.submitted[0]).toContain('Handed back to you: stopped by the coordinator.')
})

test("the pipeline's worktree is closed to the coordinator's spawns until the PR is released", async ($, on) => {
  const t = await setup($, on)
  t.prs[`${REPO}#5`] = pr(A)
  await t.builder('b5')
  await t.report('b5', 'status: done\npr: 5\nsummary: Opened it.')
  await until(t.clock, () => t.started('r5') === 1)

  const denied = await call($, 'spawn', { worker: 'x1', profile: 'builder', cwd: CWD, task: 'x' })
  expect(JSON.stringify(denied)).toMatch(
    /PR #5 is run by the pipeline \(stage review\); call pipeline with action release first, or message its worker/,
  )

  expect(JSON.stringify(await call($, 'pipeline', { action: 'status' }))).toMatch(
    /- #5 · head aaaaaaa · review pending · CI unknown · review by r5/,
  )
  expect(JSON.stringify(await call($, 'pipeline', { action: 'resume', pr: 5 }))).toMatch(/not handed back/)
  expect(JSON.stringify(await call($, 'pipeline', { action: 'release', pr: 9 }))).toMatch(/PR #9 is not in the pipeline/)
  expect(JSON.stringify(await call($, 'pipeline', { action: 'release', pr: 5 }))).toMatch(/Released PR #5/)

  // r5 reports to the coordinator as usual now
  await t.report('r5', `status: done\nverdict: approve\nhead: ${A}\nsummary: Good.`)
  await t.clock.advance(BATCH_MS)
  expect(said(t.submitted)).toContain('<herdr-agent name="r5"')
  expect(said(t.submitted)).not.toContain('herdr-pipeline')
  expect(JSON.stringify(await call($, 'pipeline', { action: 'status' }))).toMatch(/No PR is in the pipeline/)
  const allowed = await call($, 'spawn', { worker: 'x1', profile: 'reviewer', cwd: CWD, task: 'x' })
  expect(JSON.stringify(allowed)).not.toMatch(/run by the pipeline/)
  await stopAll($, t.clock, ['x1'])
})

test('a handed PR is put back with resume; add enrolls a PR built by hand', async ($, on) => {
  const t = await setup($, on)
  t.prs[`${REPO}#5`] = pr(A)
  await t.builder('b5')
  await t.report('b5', 'status: done\npr: 5\nsummary: Opened it.')
  await until(t.clock, () => t.started('r5') === 1)
  await t.report('r5', 'status: done\nsummary: Fine.')
  expect(JSON.stringify(await call($, 'pipeline', { action: 'status' }))).toMatch(/- #5 · handed \d\d:\d\d: no verdict/)
  const back = await call($, 'pipeline', { action: 'resume', pr: 5 })
  expect(JSON.stringify(back)).toMatch(/Resumed PR #5/)
  await until(t.clock, () => t.started('r5-2') === 1)
  expect(t.started('r5-2')).toBe(1)

  // add: needs the worktree, and an open PR
  expect(JSON.stringify(await call($, 'pipeline', { action: 'add', pr: 7 }))).toMatch(/cwd is required/)
  expect(JSON.stringify(await call($, 'pipeline', { action: 'add', pr: 7, cwd: '/repo/wt7' }))).toMatch(/gh could not read PR #7/)
  t.prs[`${REPO}#7`] = pr(B)
  const added = await call($, 'pipeline', { action: 'add', pr: 7, cwd: '/repo/wt7' })
  expect(JSON.stringify(added)).toMatch(/PR #7 is in the pipeline/)
  await until(t.clock, () => t.started('r7') === 1)
  expect(t.started('r7')).toBe(1)
  expect(JSON.stringify(await call($, 'pipeline', { action: 'add', pr: 7, cwd: '/repo/wt7' }))).toMatch(/in the pipeline already/)
  await stopAll($, t.clock, ['r5-2', 'r7'])
})

test('at the worker cap a step waits and starts when a report frees a slot; a reload starts a stored step once', async ($, on) => {
  const t = await setup($, on, { cap: 1 }, {}, { target: 2 })
  t.prs[`${REPO}#5`] = pr(A)
  // w-busy holds the only slot
  await spawnReviewers($, ['w-busy'], '/repo-w-busy', t.clock)
  await t.builder('b5')
  // b5 holds none once it has reported, but w-busy does: the review waits
  await t.report('b5', 'status: done\npr: 5\nsummary: Opened it.')
  await t.clock.advance(BATCH_MS)
  expect(t.started('r5')).toBe(0)
  expect(t.submitted).toEqual([])
  // the waiting step counts as a busy worker: one running and one waiting meet the target of 2
  const stopped = await call($, 'stop', { worker: 'b5' })
  expect(JSON.stringify(stopped)).not.toMatch(/Start \d+ more/)

  // w-busy reports and frees the slot: the review starts, once
  t.files['/repo-w-busy/.herdr-agents/w-busy/RESULT.md'] = `<!-- report ${
    t.typed
      .filter(p => p.includes('/w-busy/'))
      .at(-1)
      ?.match(/<!-- report (\S+) -->/)?.[1]
  } -->\nDone.`
  await t.finish('w-busy')
  await until(t.clock, () => t.started('r5') === 1)
  expect(t.started('r5')).toBe(1)
  await t.clock.advance(SWEEP_MS * 2)
  expect(t.started('r5')).toBe(1)
  await stopAll($, t.clock, ['r5'])
})

test('a stored pipe with a waiting step starts it once after a reload, and not again on the next tick', async ($, on) => {
  const pipe = {
    key: `${REPO}#9`,
    repo: REPO,
    pr: 9,
    cwd: '/repo/wt9',
    stage: 'review',
    head: A,
    approved: false,
    ci: 'unknown',
    round: 0,
    failedRounds: 0,
    spawns: 1,
    writer: 'b9',
    worker: 'r9',
    waiting: [{ kind: 'spawn', role: 'review', profile: 'reviewer', worker: 'r9' }],
    done: [`review@${A}`],
    log: [],
    since: 1,
  }
  const t = await setup($, on, {}, { 'pipes:session-1234': { at: 999_000, pipes: { [pipe.key]: pipe } } })
  await until(t.clock, () => t.started('r9') === 1)
  expect(t.started('r9')).toBe(1)
  expect(t.files['/repo/wt9/.herdr-agents/r9/TASK.md']).toMatch(/^Review PR #9 /)
  await t.clock.advance(SWEEP_MS * 2)
  expect(t.started('r9')).toBe(1)
  expect(JSON.stringify(await call($, 'pipeline', { action: 'status' }))).toMatch(
    /- #9 · head aaaaaaa · review pending · CI unknown · review by r9/,
  )
  await stopAll($, t.clock, ['r9'])
})

test('the pipeline is off unless enabled: reports are posted and the tool says so', async ($, on) => {
  const h = await start($, on, {})
  await call($, 'spawn', { worker: 'b5', profile: 'builder', cwd: CWD, task: 'x' })
  await settled()
  await h.clock.settle()
  const token = h.typed.at(-1)?.match(/<!-- report (\S+) -->/)?.[1]
  h.prs[`${REPO}#5`] = pr(A)
  h.files[`${CWD}/.herdr-agents/b5/RESULT.md`] = `<!-- report ${token} -->\n\`\`\`report\nstatus: done\npr: 5\nsummary: Opened it.\n\`\`\``
  await h.finish('b5')
  await h.clock.advance(BATCH_MS)
  expect(said(h.submitted)).toContain('<herdr-agent name="b5"')
  expect(h.calls.some(c => c.includes('r5'))).toBe(false)
  expect(JSON.stringify(await call($, 'pipeline', { action: 'status' }))).toMatch(/the pipeline is off/)
  await stopAll($, h.clock, ['b5'])
})

test('the view draws a pipeline prompt as one line', () => {
  const text =
    '<herdr-pipeline event="ready" pr="5" repo="a/b" head="aaaaaaaa">\nApproved at aaaaaaaa; CI pass. Merge it.\nPipeline since your last prompt:\n- 01:12 #5 r5 started\n</herdr-pipeline>'
  expect(oneLine(text)).toBe('⛓ #5 ready: Approved at aaaaaaaa; CI pass. Merge it.')
})

test('the playbook hands review and fix rounds to the pipeline only while it is on', () => {
  const steps = ['spawn `builder` with the issue', "then `reviewer` on the builder's PR"]
  const on = issueLines(steps, true, new Set(), 'deepseek')
  expect(on).toMatch(/- Each issue: spawn `builder` with the issue\. Small, well-defined tasks may go to `deepseek`\./)
  expect(on).toMatch(/- PRs: when a builder reports one PR, the mod runs review, fix rounds and CI for it/)
  expect(on).toContain('`pipeline release` takes one back')
  expect(on).not.toContain('Send blockers to a fresh builder')
  const off = issueLines(steps, false, new Set(['debugger']))
  expect(off).toContain('Send blockers to a fresh builder')
  expect(off).toContain('then `reviewer` on')
  expect(off).toContain('ask the owner with ask_owner')
  expect(off).not.toContain('herdr-pipeline')
})
