// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  createWsTicket: vi.fn(),
}))

vi.mock('../src/client/features/development/api-tester/api', () => apiMock)

const {
  closeAllWsSessions,
  closeWsSession,
  connectWs,
  disconnectWs,
  sendWsMessage,
  subscribeWsSessions,
  wsSessionOf,
} = await import('../src/client/features/development/api-tester/ws-session')

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  apiMock.createWsTicket.mockReset()
  apiMock.createWsTicket.mockResolvedValue({ ticket: 't1', url: '/api/development/api-tester/ws?ticket=t1' })
  closeAllWsSessions()
})

describe('API Tester WebSocket sessions', () => {
  it('keeps the transcript and the socket when the panel goes away', async () => {
    await connectWs('node-1', 'wss://example.com/socket', [])
    const socket = FakeSocket.instances[0]!
    expect(socket.url).toContain('/api/development/api-tester/ws?ticket=t1')

    socket.open()
    expect(wsSessionOf('node-1').status).toBe('open')

    socket.onmessage?.({ data: 'hello' })
    expect(wsSessionOf('node-1').messages.at(-1)).toMatchObject({ direction: 'in', data: 'hello' })

    // The panel unmounting does not call anything; the session is read again by node id.
    expect(wsSessionOf('node-1').status).toBe('open')
    expect(wsSessionOf('node-1').messages.some((message) => message.data === 'hello')).toBe(true)
  })

  it('sends through the retained socket and records the outgoing frame', async () => {
    await connectWs('node-2', 'wss://example.com/socket', [])
    const socket = FakeSocket.instances[0]!

    expect(sendWsMessage('node-2', 'early')).toBe(false)
    socket.open()

    expect(sendWsMessage('node-2', 'ping')).toBe(true)
    expect(socket.sent).toEqual(['ping'])
    expect(wsSessionOf('node-2').messages.at(-1)).toMatchObject({ direction: 'out', data: 'ping' })
  })

  it('notifies subscribers and caps the transcript', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeWsSessions(listener)
    await connectWs('node-3', 'wss://example.com/socket', [])
    const socket = FakeSocket.instances[0]!
    socket.open()

    for (let index = 0; index < 520; index++) socket.onmessage?.({ data: `m${index}` })

    expect(listener).toHaveBeenCalled()
    expect(wsSessionOf('node-3').messages).toHaveLength(500)
    expect(wsSessionOf('node-3').messages.at(-1)?.data).toBe('m519')
    unsubscribe()
  })

  it('replaces the old socket when reconnecting and closes it on disconnect', async () => {
    await connectWs('node-4', 'wss://example.com/a', [])
    const first = FakeSocket.instances[0]!
    first.open()

    await connectWs('node-4', 'wss://example.com/b', [])
    const second = FakeSocket.instances[1]!
    expect(first.closed).toBe(true)
    second.open()

    disconnectWs('node-4')
    expect(second.closed).toBe(true)
    expect(wsSessionOf('node-4').status).toBe('closed')
  })

  it('drops the conversation when the request is deleted', async () => {
    await connectWs('node-5', 'wss://example.com/socket', [])
    const socket = FakeSocket.instances[0]!
    socket.open()

    closeWsSession('node-5')

    expect(socket.closed).toBe(true)
    expect(wsSessionOf('node-5')).toMatchObject({ status: 'idle', messages: [] })
  })

  it('refuses a non-WebSocket URL with a system message instead of opening a socket', async () => {
    await connectWs('node-6', 'https://example.com/socket', [])

    expect(FakeSocket.instances).toHaveLength(0)
    expect(wsSessionOf('node-6').messages.at(-1)?.direction).toBe('system')
  })
})
