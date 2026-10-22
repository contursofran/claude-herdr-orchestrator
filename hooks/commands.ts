import type { EngineInterface } from 'claude-code'
import { allProfiles, BUILT_IN, config, customized, resetSettings, smallTasks, target, turnedOff, userConfigPath } from './config'
import { orchestrate, toggleWrapUp } from './coordinator'
import { openQuestions, pinnedItems } from './owner'
import { cmd, session } from './session'
import { closeSettings, openSettings, settingsOpen } from './settings'
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
  await $.command.register({ name: `${prefix}workers`, description: 'List the herdr workers of this session.' })
  await $.command.register({ name: `${prefix}decisions`, description: 'List the questions and to-dos waiting for you.' })
  await $.command.register({ name: `${prefix}prune`, description: 'Remove worktrees whose PR is merged.' })
  await $.command.register({
    name: `${prefix}orchestrate`,
    description: 'Make this session the coordinator of worker agents for this folder, with a goal.',
    argumentHint: '<goal, e.g. the issues labelled ready>',
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
    case 'prune':
      return prune($)
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

async function prune($: EngineInterface) {
  const done = await pruneMerged($)
  return { text: done.length ? `Removed ${done.length} merged worktree(s):\n${done.join('\n')}` : 'No merged, clean worktrees to remove.' }
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
        [cmd('decisions'), 'the questions and to-dos waiting for you'],
        [cmd('workers'), "this session's workers"],
        [cmd('prune'), 'remove worktrees whose PR is merged'],
        [cmd('config'), 'change these settings, in the panel above the prompt'],
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
      `  ${cmd('config')} changes them. Keys: target, resetAt, statePath, trustRoots, commandPrefix, profiles, disable, smallTasks, playbook, pruneMinutes, closeIdleMinutes, repos, wrapUp. See the README.`,
    ].join('\n'),
  }
}
