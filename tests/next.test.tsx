import { expect } from 'claude-code/testing'
import { settled, start, stopAll, test, until } from './harness'

// The board's Next list (#278): the coordinator's Ready list through set_next, in order, until a worker starts on an issue.

const BOARD = '/home/t/.herdr-agents/board/session-1234.json'
const setNext = ($: Parameters<typeof start>[0], items: unknown) => $.tool.call({ tool: 'mcp__herdr-agents__set_next', items } as never)
const said = (out: unknown) => JSON.stringify(out)

test('the list goes on the board in order, with links in the folder repo, and leaves an issue once a worker starts it', async ($, on) => {
  const { clock, files } = await start($, on)
  const next = () => JSON.parse(files[BOARD] ?? '{}').next as { key: string; label: string; url: string | null; planned: boolean }[]
  await clock.advance(3000) // the folder's repo is learnt at the first tick
  const out = await setNext($, [
    { issue: '#218', title: 'PR links on the board', planned: true },
    { issue: 'acme/app-server#4', title: 'Server side' },
    { issue: '#218', title: 'Said twice' },
  ])
  expect(said(out)).toContain('acme/app-client#218, acme/app-server#4')
  await until(clock, () => next()?.length === 2)
  expect(next()).toEqual([
    {
      key: 'acme/app-client#218',
      label: 'issue #218',
      title: 'PR links on the board',
      repo: 'acme/app-client',
      issue: 218,
      url: 'https://github.com/acme/app-client/issues/218',
      planned: true,
    },
    {
      key: 'acme/app-server#4',
      label: 'issue #4',
      title: 'Server side',
      repo: 'acme/app-server',
      issue: 4,
      url: 'https://github.com/acme/app-server/issues/4',
      planned: false,
    },
  ])

  await $.tool.call({ tool: 'mcp__herdr-agents__spawn', worker: 'b-218', profile: 'builder', cwd: '/repo', task: '# Build #218: PR links' })
  await settled()
  await until(clock, () => next()?.length === 1)
  expect(next().map(x => x.key)).toEqual(['acme/app-server#4'])

  expect(said(await setNext($, []))).toContain('Cleared')
  await until(clock, () => next()?.length === 0)
  expect(next()).toEqual([])
  await stopAll($, clock, ['b-218'])
})

test('a bad item, or more than the next few, is refused and leaves the list as it was', async ($, on) => {
  const { clock, files } = await start($, on)
  await setNext($, [{ issue: '#1', title: 'One' }])
  expect(said(await setNext($, [{ issue: '218', title: 'No hash' }]))).toContain('item 1: give issue as #123')
  expect(said(await setNext($, [{ issue: '#2', title: '  ' }]))).toContain('item 1')
  expect(
    said(
      await setNext(
        $,
        Array.from({ length: 11 }, (_, i) => ({ issue: `#${i + 1}`, title: 'x' })),
      ),
    ),
  ).toContain('at most 10')
  expect(said(await setNext($, undefined))).toContain('items must be a list')
  await clock.advance(3000)
  await until(clock, () => JSON.parse(files[BOARD] ?? '{}').next?.length === 1)
  expect(JSON.parse(files[BOARD] ?? '{}').next.map((x: { issue: number }) => x.issue)).toEqual([1])
})
