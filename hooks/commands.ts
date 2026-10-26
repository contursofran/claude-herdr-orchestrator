import type { EngineInterface } from 'claude-code'
import { allProfiles, BUILT_IN, config, customized, resetSettings, smallTasks, target, turnedOff, userConfigPath } from './config'
import { orchestrate, toggleWrapUp } from './coordinator'
import { openQuestions, pinnedItems } from './owner'
import { cmd, session } from './session'
import { closeSettings, openSettings, settingsOpen } from './settings'
import { toggleSide } from './side'
import { notesFolder, notesInstructions } from './notes'
import { post } from './outbox'
import { jobs } from './state'
import { pruneMerged } from './worktrees'

// The slash commands, all named <prefix><name> (see session.prefix).
export async function registerCommands($: EngineInterface) {
  const prefix = session.prefix
  await $.command.register({ name: `${prefix}config`, description: 'Change the settings: target, built-in profiles, prefix and the rest.' })
  for (const name of ['help', 'h'])
    await $.command.register({
      name: `${prefix}${name}`,
      description: 'How herdr-agents works: commands, panel, profiles and settings.',
      immediate: true,
    })
  await $.command.register({
    name: `${prefix}side`,
    description: 'Open or close the sidebar: the work by issue or PR, what needs you, and a box to answer it.',
    immediate: true,
  })
  await $.command.register({ name: `${prefix}workers`, description: 'List the herdr workers of this session.' })
  await $.command.register({ name: `${prefix}decisions`, description: 'List the questions and to-dos waiting for you.' })
  await $.command.register({ name: `${prefix}prune`, description: 'Remove worktrees whose PR is merged.' })
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
    case 'side':
      return { text: await toggleSide($) }
    case 'notes':
      return writeNotes($)
    case 'prune':
      return prune($)
    case 'update':
      return update($)
    case 'decisions':
      return listDecisions($)
    case 'workers':
      return listWorkers($)
    case 'config':
      if (await settingsOpen($)) {
        await closeSettings($)
        return { text: 'Settings closed.' }
      }
      await openSettings($)
      return { text: `Settings are above the prompt: alt+d to move into them, Done or ${cmd('config')} again to close.` }
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

async function prune($: EngineInterface) {
  const done = await pruneMerged($)
  return { text: done.length ? `Removed ${done.length} merged worktree(s):\n${done.join('\n')}` : 'No merged, clean worktrees to remove.' }
}

// `/hrd-update`: pulls the clone install.sh ran from (recorded in the mod's `clone` file) and runs its
// install.sh again. Running sessions reload the mod by themselves, so the answer says only what changed.
async function update($: EngineInterface) {
  const clone = (await $.fs.read(`${$.plugin.root}/clone`).catch(() => '')).trim()
  if (!clone) return { text: 'Nothing updated: no clone is recorded for herdr-agents. Run ./install.sh from your clone once.' }
  const before = (await run($, ['git', '-C', clone, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
  const pull = await run($, ['git', '-C', clone, 'pull', '--ff-only'], 120_000)
  if (pull.exitCode !== 0)
    return { text: `Update stopped: git pull --ff-only failed in ${clone}, install.sh did not run: ${lastLines(pull.stderr)}` }
  const after = (await run($, ['git', '-C', clone, 'rev-parse', '--short', 'HEAD'])).stdout.trim()
  const install = await run($, [`${clone}/install.sh`], 120_000)
  if (install.exitCode !== 0) return { text: `Update stopped: install.sh failed in ${clone}: ${lastLines(install.stderr)}` }
  const version = JSON.parse(await $.fs.read(`${clone}/.claude-plugin/plugin.json`)).version
  const reload = 'running sessions reload it by themselves.'
  if (before === after) return { text: `herdr-agents is up to date at ${after}, version ${version}. install.sh ran again; ${reload}` }
  return { text: `herdr-agents updated from ${before} to ${after}, version ${version}. Installed; ${reload}` }
}

// Runs a command. One that cannot start, or runs past its timeout, reads as failed, its error as stderr.
async function run($: EngineInterface, argv: string[], timeoutMs = 30_000) {
  return $.process.run(argv, { timeoutMs }).catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
}

// The last three lines of a command's stderr, on one line.
function lastLines(stderr: string) {
  return stderr.trim().split('\n').slice(-3).join(' / ') || 'no output on stderr'
}

async function listDecisions($: EngineInterface) {
  const open = await openQuestions($)
  const items = await pinnedItems($)
  if (open.length === 0 && items.length === 0) return { text: 'Nothing waiting for you.' }
  return {
    text: [
      ...items.map(t => `T${t.id}  ${t.kind === 'do' ? 'to do' : 'to know'}  (${t.from})  ${t.text}`),
      ...open.map(d => `D${d.id}  (${d.from})  ${d.question}`),
    ].join('\n\n'),
  }
}

async function listWorkers($: EngineInterface) {
  const list = Object.values(await jobs($))
  if (list.length === 0) return { text: 'No herdr workers in this session.' }
  return { text: list.map(j => `${j.name}  ${j.profile}  ${j.status}  ${j.cwd}`).join('\n') }
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
        [cmd('side'), 'the sidebar beside the chat: work by issue or PR, what needs you, an answer box'],
        [cmd('decisions'), 'the questions and to-dos waiting for you'],
        [cmd('workers'), "this session's workers"],
        [cmd('prune'), 'remove worktrees whose PR is merged'],
        [cmd('notes'), 'learning notes for the concepts this session worked with (learningNotes setting)'],
        [cmd('update'), 'pull the clone this mod was installed from, and install it again'],
        [cmd('config'), 'change these settings, in the panel above the prompt'],
        [`${cmd('help')}, ${cmd('h')}`, 'this guide'],
      ]),
      '',
      'Panel (above the prompt)',
      '  To-dos the coordinator pinned for you, then its questions, then the workers.',
      '  Answer a question with 1–4 from an empty prompt, or alt+d (ctrl+x tab), arrows and Enter; Esc goes back.',
      '  Details shows every worker; Wrap up / Keep going toggles the wrap-up.',
      `  While ${cmd('side')} is open beside the chat, it shows all of this and the band steps aside.`,
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
      `  ${cmd('config')} changes them. Keys: target, resetAt, statePath, trustRoots, commandPrefix, profiles, disable, smallTasks, playbook, pruneMinutes, closeIdleMinutes, repos, wrapUp, learningNotes. See the README.`,
    ].join('\n'),
  }
}
