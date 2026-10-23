import type { Register } from 'claude-code'
import { drawBand, shortenBrief } from './band'
import { refresh, showContext } from './board'
import { registerCommands, runCommand } from './commands'
import { publishBoard, removeBoard } from './bridge'
import { claimState, config, resetSettings } from './config'
import { maybeReset } from './coordinator'
import { CLOSE_IDLE_MINUTES, PR_POLL_MS, PRUNE_MINUTES } from './defaults'
import { askOwner, noteReports, pinForOwner, pingAfterReports, settle, unpinForOwner } from './owner'
import type { AskArgs, DecidedArgs, PinArgs } from './owner'
import { session } from './session'
import { drawSettings, trackFocus } from './settings'
import { drawSide, pollPrs, SIDE, sideClosed, sideOpen, sideShown, syncSide, toggleSide } from './side'
import { jobs, restoreJobs } from './state'
import { registerTools } from './tools'
import { closeIdle, messageWorker, resumeWatching, spawnWorker, stopWorker } from './workers'
import type { SpawnArgs } from './workers'
import { pruneMerged } from './worktrees'

// herdr-agents: a coordinator session starts worker agents in herdr tabs, and their
// reports come back to it as prompts. This file only wires the engine's events to
// the modules beside it.

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    session.cwd = started.cwd
    const settings = await config($)
    if (typeof settings.commandPrefix === 'string') session.prefix = settings.commandPrefix
    await registerTools($)
    await registerCommands($)
    const restored = await restoreJobs($)
    if (restored > 0) $.ui.toast(`herdr-agents: ${restored} workers restored after a reload`)
    resumeWatching($, Object.values(await jobs($)))
    // view "side": the sidebar instead of the band, opened once there is room for it.
    // A reload finds it open already.
    if (settings.view === 'side' && !(await sideOpen($))) void toggleSide($).catch(() => {})
    $.clock.every(
      3000,
      () =>
        void refresh($)
          .then(() => syncSide($))
          .then(() => publishBoard($))
          .catch(() => {}),
    )
    $.clock.every(PR_POLL_MS, () => void pollPrs($).catch(() => {}))
    const pruneMinutes = settings.pruneMinutes ?? PRUNE_MINUTES
    if (pruneMinutes > 0) $.clock.every(pruneMinutes * 60_000, () => void pruneMerged($))
    const closeMinutes = settings.closeIdleMinutes ?? CLOSE_IDLE_MINUTES
    if (closeMinutes > 0) $.clock.every(60_000, () => void closeIdle($, closeMinutes))
    return started
  })
  on('session.end', async ($, e, next) => {
    await removeBoard($).catch(() => {})
    return next(e)
  })

  on('tool.call', { tool: 'mcp__herdr-agents__spawn' }, ($, e) => spawnWorker($, e as unknown as SpawnArgs))
  on('tool.call', { tool: 'mcp__herdr-agents__message' }, ($, e) => messageWorker($, e as unknown as { worker: string; text: string }))
  on('tool.call', { tool: 'mcp__herdr-agents__stop' }, ($, e) => stopWorker($, e as unknown as { worker: string }))
  on('tool.call', { tool: 'mcp__herdr-agents__ask_owner' }, ($, e) => askOwner($, e as unknown as AskArgs))
  on('tool.call', { tool: 'mcp__herdr-agents__decided' }, ($, e) => settle($, e as unknown as DecidedArgs))
  on('tool.call', { tool: 'mcp__herdr-agents__pin_for_owner' }, ($, e) => pinForOwner($, e as unknown as PinArgs))
  on('tool.call', { tool: 'mcp__herdr-agents__unpin_for_owner' }, ($, e) => unpinForOwner($, e as unknown as { ids?: string[] }))

  // The session that writes the shared state file owns it (see resetSettings).
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const out = await next(e)
    await claimState($, e.file_path)
    return out
  })
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const out = await next(e)
    await claimState($, e.file_path)
    return out
  })

  // A worker's DECISION: questions ping the person once the coordinator's turn
  // reading that report ends, unless it settled them itself.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) noteReports(e.turnId, e.text)
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) await pingAfterReports($, e.turnId)
    return out
  })

  // After each turn: show the context fill on the band and reset it past the limit.
  on('session.measure', async ($, e, next) => {
    const out = await next(e)
    const tokens = e.context.tokens
    if (tokens !== undefined) {
      const { limit } = await resetSettings($)
      await showContext($, tokens, limit)
      void maybeReset($, tokens)
    }
    return out
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => next(shortenBrief(e)))

  // The band above the prompt: the settings while /hrd-config has them open, else
  // what waits for the person and the workers, unless the sidebar shows them.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    session.bandId = e.requestId
    return (await drawSettings($, e)) ?? ((await sideShown($)) ? next(e) : drawBand($, e, next))
  })

  // The sidebar (/hrd-side).
  on('ui.render', { component: 'Pane', requestId: SIDE }, ($, e) => drawSide($, e))
  on('ui.close', async ($, e, next) => {
    if (e.id === SIDE) await sideClosed($)
    return next(e)
  })
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    await trackFocus($, e.element)
    return next(e)
  })

  on('command.run', async ($, e, next) => (await runCommand($, e.command, e.args)) ?? next(e))
}
