import { expect, test } from 'claude-code/testing'
import { command, start, type Answer } from './harness'

// /hrd-update: switches the clone install.sh recorded to main, pulls it, runs its install.sh, and answers in one line.

const CLONE = '/src/herdr'
const HEAD = `git -C ${CLONE} rev-parse --short HEAD`
const BRANCH = `git -C ${CLONE} branch --show-current`
const STATUS = `git -C ${CLONE} status --porcelain`
const CHECKOUT = `git -C ${CLONE} checkout main`
const PULL = `git -C ${CLONE} pull --ff-only origin main`
const INSTALL = `${CLONE}/install.sh`
const VERSION = `${CLONE}/.claude-plugin/plugin.json`
const ok = (stdout = ''): Answer => ({ exitCode: 0, stdout })
const failed = (stderr: string): Answer => ({ exitCode: 1, stderr })

// The mod loaded in a session whose start-up work has run, so nothing of it is left for the test's end.
async function session(...args: Parameters<typeof start>) {
  const started = await start(...args)
  await started.clock.advance(3000)
  return started
}

// The commands run in the clone since `mark`; the board's own git calls in /repo are left out.
const ranInClone = (shell: string[], mark: number) => shell.slice(mark).filter(argv => argv.includes(CLONE))

// The answers to an update: the commit before the pull and after it, and how the pull and install.sh end.
function clone(
  runs: Map<string, Answer[]>,
  {
    before,
    after,
    branch = 'main',
    pull = ok(),
    install = ok(),
  }: { before: string; after: string; branch?: string; pull?: Answer; install?: Answer },
) {
  runs.set(HEAD, [ok(`${before}\n`), ok(`${after}\n`)])
  runs.set(BRANCH, [ok(`${branch}\n`)])
  runs.set(PULL, [pull])
  runs.set(INSTALL, [install])
}

test('hrd-update pulls the recorded clone, runs its install.sh and says the commits and version it reached', async ($, on) => {
  const { files, runs, shell } = await session($, on)
  files[VERSION] = JSON.stringify({ name: 'herdr-agents', version: '0.12.1' })
  clone(runs, { before: 'abc1234', after: 'def5678', pull: ok('Updating abc1234..def5678\n') })
  const mark = shell.length
  expect((await command($, 'hrd-update')).text).toBe(
    'herdr-agents updated from abc1234 to def5678, version 0.12.1. Installed; running sessions reload it by themselves.',
  )
  expect(ranInClone(shell, mark)).toEqual([HEAD, BRANCH, PULL, HEAD, INSTALL])
})

test('when the pull brings nothing new, install.sh still runs and the answer says it is up to date', async ($, on) => {
  const { files, runs, shell } = await session($, on)
  files[VERSION] = JSON.stringify({ name: 'herdr-agents', version: '0.12.1' })
  clone(runs, { before: 'abc1234', after: 'abc1234', pull: ok('Already up to date.\n') })
  const mark = shell.length
  expect((await command($, 'hrd-update')).text).toBe(
    'herdr-agents is up to date at abc1234, version 0.12.1. install.sh ran again; running sessions reload it by themselves.',
  )
  expect(ranInClone(shell, mark)).toEqual([HEAD, BRANCH, PULL, HEAD, INSTALL])
})

test('a clean clone on a feature branch is switched to main first, and the answer says so', async ($, on) => {
  const { files, runs, shell } = await session($, on)
  files[VERSION] = JSON.stringify({ name: 'herdr-agents', version: '0.16.0' })
  clone(runs, { before: '53c331e', after: '50f749a', branch: 'feat/learning-notes' })
  runs.set(STATUS, [ok('')])
  runs.set(CHECKOUT, [ok()])
  const mark = shell.length
  expect((await command($, 'hrd-update')).text).toBe(
    'herdr-agents updated from 53c331e to 50f749a (switched from feat/learning-notes to main), version 0.16.0. Installed; running sessions reload it by themselves.',
  )
  expect(ranInClone(shell, mark)).toEqual([HEAD, BRANCH, STATUS, CHECKOUT, PULL, HEAD, INSTALL])
})

test('a clone on a feature branch with uncommitted changes is left alone', async ($, on) => {
  const { runs, shell } = await session($, on)
  clone(runs, { before: 'abc1234', after: 'abc1234', branch: 'feat/x' })
  runs.set(STATUS, [ok(' M hooks/commands.ts\n')])
  const mark = shell.length
  expect((await command($, 'hrd-update')).text).toBe(
    'Update stopped: /src/herdr is on feat/x with uncommitted changes; commit them or switch it to main.',
  )
  expect(ranInClone(shell, mark)).toEqual([HEAD, BRANCH, STATUS])
})

test('with no clone recorded, nothing runs and the answer says why', async ($, on) => {
  const { recorded, shell } = await session($, on)
  recorded.clone = ''
  const mark = shell.length
  expect((await command($, 'hrd-update')).text).toBe(
    'Nothing updated: no clone is recorded for herdr-agents. Run ./install.sh from your clone once.',
  )
  expect(ranInClone(shell, mark)).toEqual([])
})

test('a failed pull stops before install.sh, and the answer carries the last three lines of its stderr', async ($, on) => {
  const { runs, shell } = await session($, on)
  clone(runs, {
    before: 'abc1234',
    after: 'abc1234',
    pull: failed(
      'From github.com:acme/herdr\nerror: divergent branches\nerror: cannot fast-forward\nfatal: Not possible to fast-forward, aborting.\n',
    ),
  })
  const mark = shell.length
  expect((await command($, 'hrd-update')).text).toBe(
    'Update stopped: git pull --ff-only failed in /src/herdr, install.sh did not run: ' +
      'error: divergent branches / error: cannot fast-forward / fatal: Not possible to fast-forward, aborting.',
  )
  expect(ranInClone(shell, mark)).toEqual([HEAD, BRANCH, PULL])
})

test('a failed install.sh says so with the last lines of its stderr', async ($, on) => {
  const { runs } = await session($, on)
  clone(runs, { before: 'abc1234', after: 'def5678', install: failed('rsync: command not found\n') })
  expect((await command($, 'hrd-update')).text).toBe('Update stopped: install.sh failed in /src/herdr: rsync: command not found')
})

test('a failed step with nothing on its stderr says so', async ($, on) => {
  const { runs } = await session($, on)
  clone(runs, { before: 'abc1234', after: 'def5678', install: { exitCode: 2 } })
  expect((await command($, 'hrd-update')).text).toBe('Update stopped: install.sh failed in /src/herdr: no output on stderr')
})

test('a command that cannot start fails its step, with the error as its reason', async ($, on) => {
  const { runs, shell } = await session($, on)
  clone(runs, { before: 'abc1234', after: 'abc1234', pull: { exitCode: 1, reject: 'spawn git ENOENT' } })
  const mark = shell.length
  expect((await command($, 'hrd-update')).text).toMatch(
    /^Update stopped: git pull --ff-only failed in \/src\/herdr, install.sh did not run: .*spawn git ENOENT$/,
  )
  expect(ranInClone(shell, mark)).toEqual([HEAD, BRANCH, PULL])
})

test('the command is registered, and the guide lists it', async ($, on) => {
  const { registered } = await session($, on)
  expect(registered).toContain('hrd-update')
  expect((await command($, 'hrd-h')).text).toMatch(/\/hrd-update +pull the clone this mod was installed from, and install it again/)
})
