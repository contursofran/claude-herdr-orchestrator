import type { Register } from 'claude-code'
import { drawBand, shortenBrief } from './band'
import { refresh, showContext } from './board'
import { registerCommands, runCommand } from './commands'
import { publishBoard, removeBoard } from './bridge'
import { claimState, config, resetSettings } from './config'
import { maybeReset } from './coordinator'
import { CLOSE_IDLE_MINUTES, PR_POLL_MS, PRUNE_MINUTES, SWEEP_MS, TICK_MS } from './defaults'
import { restoreOutbox, retry, turnEnded, turnStarted } from './outbox'
import { askOwner, noteReports, openQuestions, pinForOwner, pingAfterReports, settle, unpinForOwner } from './owner'
import type { AskArgs, DecidedArgs, PinArgs } from './owner'
import { session } from './session'
import { drawSettings, trackFocus } from './settings'
import { drawSide, pollPrs, SIDE, sideClosed, sideOpen, sideShown, syncSide, toggleSide } from './side'
import { active, dropOldJobs, jobs, restoreJobs } from './state'
import { writeBlock } from './stateblock'
import { refreshSpawnTool, registerTools } from './tools'
import { checkReports, messageWorker, resumeWatching, spawnWorker, stopWorker, sweep } from './workers'
import type { SpawnArgs } from './workers'
import { pruneMerged } from './worktrees'

// herdr-agents: a coordinator session starts worker agents in herdr tabs, and their
// reports come back to it as prompts. This file only wires the engine's events to
// the modules beside it.

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The mod loads in every worker's own Claude session too (same plugin dirs); spawn marks
    // those tabs, and they run none of the coordinator's timers, only the sweep and the report
    // check for the workers they started while one of them runs.
    const isWorker = (await $.env.get('HERDR_AGENTS_ROLE')) === 'worker'
    session.cwd = started.cwd
    const settings = await config($)
    if (typeof settings.commandPrefix === 'string') session.prefix = settings.commandPrefix
    // Each register waits 8 s for its tool to appear, which never happens under an --agent whose tools
    // line leaves it out, and Claude starts no turn until this hook is done: 56 s for a builder's first
    // prompt. The coordinator's model needs its tools from the first prompt; a worker can get them later.
    if (isWorker)
      void registerTools($).catch(err =>
        $.ui.toast(`herdr-agents: registering its tools failed (${err instanceof Error ? err.message : String(err)})`),
      )
    else await registerTools($)
    await registerCommands($)
    const restored = await restoreJobs($)
    if (restored > 0) $.ui.toast(`herdr-agents: ${restored} workers restored after a reload`)
    await dropOldJobs($)
    const closeMinutes = settings.closeIdleMinutes ?? CLOSE_IDLE_MINUTES
    resumeWatching($, Object.values(await jobs($)))
    await restoreOutbox($)
    if (isWorker) {
      // A worker's own session sweeps the workers it started, but only while one of them runs,
      // or while a reported one with an open tab is due to close (closeIdleMinutes). Until then it
      // makes no hc call, and none once the last tab is closed. Its report check does nothing
      // with no running job either. The other timers stay with the coordinator.
      const sweepIfNeeded = async () => {
        const all = Object.values(await jobs($))
        let needed = all.some(j => active(j) || j.tail)
        if (!needed && closeMinutes > 0) {
          const now = await $.clock.now()
          const asking = new Set((await openQuestions($)).map(d => d.from))
          needed = all.some(
            j =>
              j.status === 'reported' &&
              !j.closed &&
              !asking.has(j.name) &&
              j.endedAt !== undefined &&
              now - j.endedAt >= closeMinutes * 60_000,
          )
        }
        if (needed) await sweep($, closeMinutes)
      }
      void sweepIfNeeded().catch(() => {})
      $.clock.every(SWEEP_MS, () => {
        void sweepIfNeeded().catch(() => {})
        retry($)
      })
      $.clock.every(TICK_MS, () => void checkReports($).catch(() => {}))
      return started
    }
    void sweep($, closeMinutes).catch(() => {})
    // view "side": the sidebar instead of the band, opened once there is room for it.
    // A reload finds it open already.
    if (settings.view === 'side' && !(await sideOpen($))) void toggleSide($).catch(() => {})
    // The band, the sidebar and the bridge's inbox, every TICK_MS with no hc calls: refresh
    // reads the states the waits and the sweep last saw. The report check comes first, so a
    // RESULT.md that landed is delivered at this tick, and the state file's block follows it.
    $.clock.every(
      TICK_MS,
      () =>
        void checkReports($)
          .catch(() => {})
          .then(() => writeBlock($))
          .catch(() => {})
          .then(() => refresh($))
          .then(() => syncSide($))
          .then(() => publishBoard($))
          .catch(() => {}),
    )
    $.clock.every(PR_POLL_MS, () => void pollPrs($).catch(() => {}))
    const pruneMinutes = settings.pruneMinutes ?? PRUNE_MINUTES
    if (pruneMinutes > 0) $.clock.every(pruneMinutes * 60_000, () => void pruneMerged($))
    // The sweep always runs: it is what catches a worker whose wait child died. Only its
    // closeIdle step depends on closeIdleMinutes.
    $.clock.every(SWEEP_MS, () => {
      void sweep($, closeMinutes).catch(() => {})
      retry($)
    })
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
  // reading that report ends, unless it settled them itself. The prompts held in the
  // outbox (see outbox.ts) wait for the turn's end too.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      noteReports(e.turnId, e.text)
      turnStarted()
      void refreshSpawnTool($).catch(() => {})
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) {
      // turnEnded runs even when the ping throws: a busy flag left set would hold the outbox until a turn ends.
      try {
        await pingAfterReports($, e.turnId)
      } finally {
        await turnEnded($)
      }
    }
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
