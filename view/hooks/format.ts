// The row's text with the engine's framing ("The herdr-agents plugin sent a
// message:" and the closing note) left out: from the first <herdr-...> tag on.
function payload(text: string): string | undefined {
  const at = text.indexOf('<herdr-')
  return at < 0 ? undefined : text.slice(at)
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1]
}

// The worker count, or the wrap-up note, that a prompt with a worker's report ends with.
function workerNote(body: string): string {
  const count = body.match(/\[(\d+) of (\d+) workers working/)
  const wrap = body.match(/\[Wrapping up: (?:(\d+) workers? still out|every worker has finished)/)
  return wrap ? ` · wrapping up, ${wrap[1] ?? 0} left` : count ? ` · ${count[1]}/${count[2]} working` : ''
}

// One element's line, from its tag (its first line) on, or undefined for a tag it doesn't know.
// `note` is the worker note; a worker's line shows it.
function element(part: string, note: string): string | undefined {
  const lines = part.split('\n')
  const tag = lines[0]!
  const inner = lines
    .slice(1)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('</herdr-'))
  if (tag.startsWith('<herdr-agent ')) {
    const first = inner.find(l => !l.startsWith('[')) ?? ''
    const full = inner.some(l => l.startsWith('[Full report')) ? ' · full report in file' : ''
    const pr = attr(tag, 'pr')
    const prs = pr ? ` · PR #${pr.split(',').join(', #')}` : ''
    return `⇠ ${attr(tag, 'name') ?? 'worker'} ${attr(tag, 'result') ?? attr(tag, 'status') ?? ''}: ${first}${full}${prs}${note}`
  }
  // Single-line forms: <herdr-decision ...>text</herdr-decision>, <herdr-context ...>text...
  const text1 =
    tag
      .replace(/^<herdr-[a-z]+[^>]*>/, '')
      .replace(/<\/herdr-[a-z]+>$/, '')
      .trim() ||
    inner[0] ||
    ''
  if (tag.startsWith('<herdr-decision ')) {
    const chose = inner
      .find(l => l.startsWith('The owner chose:'))
      ?.slice(16)
      .trim()
    const question = inner
      .find(l => l.startsWith('Question:'))
      ?.slice(9)
      .trim()
    return chose ? `◆ ${attr(tag, 'id') ?? ''} owner chose: ${chose} · ${question ?? ''}` : `◆ ${text1}`
  }
  if (tag.startsWith('<herdr-owner-done ')) {
    const did = inner
      .find(l => l.startsWith('The owner ticked off:'))
      ?.slice(21)
      .trim()
    return `✓ ${attr(tag, 'id') ?? ''} owner did: ${did ?? text1}`
  }
  if (tag.startsWith('<herdr-context')) return `↻ herdr-agents: ${text1}`
  return undefined
}

// One line for a herdr-agents prompt, or undefined to keep the engine's row. A batch (see
// outbox.ts) is several elements: one line for each, and the worker note once after them.
export function oneLine(text: string): string | undefined {
  const body = payload(text)
  if (!body) return undefined
  const parts = body.split(/\n(?=<herdr-)/)
  const note = workerNote(body)
  if (parts.length === 1) return element(body, note)
  const lines = parts.map(part => (element(part, '') ?? part.split('\n')[0]!).replace(/^⇠ /, ''))
  return `⇠ ${parts.length} updates: ${lines.join(' · ')}${note}`
}
