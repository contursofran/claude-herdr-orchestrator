// CPU, RAM and disk of each machine, for the line under its header in the Spaces list (spaces.js). Pure parsing and
// formatting first, then `MachineStats`, which polls through an injected `exec` so a test can drive it.

/** One `sh` script for a computer of either kind, printing `uname -s`, then the three readings under `--cpu`, `--mem`
 *  and `--disk` marks. Linux: the first line of /proc/stat (a delta between two reads, so no sleep), MemAvailable and
 *  `df /`. macOS: no /proc, so `top` for the CPU, `vm_stat` for RAM and `df` of the data volume (the system volume is a
 *  read-only snapshot that is always nearly full). */
export const READ_SCRIPT = [
  'os=$(uname -s)',
  'echo "$os"',
  'echo --cpu',
  'if [ "$os" = Darwin ]; then top -l 1 -n 0 -s 0 | grep "^CPU usage"; else head -n 1 /proc/stat; fi',
  'echo --mem',
  'if [ "$os" = Darwin ]; then vm_stat; sysctl -n hw.memsize; else grep -E "^(MemTotal|MemAvailable):" /proc/meminfo; fi',
  'echo --disk',
  'if [ "$os" = Darwin ]; then df -Pk /System/Volumes/Data; else df -Pk /; fi',
].join('\n')

export const POLL_MS = 10000

const pct = n => (Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null)

/** The reading's text split into its kind (`Darwin`, `Linux`, ...) and its three sections; null when it is not ours. */
export function splitReading(text) {
  const lines = String(text ?? '').split('\n')
  const os = lines[0]?.trim()
  if (os !== 'Darwin' && os !== 'Linux') return null
  const sections = { cpu: [], mem: [], disk: [] }
  let into = null
  for (const line of lines.slice(1)) {
    const mark = /^--(cpu|mem|disk)$/.exec(line.trim())
    if (mark) into = sections[mark[1]]
    else if (into) into.push(line)
  }
  return { os, cpu: sections.cpu.join('\n'), mem: sections.mem.join('\n'), disk: sections.disk.join('\n') }
}

/** Linux: busy and total jiffies from the `cpu ` line of /proc/stat; null when it is not there. Idle and iowait are idle. */
export function parseProcStat(text) {
  const m = /^cpu\s+(.+)$/m.exec(text ?? '')
  if (!m) return null
  const v = m[1].trim().split(/\s+/).map(Number)
  if (v.length < 4 || v.some(n => !Number.isFinite(n))) return null
  const total = v.slice(0, 8).reduce((a, b) => a + b, 0)
  const idle = v[3] + (v[4] ?? 0)
  return { busy: total - idle, total }
}

/** Percent busy between two reads of `parseProcStat`; null when there is no earlier read or no time went by. */
export function cpuBetween(prev, cur) {
  if (!prev || !cur || cur.total <= prev.total) return null
  return pct(((cur.busy - prev.busy) / (cur.total - prev.total)) * 100)
}

/** macOS: percent busy from `top`'s "CPU usage: 5.2% user, 3.1% sys, 91.6% idle" line. */
export function parseTopCpu(text) {
  const m = /([\d.]+)%\s+idle/.exec(text ?? '')
  return m ? pct(100 - Number(m[1])) : null
}

/** Linux: percent of RAM in use from MemTotal and MemAvailable (kB). */
export function parseMeminfo(text) {
  const get = name => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text ?? '')?.[1])
  const total = get('MemTotal')
  const free = get('MemAvailable')
  return total > 0 && Number.isFinite(free) ? pct(((total - free) / total) * 100) : null
}

/** macOS: percent of RAM in use from `vm_stat` then the byte count of `sysctl -n hw.memsize`. Free, inactive, speculative
 *  and purgeable pages count as available. */
