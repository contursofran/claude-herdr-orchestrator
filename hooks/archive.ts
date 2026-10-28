import type { EngineInterface } from 'claude-code'
import { REPORTS_DIR } from './defaults'

// Copies a report file to ~/.herdr-agents/reports/<its worker folder>/<name>. The worker
// folder lives in a worktree that `git worktree remove` deletes after the PR merges;
// scripts/hrd-metrics.py reads the copy then. A failure is ignored: a report is never lost for it.
export async function archive($: EngineInterface, dir: string, name: string, text: string) {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    await $.fs.write(`${home}/${REPORTS_DIR}${dir}/${name}`, text)
  } catch {}
}
