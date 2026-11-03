import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { target, wrappingUp } from './config'
import { notify } from './hc'
import { notesFolder, notesInstructions } from './notes'
import { cmd } from './session'
import { active, jobs, working } from './state'

// Whether /hrd-orchestrate ran in this session. Without it the session gets no coordinator guidance (playbook, nudges).
// Here, not in coordinator.ts, so outbox.ts can read it without importing the coordinator.
const orchestrating = atom({ plugin: 'herdr-agents', key: 'orchestrating' } as const, false)

export async function isOrchestrating($: EngineInterface) {
  return read($, orchestrating)
}

export async function setOrchestrating($: EngineInterface, on: boolean) {
  await update($, orchestrating, () => on)
}

// The line the coordinator gets with a prompt that follows a report or a stop: while wrapping up,
// how many workers are still out; otherwise, in a coordinator (/hrd-orchestrate ran), when fewer work than the target, how many to start.
// Its own file, so outbox.ts can use it without importing the coordinator (owner.ts imports outbox.ts).
export async function belowTarget($: EngineInterface, countHint = true) {
  const all = Object.values(await jobs($))
  // Wrap-up (also from the config) only speaks to a coordinator; a plain session is never told to wrap up.
  if (!(await isOrchestrating($))) return ''
  if (await wrappingUp($)) {
    const left = all.filter(active).length
    if (left > 0)
      return `\n\n[Wrapping up: ${left} worker${left === 1 ? '' : 's'} still out. The owner stopped new work: start no new workers (a reviewer for an open PR is allowed); send fixes with message and finish their PRs.]`
    notify($, 'herdr workers all finished', `Every worker has finished; none start until ${cmd('wrap-up')} off.`)
    const folder = await notesFolder($)
    const notes = folder ? ` Before you stop:\n${notesInstructions(folder)}\n` : ' '
    return `\n\n[Wrapping up: every worker has finished. Start nothing new; update the state file with where things stand.${notes}Then stop. The owner ends it with ${cmd('wrap-up')} off.]`
  }
  // A report prompt leaves the count out: the owner reads it there and the host can't hide it (#174); stop results keep it.
  if (!countHint) return ''
  const want = await target($)
  const now = await $.clock.now()
  const running = all.filter(j => working(j, now)).length
  if (running >= want) return ''
  return `\n\n[${running} of ${want} workers working (waiting ones don't count). Start ${want - running} more now from the Ready list in the state file; if it has fewer than 3 items, also start a planner on the next backlog issue.]`
}
