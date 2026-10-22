// How long ago, or how long for: 04:12 under an hour, 1h05 past it.
export function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m >= 60
    ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// A short age for the band: now, 12m, 1h05.
export function ago(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000))
  return m === 0 ? 'now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
