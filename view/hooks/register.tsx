import type { Register } from 'claude-code'
import { oneLine } from './format'

// Claude Code never raises a mod's own ui.render hooks for the prompts that mod
// submits, so herdr-agents can't shorten its own rows; this separate mod does.
const SOURCE = 'herdr-agents'

export const register: Register = on => {
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const origin = e.props.origin
    if (e.props.isExpanded || origin?.kind !== 'plugin' || origin.name !== SOURCE) return next(e)
    const line = oneLine(String(e.props.text ?? ''))
    if (line === undefined) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text dimColor wrap="truncate-end">
        {line}
      </Text>
    )
  })
}
