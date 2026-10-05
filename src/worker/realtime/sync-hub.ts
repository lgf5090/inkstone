import type { RealtimeMessage } from '@shared/types'
import { timingSafeEqual } from '../lib/encoding'
import type { Env } from '../env'


export class SyncHub implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env?: Env) {}

  async fetch(request: Request): Promise<Response> {
    const internalKey = this.env?.DO_AUTH_KEY
    if (internalKey && !timingSafeEqual(request.headers.get('X-Inkstone-Internal') ?? '', internalKey)) {
      return new Response('Unauthorized', { status: 401 })
    }
    const url = new URL(request.url)

    if (url.pathname === '/notify') {
      const body = (await request.json().catch(() => ({}))) as {
        cursor?: number
        origin?: string | null
      }
      const cursor = Number(body.cursor)
      this.broadcast({
        type: 'changed',
        cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
        origin: typeof body.origin === 'string' ? body.origin.slice(0, 128) : null,
      })
      return new Response(null, { status: 204 })
    }

    if (url.pathname === '/connect') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('WebSocket upgrade required', { status: 426 })
      }
      if (this.state.getWebSockets().length >= 32) {
        return new Response('Too many realtime connections', { status: 429 })
      }
      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]

      this.state.acceptWebSocket(server)
      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response('Unknown path', { status: 404 })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return
    if (message.length > 1024) {
      ws.close(1009, 'Message too large')
      return
    }
    let parsed: RealtimeMessage | null = null
    try {
      parsed = JSON.parse(message) as RealtimeMessage
    } catch {
      return
    }
    if (parsed?.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() } satisfies RealtimeMessage))
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {

    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {

    }
  }

  webSocketError(): void {

  }

  private broadcast(message: RealtimeMessage): void {
    const payload = JSON.stringify(message)
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(payload)
      } catch {

      }
    }
  }
}


export async function notifySyncHub(
  namespace: DurableObjectNamespace | undefined,
  userId: string,
  cursor: number,
  origin: string | null,
  authKey?: string,
): Promise<void> {
  if (!namespace) return
  try {
    const stub = namespace.get(namespace.idFromName(userId))
    await stub.fetch('https://sync-hub.internal/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authKey ? { 'X-Inkstone-Internal': authKey } : {}),
      },
      body: JSON.stringify({ cursor, origin }),
    })
  } catch (err) {

    console.warn('[inkstone] Realtime broadcast failed:', err instanceof Error ? err.message : err)
  }
}
