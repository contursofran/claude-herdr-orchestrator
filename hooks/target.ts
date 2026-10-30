import type { EngineInterface } from 'claude-code'
import { target, wrappingUp } from './config'
import { notify } from './hc'
import { notesFolder, notesInstructions } from './notes'
import { cmd } from './session'
import { active, jobs } from './state'

// The line the coordinator gets with a prompt that follows a report or a stop: while wrapping up,
// how many workers are still out; otherwise, when fewer work than the target, how many to start.
// Its own file, so outbox.ts can use it without importing the coordinator (owner.ts imports outbox.ts).
export async function belowTarget($: EngineInterface) {
  const all = Object.values(await jobs($))
  if (await wrappingUp($)) {
    const left = all.filter(active).length
    if (left > 0)
      return `\n\n[Wrapping up: ${left} worker${left === 1 ? '' : 's'} still out. The owner stopped new work: start no new workers (a reviewer for an open PR is allowed); send fixes with message and finish their PRs.]`
    notify($, 'herdr workers all finished', `Every worker has finished; none start until ${cmd('wrap-up')} off.`)
    const folder = await notesFolder($)
    const notes = folder ? ` Before you stop:\n${notesInstructions(folder)}\n` : ' '
    return `\n\n[Wrapping up: every worker has finished. Start nothing new; update the state file with where things stand.${notes}Then stop. The owner ends it with ${cmd('wrap-up')} off.]`
  }
  const want = await target($)
  const running = all.filter(j => active(j) && !j.wait).length
  if (running >= want) return ''
  return `\n\n[${running} of ${want} workers working (waiting ones don't count). Start ${want - running} more now from the Ready list in the state file; if it has fewer than 3 items, also start a planner on the next backlog issue.]`
}
