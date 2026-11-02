// Role `usage`: how much of the Claude and Codex plans' 5-hour and weekly limits is used, in the status bar. Both services
// answer with the sign-in their CLI already keeps on this computer, as penso/herdr-gpui's herdr-usage crate reads them. The
// token stays in the script: it goes to curl on stdin, never on a command line, and only the service's answer comes back.
import { div, image } from 'gpui-kit'
import { theme } from 'herdr'

/** Prints the answer, then `HTTP <status>`. Exits NO_SIGN_IN, having asked nothing, when there is no token. */
const NO_SIGN_IN = 3
const ask = (headers, url) => `curl -sS -m 15 -K - ${headers.map(h => `-H '${h}'`).join(' ')} -w '\\nHTTP %{http_code}\\n' ${url}`
const field = (name, from) => `sed -n 's/.*"${name}"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ${from} | head -n 1`

/** Claude Code's keychain item on a Mac, else its credentials file. With CLAUDE_CONFIG_DIR set only that folder's file: the
 *  keychain item of the default profile could be another account. Its token is not renewed here: Claude Code does that. */
export const CLAUDE_SCRIPT = [
  'creds=',
  'if [ -z "$CLAUDE_CONFIG_DIR" ] && [ "$(uname -s)" = Darwin ]; then',
  `  creds=$(security find-generic-password -s 'Claude Code-credentials' -a "$USER" -w 2>/dev/null || security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null)`,
  'fi',
  '[ -n "$creds" ] || creds=$(cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" 2>/dev/null)',
  `token=$(printf '%s' "$creds" | ${field('accessToken', '')})`,
  `[ -n "$token" ] || exit ${NO_SIGN_IN}`,
  `printf 'header = "Authorization: Bearer %s"\\n' "$token" | ${ask(['anthropic-beta: oauth-2025-04-20', 'User-Agent: claude-code/2.1.0'], 'https://api.anthropic.com/api/oauth/usage')}`,
].join('\n')

/** The Codex CLI's ChatGPT sign-in. An API-key login has no token here, and no plan limits either. */
export const CODEX_SCRIPT = [
  'auth="${CODEX_HOME:-$HOME/.codex}/auth.json"',
  `token=$(${field('access_token', '"$auth"')} 2>/dev/null)`,
  `account=$(${field('account_id', '"$auth"')} 2>/dev/null)`,
  `[ -n "$token" ] || exit ${NO_SIGN_IN}`,
  `printf 'header = "Authorization: Bearer %s"\\nheader = "ChatGPT-Account-Id: %s"\\n' "$token" "$account" | ${ask(['User-Agent: codex-cli', 'OpenAI-Beta: codex-1', 'originator: Codex Desktop'], 'https://chatgpt.com/backend-api/wham/usage')}`,
].join('\n')

/** herdr-usage's pace: often enough to trust, rarely enough for endpoints that rate-limit their callers. */
export const POLL_MS = 10 * 60 * 1000
/** After a refusal (expired sign-in, rate limit), a provider is left alone this long. */
export const REFUSED_MS = 30 * 60 * 1000

const SESSION_SECONDS = 5 * 3600
const WEEK_SECONDS = 7 * 86400

/** Milliseconds from seconds, milliseconds or an ISO time, whose microseconds not every Date.parse takes. */
function toMs(value) {
  if (typeof value === 'number') return value > 0 ? (value > 1e11 ? value : value * 1000) : null
  if (typeof value !== 'string') return null
  const ms = Date.parse(value.trim().replace(/(\.\d{3})\d+/, '$1'))
  return Number.isFinite(ms) ? ms : null
}

const windowOf = (percent, resets) =>
  Number.isFinite(percent) ? { pct: Math.min(100, Math.max(0, Math.round(percent))), resets: toMs(resets) } : null

const orNull = (session, weekly) => (session || weekly ? { session, weekly } : null)

/** `{ session, weekly }` from Anthropic's answer: its `limits` list, else the older fixed fields. A window it does not
 *  report (`five_hour` is null while no 5-hour window is open) is null. */
export function parseClaude(usage) {
  const limits = Array.isArray(usage?.limits) ? usage.limits : []
  const pick = (kind, fixed) => {
    const limit = limits.find(l => l?.kind === kind)
    return windowOf(limit?.percent, limit?.resets_at) ?? windowOf(fixed?.utilization, fixed?.resets_at)
  }
  return orNull(pick('session', usage?.five_hour), pick('weekly_all', usage?.seven_day))
}

/** `{ session, weekly }` from OpenAI's answer. A window is known by its length; its slot only decides when that is missing. */
export function parseCodex(usage) {
  const slots = [usage?.rate_limit?.primary_window, usage?.rate_limit?.secondary_window]
  const find = (seconds, fallback) =>
    slots.find(w => w?.limit_window_seconds === seconds) ?? (fallback?.limit_window_seconds ? null : fallback)
  const read = w => windowOf(w?.used_percent, w?.reset_at)
  return orNull(read(find(SESSION_SECONDS, slots[0])), read(find(WEEK_SECONDS, slots[1])))
}

