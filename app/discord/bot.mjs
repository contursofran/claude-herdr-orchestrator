#!/usr/bin/env node
// The Discord bot: watches the boards and posts what changed. Run by app/discord/service.sh; `--once` looks once and exits.
// Reads <home>/discord-token and <home>/discord.json; keeps its place in <home>/discord-state.json.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANNELS, allowed, diffBoard, metricsDue, metricsText, pruneSeen } from './model.mjs'

const API = 'https://discord.com/api/v10'
const CATEGORY = 'Herdr'
const EVERY_MS = 5000
const AFTER_FAILURE_MS = 30000
const here = dirname(fileURLToPath(import.meta.url))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...args) => console.log(new Date().toISOString(), ...args)

/** A Discord call. Waits out a rate limit, and only the owner's mention can ever notify anyone. */
export function makeApi(token, doFetch = fetch, wait = sleep) {
  return async function api(method, path, body) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await doFetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'herdr-agents (github.com/contursofran/claude-herdr-orchestrator)',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (res.status === 429) {
        const { retry_after: after } = await res.json().catch(() => ({}))
        await wait(Math.ceil((after ?? 1) * 1000) + 100)
        continue
      }
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
      return res.status === 204 ? null : res.json()
    }
    throw new Error(`${method} ${path}: still rate limited`)
  }
}

/** The channel id for each name, creating what is missing under one category. Channels the owner renamed are made again. */
export async function ensureChannels(api, guild) {
  const all = await api('GET', `/guilds/${guild}/channels`)
  const category =
    all.find(c => c.type === 4 && c.name.toLowerCase() === CATEGORY.toLowerCase()) ??
    (await api('POST', `/guilds/${guild}/channels`, { name: CATEGORY, type: 4 }))
  const ids = {}
  for (const name of CHANNELS) {
    const found = all.find(c => c.type === 0 && c.name === name)
    ids[name] = (found ?? (await api('POST', `/guilds/${guild}/channels`, { name, type: 0, parent_id: category.id }))).id
  }
  return ids
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export class Bot {
  constructor({ api, home, userHome, config, channels, now = Date.now, runMetrics = null, today = () => new Date() }) {
    Object.assign(this, { api, home, userHome, config, channels, now, runMetrics, today })
    this.statePath = join(home, 'discord-state.json')
    this.boardDir = join(home, 'board')
    const state = readJson(this.statePath, null)
    this.first = !state
    this.state = state ?? { seen: {}, metricsDay: null }
    this.mtimes = {}
  }

  save() {
    const tmp = `${this.statePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 })
    renameSync(tmp, this.statePath)
  }

  /** The boards written since the last look. A board caught mid-write comes back on the next look. */
  changedBoards() {
    const boards = []
    let names = []
    try {
      names = readdirSync(this.boardDir).filter(n => n.endsWith('.json'))
    } catch {
      return boards
    }
    for (const name of names) {
      const path = join(this.boardDir, name)
      try {
        const mtime = statSync(path).mtimeMs
        if (this.mtimes[name] === mtime) continue
        const board = JSON.parse(readFileSync(path, 'utf8'))
        this.mtimes[name] = mtime
        if (board.session && allowed(board.cwd, this.config.only, this.userHome)) boards.push(board)
      } catch {
        // gone, or mid-write
      }
    }
    return boards
  }

  async apply(action) {
    const seen = this.state.seen
    if (action.type === 'mark') {
      seen[action.id] = { at: action.at }
    } else if (action.type === 'post') {
      const channel = this.channels[action.channel]
      const message = await this.api('POST', `/channels/${channel}/messages`, {
        content: action.content,
        allowed_mentions: { parse: [], users: action.mention && this.config.ownerId ? [this.config.ownerId] : [] },
      })
      seen[action.id] = { at: action.at, message: message.id, channel, open: Boolean(action.open) }
    } else if (action.type === 'edit') {
      await this.api('PATCH', `/channels/${action.channel}/messages/${action.message}`, {
        content: action.content,
        allowed_mentions: { parse: [] },
      })
      seen[action.id] = { ...seen[action.id], open: false }
    }
    this.save() // after each one: a crash mid-look never posts the same thing twice
  }

  async look() {
    const now = this.now()
    for (const board of this.changedBoards()) {
      const actions = diffBoard(board, this.state.seen, { now, owner: this.config.ownerId, first: this.first })
      for (const action of actions) await this.apply(action)
    }
    if (this.first) {
      this.first = false
      this.save()
    }
    this.state.seen = pruneSeen(this.state.seen, now)
  }

  async metrics() {
    if (!this.runMetrics) return
    const day = metricsDue(this.state.metricsDay, this.today())
    if (!day) return
    const content = metricsText(await this.runMetrics())
    await this.api('POST', `/channels/${this.channels.metrics}/messages`, { content, allowed_mentions: { parse: [] } })
    this.state.metricsDay = day
    this.save()
  }
}

const runMetrics = () =>
  new Promise((resolve, reject) => {
    execFile(
      'python3',
      [join(here, '../../scripts/hrd-metrics.py'), '--days', '1', '--json'],
      { maxBuffer: 64 * 1024 * 1024, timeout: 600000 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(JSON.parse(stdout))
      },
    )
  })

async function main() {
  const userHome = homedir()
  const home = process.env.HRD_DISCORD_HOME ?? join(userHome, '.herdr-agents')
  mkdirSync(home, { recursive: true })
  const token = readFileSync(join(home, 'discord-token'), 'utf8').trim()
  const config = JSON.parse(readFileSync(join(home, 'discord.json'), 'utf8'))
  const api = makeApi(token)
  const channels = await ensureChannels(api, config.guildId)
  const once = process.argv.includes('--once')
  const bot = new Bot({ api, home, userHome, config, channels, runMetrics: once ? null : runMetrics })
  log(`watching ${bot.boardDir}${bot.first ? ', first look posts nothing' : ''}`)
  if (once) return bot.look()
  let metricsRunning = false
  for (;;) {
    let wait = EVERY_MS
    try {
      await bot.look()
    } catch (error) {
      log('look failed:', error.message)
      wait = AFTER_FAILURE_MS
    }
    if (!metricsRunning) {
      metricsRunning = true
      // Its own task: the summary can take minutes and must not hold up a question.
      bot
        .metrics()
        .catch(error => log('metrics failed:', error.message))
        .finally(() => {
          metricsRunning = false
        })
    }
    await sleep(wait)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    log('stopped:', error.message)
    process.exit(1)
  })
}
