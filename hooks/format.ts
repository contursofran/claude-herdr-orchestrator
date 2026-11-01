// A short age: now, 12m, 1h05.
export function ago(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000))
  return m === 0 ? 'now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
