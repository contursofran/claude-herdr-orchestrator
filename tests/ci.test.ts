import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { ciOf, prState } from '../hooks/ci'

// The check roll-up and the one `gh pr view` call the pipeline reads a PR with (ci.ts).

const done = (conclusion: string) => ({ __typename: 'CheckRun', status: 'COMPLETED', conclusion })

test('ciOf rolls the checks up to one word', () => {
  expect(ciOf([])).toBe('none')
  expect(ciOf([done('SUCCESS'), done('FAILURE')])).toBe('fail')
  expect(ciOf([{ __typename: 'StatusContext', state: 'ERROR' }])).toBe('fail')
  expect(ciOf([done('SUCCESS'), { __typename: 'CheckRun', status: 'IN_PROGRESS' }])).toBe('pending')
  expect(ciOf([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('pending')
  expect(ciOf([done('SUCCESS'), { __typename: 'StatusContext', state: 'SUCCESS' }])).toBe('pass')
})

// A stand-in for the engine: only process.run, which answers the one gh call and records it.
function fake(reply: { exitCode: number; stdout?: string; stderr?: string }) {
  const argvs: string[][] = []
  const $ = {
    process: {
      run: async (argv: string[]) => {
        argvs.push(argv)
        return { stdout: '', stderr: '', ...reply }
      },
    },
  } as unknown as EngineInterface
  return { $, argvs }
}

test('prState reads the PR in one gh call', async () => {
  const { $, argvs } = fake({
    exitCode: 0,
    stdout: JSON.stringify({
      state: 'OPEN',
      headRefOid: 'abc1234def',
      title: 'Add keys',
      statusCheckRollup: [done('SUCCESS')],
      mergeStateStatus: 'CLEAN',
      files: [{ path: 'a.ts' }, { path: 'b/c.ts' }],
    }),
  })
  expect(await prState($, 'acme/app', 7)).toEqual({
    state: 'OPEN',
    head: 'abc1234def',
    title: 'Add keys',
    ci: 'pass',
    checks: [done('SUCCESS')],
    mergeState: 'CLEAN',
    files: ['a.ts', 'b/c.ts'],
  })
  expect(argvs).toEqual([
    ['gh', 'pr', 'view', '7', '-R', 'acme/app', '--json', 'state,headRefOid,title,statusCheckRollup,mergeStateStatus,files'],
  ])
})

test('prState fills defaults for a PR with no checks or files', async () => {
  const { $ } = fake({ exitCode: 0, stdout: JSON.stringify({ state: 'MERGED' }) })
  expect(await prState($, 'acme/app', 7)).toEqual({
    state: 'MERGED',
    head: '',
    title: '',
    ci: 'none',
    checks: [],
    mergeState: '',
    files: [],
  })
})

test('prState throws with the first line of what gh printed when it fails', async () => {
  const { $ } = fake({ exitCode: 1, stderr: 'no pull request found\nmore' })
  await expect(prState($, 'acme/app', 99)).rejects.toThrow('no pull request found')
})