/** The status and body of what a script printed; null when it is not a whole answer. */
export function splitAnswer(stdout) {
  const m = /\nHTTP (\d{3})\s*$/.exec(String(stdout ?? ''))
  return m ? { status: Number(m[1]), body: stdout.slice(0, m.index) } : null
}

// `icon`: the app's own coloured picture of each, the one its agents list shows, in the home folder.
const PROVIDERS = [
  { id: 'claude', name: 'Claude', icon: 'icons/claude.svg', script: CLAUDE_SCRIPT, parse: parseClaude },
  { id: 'codex', name: 'Codex', icon: 'icons/codex.svg', script: CODEX_SCRIPT, parse: parseCodex },
]

/** Keeps the last good reading of each provider: a failed read shows old figures with their time, not nothing. A provider
 *  with no sign-in shows nothing. `exec` is herdr's `exec`, whose own 30 s limit ends a read that hangs. */
export class UsageTracker {
  constructor(exec, now = Date.now) {
    this.exec = exec
    this.now = now
    this.readings = {} // provider -> { session, weekly, at }
    this.refusedUntil = {} // provider -> ms
  }

  /** One read of `provider`. true when what it shows changed. */
  async read(provider) {
    if (this.now() < (this.refusedUntil[provider.id] ?? 0)) return false
    let result
    try {
      result = await this.exec('sh', ['-c', provider.script])
    } catch {
      return false
    }
    if (result?.code === NO_SIGN_IN) return this.set(provider.id, null)
    const answer = splitAnswer(result?.stdout)
    if (!answer) return false
    if ([401, 403, 429].includes(answer.status)) this.refusedUntil[provider.id] = this.now() + REFUSED_MS
    if (answer.status !== 200) return false
    let reading
    try {
      reading = provider.parse(JSON.parse(answer.body))
    } catch {
      return false
    }
    return reading ? this.set(provider.id, { ...reading, at: this.now() }) : false
  }

  set(id, reading) {
    const changed = JSON.stringify(reading) !== JSON.stringify(this.readings[id] ?? null)
    if (reading) this.readings[id] = reading
    else delete this.readings[id]
    return changed
  }

  /** Reads each provider on its own, so a slow one holds no other; `changed()` for each that shows something new. */
  poll(changed) {
    return Promise.all(PROVIDERS.map(p => this.read(p).then(c => c && changed())))
  }
}

const pad = n => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `14:02` today, `Mon 14:00` on another day, in local time. A clock time, so a view that only redraws on a read stays right. */
export function clock(ms, now = Date.now()) {
  const d = new Date(ms)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date(now).toDateString() ? time : `${DAYS[d.getDay()]} ${time}`
}

/** A window past its reset has started again, whatever the last read said. */
const pctNow = (w, now) => (w && w.resets && w.resets <= now ? 0 : (w?.pct ?? null))

/** `5h 0%` or, for a window the service does not report, `5h –`. */
export const figure = (label, w, now) => {
  const pct = pctNow(w, now)
  return `${label} ${pct === null ? '–' : `${pct}%`}`
}

/** The hover text of one provider: each window's figure and reset, then when this was read. */
export function usageTip(name, reading, now) {
  const part = (label, w) => (w ? `${figure(label, w, now)}${w.resets && w.resets > now ? `, resets ${clock(w.resets, now)}` : ''}` : null)
  return `${name}: ${[part('5h', reading.session), part('7d', reading.weekly)].filter(Boolean).join(' · ')}. Read at ${clock(reading.at, now)}.`
}

/** Plain until a limit gets close, red when it is nearly gone. */
function tone(w, now, t) {
  const pct = pctNow(w, now) ?? 0
  return pct >= 90 ? (t.blocked ?? t.ansi1) : pct >= 70 ? t.foreground : t.dim
}

/** Sits in the status bar like the version beside it: same background and top line. */
export function usageView(tracker, now = Date.now()) {
  const t = theme()
  const shown = PROVIDERS.filter(p => tracker.readings[p.id])
  return div()
    .size_full()
    .flex()
    .items_center()
    .justify_end()
    .gap(14)
    .pr(4)
    .bg(t.chrome)
    .border_t(1)
    .border_color(t.border)
    .text_size(11)
    .text_color(t.dim)
    .children(
      shown.map(p => {
        const r = tracker.readings[p.id]
        const value = (label, w) =>
          div()
            .flex_none()
            .text_color(tone(w, now, t))
            .child(figure(label, w, now))
        return div()
          .id(`usage-${p.id}`)
          .flex()
          .flex_none()
          .items_center()
          .gap(6)
          .tooltip(usageTip(p.name, r, now))
          .child(image(p.icon).w(14).h(14).flex_none())
          .child(value('5h', r.session))
          .child(value('7d', r.weekly))
      }),
    )
}
