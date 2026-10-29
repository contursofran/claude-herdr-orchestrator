import type { EngineInterface } from 'claude-code'
import type { Job } from '../types'
import { resetSettings } from './config'
import { resetPending } from './coordinator'
import { AUTO_END, AUTO_START, RECENT_REPORTS } from './defaults'
import { turnRunning } from './outbox'
import { active, jobs } from './state'

// The state file's Workers block: the mod writes what it knows (running and waiting workers,
// recent reports) between AUTO_START and AUTO_END, so the coordinator keeps only Ready,
// Decisions and Next. The text depends only on the jobs, so it is the same byte for byte
// while nothing changes, and the file is written only when it differs.

// UTC, YYYY-MM-DD HH:MM.
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export function renderBlock(list: Job[]): string {
  const running = list.filter(j => active(j) || j.tail).sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name))
  const waiting = running.filter(j => j.status === 'running' && j.wait)
  const recent = list
    .filter(j => j.status === 'reported' && j.endedAt !== undefined)
    .sort((a, b) => b.endedAt! - a.endedAt! || a.name.localeCompare(b.name))
    .slice(0, RECENT_REPORTS)
  const state = (j: Job) =>
    j.status === 'starting'
      ? 'starting'
      : j.status === 'running'
        ? j.wait
          ? 'waiting'
          : 'running'
        : j.tail === 'blocked'
          ? 'blocked after its report'
          : 'finishing its turn'
  const runningLine = (j: Job) => {
    const prs = j.prs ?? []
    const issues = (j.refs ?? []).filter(n => !prs.includes(n))
    return [
      `- ${j.name} (${j.profile}) in ${j.cwd}`,
      j.branch ? ` on ${j.branch}` : '',
      issues.length ? ` · ${issues.map(n => `#${n}`).join(', ')}` : '',
      prs.length ? ` · PR ${prs.map(n => `#${n}`).join(', ')}` : '',
      ` · ${state(j)} since ${utc(j.startedAt)}`,
    ].join('')
  }
  const section = (title: string, lines: string[]) => [`### ${title}`, ...(lines.length ? lines : ['- none'])]
  return [
    AUTO_START,
    '## Workers (written by herdr-agents on every change; do not edit this block)',
    ...section('Running', running.map(runningLine)),
    ...section(
      'Waiting',
      waiting.map(j => `- ${j.name}: ${oneLine(j.wait!.for)} (WAIT.json since ${utc(j.wait!.since)})`),
    ),
    ...section(
      'Recent reports',
      recent.map(j => `- ${utc(j.endedAt!)} ${j.name} (${j.profile}) ${j.reportStatus ?? 'reported'}: ${j.reportFile ?? 'no report file'}`),
    ),
    AUTO_END,
  ].join('\n')
}

// The file with its block replaced (the text from AUTO_START to AUTO_END, inclusive), or with the
// block added after its trimmed end when the markers are missing. Everything outside is kept.
export function mergeBlock(file: string, block: string): string {
  const end = file.indexOf(AUTO_END)
  const start = end >= 0 ? file.lastIndexOf(AUTO_START, end) : -1
  if (start >= 0) return file.slice(0, start) + block + file.slice(end + AUTO_END.length)
  const kept = file.trimEnd()
  return kept ? `${kept}\n${block}\n` : `${block}\n`
}

// The coordinator's tick. Nothing is written in a worker's session, with no jobs, during a main
// turn (it could fail the model's Read then Edit) or while a context reset waits for the save
// (its write would count as the save).
export async function writeBlock($: EngineInterface) {
  if ((await $.env.get('HERDR_AGENTS_ROLE')) === 'worker') return
  const all = Object.values(await jobs($))
  if (all.length === 0 || turnRunning() || (await resetPending($))) return
  const { statePath } = await resetSettings($)
  const file = (await $.fs.exists(statePath)) ? await $.fs.read(statePath) : ''
  const next = mergeBlock(file, renderBlock(all))
  if (next !== file) await $.fs.write(statePath, next)
}
