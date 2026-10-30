import type { EngineInterface } from 'claude-code'
import { config } from './config'
import { session } from './session'

// Learning notes: an opt-in step that leaves the person an Obsidian stub for each concept the
// session worked with (a title, where it came up, links, questions) and an empty explanation
// for them to write. Off unless `learningNotes.enabled` is true. Only the coordinator writes
// them, at wrap-up or on /hrd-notes, so workers never spend tokens on it.
export async function notesFolder($: EngineInterface): Promise<string | undefined> {
  const n = (await config($)).learningNotes
  if (!n?.enabled || typeof n.vault !== 'string' || !n.vault) return undefined
  const vault = n.vault.replace(/^~(?=\/)/, (await $.env.get('HOME')) ?? '~')
  const root = vault.startsWith('/') ? vault : `${session.cwd}/${vault}`
  return n.folder ? `${root}/${n.folder}` : root
}

export function notesInstructions(folder: string) {
  return [
    `Learning notes: list the concepts this session worked with that the owner may not know deeply yet (a technique, tool, protocol, data structure or system idea, not a task or a PR), and leave one Obsidian note per concept in ${folder}, named \`<Concept>.md\` in title case.`,
    '- Before writing, list the folder: a concept that already has a note (any spelling or plural of it) gets only a new "Seen in" line. Never change, reword or fill in anything else in an existing note.',
    '- A new note has: `# <Concept>`; `Seen in:` with the issue, PR or file where it came up and a few words on how; `Links:` with [[wikilinks]] to related concepts (existing notes or ones you add now); `Questions to answer:` with 2 or 3 questions that lead to understanding it; then `## My explanation` with nothing under it.',
    '- Never write the explanation, a definition or a summary: the owner writes that themselves to learn it. Keep each note under 15 lines, and add at most 8 new notes per run.',
    '- Then say in one line which notes you added and which got a new "Seen in".',
  ].join('\n')
}
