import { t } from '../../../lib/i18n'
import { createWsTicket } from './api'

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export interface WsMessage {
  id: string
  direction: 'in' | 'out' | 'system'
  data: string
  ts: number
}

export interface WsSession {
  status: WsStatus
  messages: WsMessage[]
}

const MAX_MESSAGES = 500
const EMPTY_SESSION: WsSession = { status: 'idle', messages: [] }

/**
 * Socket sessions outlive the panel that shows them.
 *
 * A tab switch unmounts the panel but must not drop the connection or the transcript: the node id
 * owns both, so coming back shows the same conversation and the socket is closed only on an explicit
 * disconnect, a deleted node, or leaving the module.
 */
const sessions = new Map<string, WsSession>()
const sockets = new Map<string, WebSocket>()
const listeners = new Set<() => void>()
let messageSequence = 0

function emit(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeWsSessions(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function wsSessionOf(nodeId: string): WsSession {
  return sessions.get(nodeId) ?? EMPTY_SESSION
}

function patch(nodeId: string, change: Partial<WsSession>): void {
  const current = sessions.get(nodeId) ?? EMPTY_SESSION
  sessions.set(nodeId, { ...current, ...change })
  emit()
}

function push(nodeId: string, direction: WsMessage['direction'], data: string): void {
  const current = sessions.get(nodeId) ?? EMPTY_SESSION
  messageSequence += 1
  const message: WsMessage = { id: `m${messageSequence}`, direction, data, ts: Date.now() }
  patch(nodeId, { messages: [...current.messages.slice(-(MAX_MESSAGES - 1)), message] })
}

function absoluteSocketUrl(path: string): string {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function dropSocket(nodeId: string): void {
  const socket = sockets.get(nodeId)
  if (!socket) return
  sockets.delete(nodeId)
  socket.onopen = null
  socket.onmessage = null
  socket.onerror = null
  socket.onclose = null
  try {
    socket.close()
  } catch {
    // The peer may already be gone; the session state below is what the user sees either way.
  }
}

export async function connectWs(
  nodeId: string,
  url: string,
  headers: Array<{ key: string; value: string }>,
): Promise<void> {
  if (!url) return
  if (!/^wss?:\/\//i.test(url)) {
    push(nodeId, 'system', t('development.apitester.ws_url_invalid'))
    return
  }
  dropSocket(nodeId)
  patch(nodeId, { status: 'connecting' })
  push(nodeId, 'system', t('development.apitester.ws_connecting_msg', { url }))
  try {
    const ticket = await createWsTicket(url, headers)
    if (sessions.get(nodeId)?.status !== 'connecting') return
    const socket = new WebSocket(absoluteSocketUrl(ticket.url))
    sockets.set(nodeId, socket)
    socket.onopen = () => {
      patch(nodeId, { status: 'open' })
      push(nodeId, 'system', t('development.apitester.ws_connected_msg'))
    }
    socket.onmessage = (event) => {
      push(nodeId, 'in', typeof event.data === 'string' ? event.data : t('development.apitester.binary_data'))
    }
    socket.onerror = () => {
      patch(nodeId, { status: 'error' })
      push(nodeId, 'system', t('development.apitester.ws_error_msg'))
    }
    socket.onclose = (event) => {
      if (sockets.get(nodeId) === socket) sockets.delete(nodeId)
      patch(nodeId, { status: 'closed' })
      push(
        nodeId,
        'system',
        `${t('development.apitester.ws_closed_msg')}${event.code ? ` (${event.code})` : ''}${event.reason ? ` ${event.reason}` : ''}`,
      )
    }
  } catch (error) {
    patch(nodeId, { status: 'error' })
    push(nodeId, 'system', error instanceof Error ? error.message : String(error))
  }
}

export function disconnectWs(nodeId: string): void {
  dropSocket(nodeId)
  patch(nodeId, { status: 'closed' })
}

export function sendWsMessage(nodeId: string, text: string): boolean {
  const socket = sockets.get(nodeId)
  if (!socket || socket.readyState !== 1 || !text) return false
  socket.send(text)
  push(nodeId, 'out', text)
  return true
}

/** A deleted request takes its conversation with it. */
export function closeWsSession(nodeId: string): void {
  dropSocket(nodeId)
  sessions.delete(nodeId)
  emit()
}

export function closeAllWsSessions(): void {
  for (const nodeId of [...sockets.keys()]) dropSocket(nodeId)
  sessions.clear()
  emit()
}