export function parseVmStat(text) {
  const t = text ?? ''
  const size = Number(/page size of (\d+) bytes/.exec(t)?.[1])
  const pages = name => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(t)?.[1] ?? 0)
  const bytes = Number(t.trim().split('\n').pop())
  if (!(size > 0) || !(bytes > 0) || !/^Pages free:/m.test(t)) return null
  const free = (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * size
  return pct(((bytes - free) / bytes) * 100)
}

/** Percent of the disk in use from `df -Pk <path>`: used over used + available, which is the Capacity column's figure. */
export function parseDf(text) {
  const row = String(text ?? '')
    .split('\n')
    .map(l => l.trim().split(/\s+/))
    .find(c => c.length >= 6 && /^\d+$/.test(c[2]) && /^\d+$/.test(c[3]))
  if (!row) return null
  const used = Number(row[2])
  const avail = Number(row[3])
  return used + avail > 0 ? pct((used / (used + avail)) * 100) : null
}

/** What one reading says: `{ cpu, ram, disk }` (null for what is not known) and the /proc/stat counters to compare the
 *  next Linux read with (`prev` is the last read's). null when the text is not a reading. */
export function readFigures(text, prev) {
  const s = splitReading(text)
  if (!s) return null
  if (s.os === 'Darwin') return { cpu: parseTopCpu(s.cpu), ram: parseVmStat(s.mem), disk: parseDf(s.disk), counters: null }
  const counters = parseProcStat(s.cpu)
  return { cpu: cpuBetween(prev, counters), ram: parseMeminfo(s.mem), disk: parseDf(s.disk), counters }
}

/** `CPU 12%  RAM 30%  Disk 47%`, leaving out any figure not known; '' when none is. */
export function statsLine(f) {
  return [
    ['CPU', f?.cpu],
    ['RAM', f?.ram],
    ['Disk', f?.disk],
  ]
    .filter(([, n]) => Number.isFinite(n))
    .map(([name, n]) => `${name} ${n}%`)
    .join('  ')
}

/** Reads each connected machine on a timer, one read at a time per machine, and keeps the line to show. `exec` is
 *  herdr's `exec`; `local` is the key for this computer. */
export class MachineStats {
  constructor(exec) {
    this.exec = exec
    this.lines = {} // machine -> the line shown ('' / absent: none)
    this.counters = {} // machine -> the last /proc/stat counters
    this.busy = new Set() // machines being read now
  }

  line(machine) {
    return this.lines[machine ?? ''] ?? ''
  }

  /** Forgets machines that are not in `live`: they show no line, and their next read has no earlier CPU counters. */
  keepOnly(live) {
    let changed = false
    const keep = new Set(live.map(m => m ?? ''))
    for (const k of Object.keys(this.lines)) {
      if (keep.has(k)) continue
      if (this.lines[k]) changed = true
      delete this.lines[k]
    }
    for (const k of Object.keys(this.counters)) if (!keep.has(k)) delete this.counters[k]
    return changed
  }

  /** One read of `machine` (null: this computer), unless one is running. true when the line it shows changed. */
  async read(machine) {
    const key = machine ?? ''
    if (this.busy.has(key)) return false
    this.busy.add(key)
    let line = ''
    try {
      const r = await this.exec('sh', ['-c', READ_SCRIPT], { on: machine ?? null })
      const f = readFigures(r?.stdout, this.counters[key])
      if (f) {
        line = statsLine(f)
        if (f.counters) this.counters[key] = f.counters
        else delete this.counters[key]
      }
    } catch {
      // away or failed: no line, and no CPU figure until two reads in a row
      delete this.counters[key]
    } finally {
      this.busy.delete(key)
    }
    const changed = line !== (this.lines[key] ?? '')
    if (line) this.lines[key] = line
    else delete this.lines[key]
    return changed
  }

  /** Reads all of `live` (machine names, null for this computer) at once; true when any shown line changed. */
  async readAll(live) {
    const gone = this.keepOnly(live)
    const changes = await Promise.all(live.map(m => this.read(m)))
    return gone || changes.some(Boolean)
  }
}
