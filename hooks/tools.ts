import type { EngineInterface } from 'claude-code'
import { profiles } from './config'

type ToolSpec = Parameters<EngineInterface['tool']['register']>[0]

// The spawn tool's spec; its description lists the profiles in the config now.
export async function spawnSpec($: EngineInterface): Promise<ToolSpec> {
  const list = Object.entries(await profiles($))
    .map(([name, p]) => `${name} = ${p.note ?? p.kind}`)
    .join(', ')
  return {
    name: 'spawn',
    description: [
      'Start a worker agent in a new herdr tab, on any provider, and return at once.',
      `Profiles: ${list}.`,
      'The worker reads the task, works in `cwd` and writes RESULT.md.',
      'With `branch` (and `repo` when it is not this folder), the mod fetches and creates the worktree at ../<repo>-wt/<branch> off origin/<base>. It returns status starting at once; if the worker cannot start, a failed report arrives instead.',
      'Its report arrives later as a <herdr-agent> message; do not poll for it.',
      'The task must be self-contained: the worker shares none of this conversation.',
      'Keep it short: point to a plan, issue or earlier report by its path or link instead of copying it in.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        worker: {
          type: 'string',
          description:
            'Unique short name of at most 32 characters: lowercase letters, digits and dashes, not shaped like a terminal address (t7). Also the tab label.',
        },
        profile: { type: 'string', description: 'A profile name.' },
        cwd: {
          type: 'string',
          description: "An existing folder (a fix round in the PR's worktree). Give branch instead for a new one.",
        },
        branch: { type: 'string', description: 'A git branch: the mod creates (or reuses) its worktree and the worker runs there.' },
        repo: { type: 'string', description: 'The repo checkout for branch, absolute or relative to this folder; default this folder.' },
        base: { type: 'string', description: "The branch to start a new branch from; default the repo's origin/HEAD branch, else main." },
        task: { type: 'string', description: 'The brief, in Markdown; files it builds on (a PLAN.md) by absolute path.' },
      },
      required: ['worker', 'profile', 'task'],
    },
    isDeferred: false,
  }
}

// What the engine last got for spawn. A changed tool list rewrites the prompt cache, so spawn is
// registered again only when its spec changed; the new one applies from the next prompt on.
let lastSpawn = ''
export async function refreshSpawnTool($: EngineInterface, force = false) {
  const spec = await spawnSpec($)
  const key = JSON.stringify(spec)
  if (!force && key === lastSpawn) return
  await $.tool.register(spec)
  lastSpawn = key
}

// The tools the coordinator's model calls, as mcp__herdr-agents__<name>.
export async function registerTools($: EngineInterface) {
  await refreshSpawnTool($, true)
  await $.tool.register({
    name: 'message',
    description:
      'Send a follow-up to a herdr worker started with spawn, such as a correction or an answer. Review fixes go to a fresh builder instead (stop, then spawn). It continues in the same tab with its context; its next report arrives as a <herdr-agent> message. Works while the worker is busy too: a Claude worker takes it at its next step, others get it the moment they report. A worker blocked at a question can be answered; one blocked at a permission or auth prompt cannot, the person answers that in its tab.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string' },
        text: { type: 'string', description: 'The message, self-contained.' },
      },
      required: ['worker', 'text'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'stop',
    description: 'Stop a herdr worker and close its tab.',
    inputSchema: { type: 'object', properties: { worker: { type: 'string' } }, required: ['worker'] },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'ask_owner',
    description: [
      'Pin a question only the person can answer (a product rule, a design choice, an approval) above their prompt, with a toast.',
      'Use it for every such question instead of leaving it inside a status message, where it gets lost among reports.',
      'Questions workers write as "DECISION:" lines are pinned already. Give short options: the person picks one on the band and it comes back as a <herdr-decision> prompt, already unpinned.',
      'Returns its id (D1, D2…); call decided with their answer when they answer in chat instead.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A 2-4 word name for the decision list, such as "Login flow".' },
        question: { type: 'string', description: 'The question, with enough context to answer it from the band.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short answers the person can pick with a click or the arrows and Enter (2-4).',
        },
        recommended: { type: 'number', description: 'Index in options of your recommendation.' },
        from: { type: 'string', description: 'The worker, issue or PR it is about.' },
      },
      required: ['question'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'decided',
    description: [
      "Unpin questions from ask_owner or DECISION: lines: ones the person answered in chat, or a worker's question you settle yourself because it is not theirs (not a product rule, design choice or approval).",
      'The band shows the person the answer for a while, so they can overrule it. Call it once per distinct answer.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Ids such as "D3".' },
        answer: { type: 'string', description: 'The answer, short, such as "CI runs it".' },
        by: {
          type: 'string',
          enum: ['coordinator', 'owner'],
          description: 'Who answered: you (coordinator) or the person in chat (owner).',
        },
      },
      required: ['ids', 'answer', 'by'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'pin_for_owner',
    description: [
      'Pin one line at the top of the band above the person\'s prompt: something they have to do (kind "do": test a build at a URL, merge a PR that waits for them, restart something, answer a worker in its tab) or should know (kind "know": news, a blocker you cannot fix).',
      'Use it whenever a report or status message would otherwise carry such an item, so it does not scroll away. One item per call; questions go to ask_owner instead.',
      'It stays until you unpin it with unpin_for_owner or the person ticks it off; a ticked "do" item comes back as a <herdr-owner-done> prompt.',
      'Returns its id (T1, T2…).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'One short line with all it takes to act: what, where (URL, PR) and why, e.g. "Test client #526 at http://localhost:5173: drag an item between two bags".',
        },
        kind: { type: 'string', enum: ['do', 'know'], description: '"do" (the default) for an action, "know" for news.' },
        from: { type: 'string', description: 'The worker, issue or PR it is about.' },
      },
      required: ['text'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'unpin_for_owner',
    description:
      'Remove items pinned with pin_for_owner once they are done (the PR merged, the person said they tested it) or no longer needed, so the list holds only what still waits for the person.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Ids such as "T3".' } },
      required: ['ids'],
    },
    isDeferred: false,
  })
}
