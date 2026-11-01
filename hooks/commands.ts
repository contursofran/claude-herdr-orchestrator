import type { EngineInterface } from 'claude-code'
import { allProfiles, BUILT_IN, config, customized, resetSettings, smallTasks, target, turnedOff, userConfigPath } from './config'
import { orchestrate, toggleWrapUp } from './coordinator'
import { cmd, session } from './session'
import { notesFolder, notesInstructions } from './notes'
import { post } from './outbox'

// The slash commands, all named <prefix><name> (see session.prefix).
export async function registerCommands($: EngineInterface) {
  const prefix = session.prefix
  await $.command.register({ name: `${prefix}config`, description: 'Where to change the settings.' })
  for (const name of ['help', 'h'])
    await $.command.register({
      name: `${prefix}${name}`,
      description: 'How herdr-agents works: commands, panel, profiles and settings.',
      immediate: true,
    })
  await $.command.register({ name: `${prefix}update`, description: 'Pull the clone this mod was installed from and install it again.' })
  await $.command.register({
    name: `${prefix}orchestrate`,
    description: 'Make this session the coordinator of worker agents for this folder, with a goal.',
    argumentHint: '<goal, e.g. the issues labelled ready>',
  })
  await $.command.register({
    name: `${prefix}notes`,
    description: 'Leave learning notes for the concepts this session worked with (needs learningNotes in the settings).',
  })
  await $.command.register({
    name: `${prefix}wrap-up`,
    description: `Start no new herdr workers; the running ones finish. ${cmd('wrap-up')} off ends it.`,
    argumentHint: '[off]',
    immediate: true,
  })
}

// Commands are named at session start, so one hook answers them all; undefined for
// any other command.
export async function runCommand($: EngineInterface, command: string, args: string) {
  const prefix = session.prefix
  if (!command.startsWith(prefix)) return undefined
  switch (command.slice(prefix.length)) {
    case 'orchestrate':
      return orchestrate($, args)
    case 'wrap-up':
      return { text: await toggleWrapUp($, !/^(off|resume)$/i.test(args.trim())) }
    case 'notes':
      return writeNotes($)
    case 'update':
      return update($)
    case 'config':
      return {
        text: `The settings are in the Herdr app: the sliders button in the strip, or ctrl+cmd+, in the coordinator layout. By hand: ${await userConfigPath($)}, with ${session.cwd}/.claude/herdr-agents.json over it.`,
      }
    case 'help':
    case 'h':
      return help($)
    default:
      return undefined
  }
}

// The notes prompt goes through the outbox: a command cannot submit a prompt while it runs.
async function writeNotes($: EngineInterface) {
  const folder = await notesFolder($)
  if (!folder)
    return { text: 'Learning notes are off. Set `learningNotes` in herdr-agents.json: {"enabled": true, "vault": "~/path/to/vault"}.' }
  await post($, `<herdr-context>${notesInstructions(folder)}</herdr-context>`)
  return { text: `Leaving learning notes in ${folder}.` }
}

