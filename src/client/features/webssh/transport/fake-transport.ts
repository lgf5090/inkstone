/**
 * A demo shell that never touches SSH. Every byte it writes is produced locally, and the UI says so
 * on screen (the "demo transport" badge) — it must never be mistaken for a real connection.
 *
 * It exists so the W4 terminal can be exercised end to end (echo, resize, tabs, copy/paste, drop and
 * reconnect) before W2 lands. `drop` simulates the server going away; reconnection is the UI layer's
 * job, not this transport's.
 */
import type {
  TerminalTransport,
  TerminalTransportHandlers,
  TransportConnectOptions,
} from './types'

const CONNECT_DELAY_MS = 320
const PROMPT = 'demo@inkstone:~$ '
const WELCOME = [
  '\x1b[2mInkstone WebSSH\x1b[0m',
  'Transport: \x1b[33mfake\x1b[0m — this is a local demo shell, not a real SSH connection.',
  'The real SSH link arrives with W2. Type "help" for the demo commands.',
  '',
  PROMPT,
].join('\r\n')

type Timer = ReturnType<typeof setTimeout>

export class FakeTerminalTransport implements TerminalTransport {
  readonly kind = 'fake' as const

  private readonly handlers: TerminalTransportHandlers
  private cols = 80
  private rows = 24
  private open = false
  private disposed = false
  private connectTimer: Timer | undefined
  private line = ''
  private history: string[] = []
  private historyIndex = 0

  constructor(handlers: TerminalTransportHandlers) {
    this.handlers = handlers
  }

  connect(options: TransportConnectOptions): void {
    this.cols = options.cols
    this.rows = options.rows
    this.handlers.onPhase({ phase: 'connecting' })
    this.connectTimer = setTimeout(() => {
      if (this.disposed) return
      this.open = true
      this.handlers.onPhase({ phase: 'open' })
      this.emit(WELCOME)
    }, CONNECT_DELAY_MS)
  }

  send(data: string): void {
    if (this.disposed || !this.open) return
    let index = 0
    while (index < data.length) {
      const char = data[index]!
      if (char === '\x1b') {
        index += this.handleEscape(data, index)
        continue
      }
      this.handleChar(char)
      index += 1
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
  }

  close(): void {
    if (this.disposed) return
    this.open = false
    this.handlers.onPhase({ phase: 'closed', reason: 'client' })
  }

  dispose(): void {
    this.disposed = true
    this.open = false
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = undefined
  }

  /** Only the demo transport offers this: it is the drop button's whole reason to exist. */
  simulateDrop(): void {
    if (this.disposed || !this.open) return
    this.open = false
    this.emit('\r\n\x1b[31m[inkstone] Connection dropped by the demo transport.\x1b[0m\r\n')
    this.handlers.onPhase({ phase: 'closed', reason: 'demo-drop' })
  }

  private emit(text: string): void {
    this.handlers.onOutput(text)
  }

  private handleChar(char: string): void {
    if (char === '\r' || char === '\n') {
      if (char === '\n') return
      const line = this.line
      this.line = ''
      this.emit('\r\n')
      this.execute(line.trim())
      return
    }
    if (char === '\x7f') {
      if (this.line.length === 0) return
      this.line = this.line.slice(0, -1)
      this.emit('\b \b')
      return
    }
    if (char === '\x03') {
      this.line = ''
      this.emit('^C\r\n' + PROMPT)
      return
    }
    if (char === '\t') {
      this.emit('\t')
      return
    }
    if (char >= '\x20' && char !== '\x7f') {
      this.line += char
      this.emit(char)
    }
  }

  /**
   * Consumes an escape sequence starting at `start` and returns how many characters it used:
   * arrow keys drive the demo history, every other CSI/SS3 sequence is swallowed.
   */
  private handleEscape(data: string, start: number): number {
    const next = data[start + 1]
    if (next === '[') {
      const applied = data[start + 2]
      if (applied === 'A') {
        this.recallHistory(-1)
        return 3
      }
      if (applied === 'B') {
        this.recallHistory(1)
        return 3
      }
      // A CSI sequence ends with a byte in the range 0x40–0x7e.
      let index = start + 2
      while (index < data.length) {
        const code = data.charCodeAt(index)
        index += 1
        if (code >= 0x40 && code <= 0x7e) break
      }
      return index - start
    }
    if (next === 'O') return Math.min(3, data.length - start)
    return 1
  }

  private recallHistory(delta: number): void {
    if (this.history.length === 0) return
    const next = Math.min(this.history.length, Math.max(0, this.historyIndex + delta))
    this.historyIndex = next
    this.line = this.history[next] ?? ''
    this.emit(`\r\x1b[2K${PROMPT}${this.line}`)
  }

  private execute(command: string): void {
    if (command) {
      this.history.push(command)
      this.historyIndex = this.history.length
    }
    const [name = '', ...args] = command.split(/\s+/)
    switch (name) {
      case '':
        break
      case 'help':
        this.emit(
          [
            'Demo commands:',
            '  help              this list',
            '  echo <text>       print text',
            '  pwd               print the demo working directory',
            '  whoami            print the demo user',
            '  uname -a          print the demo platform',
            '  date              print the current date',
            '  stty size         print the last reported terminal size',
            '  clear             clear the screen',
            '  drop              simulate a dropped connection',
            '  exit              close the demo shell',
            '',
          ].join('\r\n'),
        )
        break
      case 'echo':
        this.emit(`${args.join(' ')}\r\n`)
        break
      case 'pwd':
        this.emit('/home/demo\r\n')
        break
      case 'whoami':
        this.emit('demo\r\n')
        break
      case 'uname':
        this.emit('Inkstone demo shell (fake transport, no SSH)\r\n')
        break
      case 'date':
        this.emit(`${new Date().toISOString()}\r\n`)
        break
      case 'stty':
        if (args[0] === 'size') this.emit(`${this.rows} ${this.cols}\r\n`)
        else this.emit('stty: demo shell only supports "stty size"\r\n')
        break
      case 'clear':
        this.emit('\x1b[2J\x1b[H')
        break
      case 'drop':
        this.simulateDrop()
        return
      case 'exit':
      case 'logout':
        this.emit('Connection closed by the demo transport.\r\n')
        this.open = false
        this.handlers.onPhase({ phase: 'closed', reason: 'eof' })
        return
      default:
        this.emit(`bash: ${name}: command not found\r\n`)
    }
    this.emit(PROMPT)
  }
}
