// The live connection to Discord: it brings the button taps. It only keeps the connection up and hands taps on.
// Reconnecting starts a new session rather than resuming: a tap missed in that gap shows as failed and can be tapped again.

const URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
const RETRY_MS = 5000
const BAD_TOKEN_MS = 5 * 60 * 1000
const BAD_TOKEN_CODES = new Set([4004, 4014])
const MESSAGE_COMPONENT = 3

export class Gateway {
  constructor({ token, onTap, log = () => {}, Socket = WebSocket, later = setTimeout, every = setInterval, stopEvery = clearInterval }) {
    Object.assign(this, { token, onTap, log, Socket, later, every, stopEvery })
    this.seq = null
    this.beat = null
    this.acked = true
  }

  start() {
    const socket = new this.Socket(URL)
    this.socket = socket
    socket.onmessage = event => this.received(JSON.parse(event.data))
    socket.onclose = event => this.closed(event?.code)
    socket.onerror = () => {} // onclose follows
  }

  send(payload) {
    this.socket.send(JSON.stringify(payload))
  }

  received(message) {
    if (message.s !== null && message.s !== undefined) this.seq = message.s
    if (message.op === 10) {
      this.acked = true
      this.beat = this.every(() => this.heartbeat(), message.d.heartbeat_interval)
      this.send({
        op: 2,
        d: { token: this.token, intents: 0, properties: { os: 'darwin', browser: 'herdr-agents', device: 'herdr-agents' } },
      })
    } else if (message.op === 11) {
      this.acked = true
    } else if (message.op === 1) {
      this.send({ op: 1, d: this.seq })
    } else if (message.op === 7 || message.op === 9) {
      this.socket.close()
    } else if (message.op === 0 && message.t === 'READY') {
      this.log('connected to Discord')
    } else if (message.op === 0 && message.t === 'INTERACTION_CREATE' && message.d?.type === MESSAGE_COMPONENT) {
      this.onTap(message.d)
    }
  }

  heartbeat() {
    // No answer to the last one: the connection is dead even if it looks open.
    if (!this.acked) return this.socket.close()
    this.acked = false
    this.send({ op: 1, d: this.seq })
  }

  closed(code) {
    if (this.beat !== null) this.stopEvery(this.beat)
    this.beat = null
    const bad = BAD_TOKEN_CODES.has(code)
    if (bad) this.log('Discord refused the token; check ~/.herdr-agents/discord-token')
    else this.log(`disconnected (${code ?? 'no code'}), reconnecting`)
    this.later(() => this.start(), bad ? BAD_TOKEN_MS : RETRY_MS)
  }
}