// `/hrd-update`: switches the clone install.sh ran from (recorded in the mod's `clone` file) to main,
// pulls it and runs its install.sh again. Releases land on main, so a clone left on a feature branch
// still updates. Running sessions reload the mod by themselves, so the answer says only what changed.
async function update($: EngineInterface) {
  const clone = (await $.fs.read(`${$.plugin.root}/clone`).catch(() => '')).trim()
  if (!clone) return { text: 'Nothing updated: no clone is recorded for herdr-agents. Run ./install.sh from your clone once.' }
  const before = (await run($, ['git', '-C', clone, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
  const branch = (await run($, ['git', '-C', clone, 'branch', '--show-current'])).stdout.trim()
  if (branch !== 'main') {
    const dirty = (await run($, ['git', '-C', clone, 'status', '--porcelain'])).stdout.trim()
    if (dirty)
      return {
        text: `Update stopped: ${clone} is on ${branch || 'a detached HEAD'} with uncommitted changes; commit them or switch it to main.`,
      }
    const checkout = await run($, ['git', '-C', clone, 'checkout', 'main'])
    if (checkout.exitCode !== 0)
      return { text: `Update stopped: git checkout main failed in ${clone}, install.sh did not run: ${lastLines(checkout.stderr)}` }
  }
  const pull = await run($, ['git', '-C', clone, 'pull', '--ff-only', 'origin', 'main'], 120_000)
  if (pull.exitCode !== 0)
    return { text: `Update stopped: git pull --ff-only failed in ${clone}, install.sh did not run: ${lastLines(pull.stderr)}` }
  const after = (await run($, ['git', '-C', clone, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
  const install = await run($, [`${clone}/install.sh`], 120_000)
  if (install.exitCode !== 0) return { text: `Update stopped: install.sh failed in ${clone}: ${lastLines(install.stderr)}` }
  const version = JSON.parse(await $.fs.read(`${clone}/.claude-plugin/plugin.json`)).version
  const reload = 'running sessions reload it by themselves.'
  const switched = branch === 'main' ? '' : ` (switched from ${branch || 'a detached HEAD'} to main)`
  if (before === after)
    return { text: `herdr-agents is up to date at ${after}${switched}, version ${version}. install.sh ran again; ${reload}` }
  return { text: `herdr-agents updated from ${before} to ${after}${switched}, version ${version}. Installed; ${reload}` }
}

// Runs a command. One that cannot start, or runs past its timeout, reads as failed, its error as stderr.
async function run($: EngineInterface, argv: string[], timeoutMs = 30_000) {
  return $.process.run(argv, { timeoutMs }).catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
}

// The last three lines of a command's stderr, on one line.
function lastLines(stderr: string) {
  return stderr.trim().split('\n').slice(-3).join(' / ') || 'no output on stderr'
}

function commandRows(rows: [string, string][]) {
  const width = Math.max(...rows.map(([name]) => name.length)) + 3
  return rows.map(([name, what]) => `  ${name.padEnd(width)}${what}`)
}

// The guide the help command prints, with this folder's settings filled in.
async function help($: EngineInterface) {
  const c = await config($)
  const all = await allProfiles($)
  const off = await turnedOff($)
  const small = await smallTasks($)
  const { statePath, limit } = await resetSettings($)
  const tags = (name: string) =>
    [customized(name, all[name]) ? 'customized' : '', off.has(name) ? 'off' : '']
      .filter(Boolean)
      .map(tag => ` · ${tag}`)
      .join('')
  const profileRows = (title: string, names: string[]) =>
    names.length ? [`  ${title}`, ...names.map(name => `    ${name.padEnd(12)} ${all[name]?.note ?? all[name]?.kind}${tags(name)}`)] : []
  return {
    text: [
      'This session coordinates worker agents that run in herdr tabs; their reports come back here as prompts.',
      '',
      'Start',
      ...commandRows([
        [`${cmd('orchestrate')} <goal>`, `make this session the coordinator, e.g. ${cmd('orchestrate')} the issues labelled ready`],
        [`${cmd('wrap-up')} [off]`, 'start no new workers and let the running ones finish; off resumes'],
        [cmd('notes'), 'learning notes for the concepts this session worked with (learningNotes setting)'],
        [cmd('update'), 'pull the clone this mod was installed from, and install it again'],
        [cmd('config'), 'where to change these settings'],
        [`${cmd('help')}, ${cmd('h')}`, 'this guide'],
      ]),
      '',
      'Panel (above the prompt)',
      '  To-dos the coordinator pinned for you, then its questions, then the workers.',
      '  Answer a question with 1–4 from an empty prompt, or alt+d (ctrl+x tab), arrows and Enter; Esc goes back.',
      '  Details shows every worker; Wrap up / Keep going toggles the wrap-up.',
      '',
      'Profiles (spawn takes one)',
      ...profileRows('Built in', BUILT_IN),
      ...profileRows(
        'Yours',
        Object.keys(all).filter(name => !BUILT_IN.includes(name)),
      ),
      `  Small tasks go to ${small ?? 'nobody (smallTasks)'}`,
      '',
      'Settings',
      `  ${await userConfigPath($)}, with ${session.cwd}/.claude/herdr-agents.json over it`,
      `  target ${await target($)} workers · state file ${statePath} · compact past ${limit} tokens · prefix ${session.prefix}${c.wrapUp === true ? ' · wrapUp on everywhere' : ''}`,
      `  Keys: target, resetAt, statePath, trustRoots, commandPrefix, profiles, disable, smallTasks, playbook, pruneMinutes, closeIdleMinutes, repos, wrapUp, learningNotes, timeComments. See the README.`,
    ].join('\n'),
  }
}
