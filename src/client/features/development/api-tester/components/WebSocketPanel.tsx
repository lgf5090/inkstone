import { useEffect, useRef, useState } from 'react'
import { Plus, Send, Trash2 } from 'lucide-react'
import { kv } from '@shared/development/api-tester/state'
import type { CollectionNode, KeyValue } from '@shared/development/api-tester/types'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { createWsTicket } from '../api'

type WsStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

interface WsMessage {
  id: string
  direction: 'in' | 'out' | 'system'
  data: string
  ts: number
}

const STATUS_CLASS: Record<WsStatus, string> = {
  idle: 'text-[var(--text-tertiary)]',
  connecting: 'text-[var(--warning)]',
  open: 'text-[var(--success)]',
  closed: 'text-[var(--text-tertiary)]',
  error: 'text-[var(--danger)]',
}

function absoluteSocketUrl(path: string): string {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export function WebSocketPanel({
  node,
  onChange,
}: {
  node: CollectionNode
  onChange: (patch: Partial<CollectionNode>) => void
}) {
  const ws = node.ws ?? { url: '', headers: [] }
  const [messages, setMessages] = useState<WsMessage[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<WsStatus>('idle')
  const socketRef = useRef<WebSocket | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const push = (direction: WsMessage['direction'], data: string) => {
    setMessages((current) => [
      ...current.slice(-499),
      { id: `${Date.now()}-${Math.random()}`, direction, data, ts: Date.now() },
    ])
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    })
  }

  useEffect(() => () => {
    socketRef.current?.close()
    socketRef.current = null
  }, [])

  const connect = async () => {
    if (!ws.url) return
    if (!/^wss?:\/\//i.test(ws.url)) {
      push('system', t('development.apitester.ws_url_invalid'))
      return
    }
    socketRef.current?.close()
    setStatus('connecting')
    push('system', t('development.apitester.ws_connecting_msg', { url: ws.url }))
    try {
      const ticket = await createWsTicket(
        ws.url,
        ws.headers.filter((header) => header.enabled && header.key).map((header) => ({ key: header.key, value: header.value })),
      )
      const socket = new WebSocket(absoluteSocketUrl(ticket.url))
      socketRef.current = socket
      socket.onopen = () => {
        setStatus('open')
        push('system', t('development.apitester.ws_connected_msg'))
      }
      socket.onmessage = (event) => {
        push('in', typeof event.data === 'string' ? event.data : t('development.apitester.binary_data'))
      }
      socket.onerror = () => {
        setStatus('error')
        push('system', t('development.apitester.ws_error_msg'))
      }
      socket.onclose = (event) => {
        setStatus('closed')
        push('system', `${t('development.apitester.ws_closed_msg')}${event.code ? ` (${event.code})` : ''}${event.reason ? ` ${event.reason}` : ''}`)
      }
    } catch (error) {
      setStatus('error')
      push('system', error instanceof Error ? error.message : String(error))
    }
  }

  const disconnect = () => {
    socketRef.current?.close()
    socketRef.current = null
    setStatus('closed')
  }

  const send = () => {
    const socket = socketRef.current
    if (!input || !socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(input)
    push('out', input)
    setInput('')
  }

  const updateHeaders = (headers: KeyValue[]) => onChange({ ws: { ...ws, headers } })

  const statusLabel: Record<WsStatus, string> = {
    idle: t('development.apitester.disconnected'),
    connecting: t('development.apitester.connecting'),
    open: t('development.apitester.connected'),
    closed: t('development.apitester.disconnected'),
    error: t('development.apitester.ws_error'),
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] px-2 py-1.5">
        <Input
          value={ws.url}
          onChange={(event) => onChange({ ws: { ...ws, url: event.target.value } })}
          placeholder={t('development.apitester.ws_url_placeholder')}
          aria-label={t('development.apitester.ws_url_placeholder')}
          className="h-8 min-w-[160px] flex-1 font-mono text-[length:var(--text-11-5)]"
        />
        <span className={cn('shrink-0 text-[length:var(--text-11)]', STATUS_CLASS[status])}>{statusLabel[status]}</span>
        {status === 'open' ? (
          <Button size="sm" variant="danger" onClick={disconnect}>{t('development.apitester.disconnect')}</Button>
        ) : (
          <Button size="sm" disabled={!ws.url || status === 'connecting'} onClick={() => void connect()}>{t('development.apitester.connect')}</Button>
        )}
      </div>
      <details className="shrink-0 border-b border-[var(--border-subtle)] px-2 py-1">
        <summary className="cursor-pointer text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.apitester.headers')}</summary>
        <div className="space-y-1 py-1">
          {ws.headers.map((header) => (
            <div key={header.id} className="flex items-center gap-1">
              <Input
                value={header.key}
                onChange={(event) => updateHeaders(ws.headers.map((entry) => entry.id === header.id ? { ...entry, key: event.target.value } : entry))}
                placeholder={t('development.apitester.key_name')}
                aria-label={t('development.apitester.key_name')}
                className="h-7 min-w-0 flex-1 font-mono text-[length:var(--text-11)]"
              />
              <Input
                value={header.value}
                onChange={(event) => updateHeaders(ws.headers.map((entry) => entry.id === header.id ? { ...entry, value: event.target.value } : entry))}
                placeholder={t('development.apitester.key_value')}
                aria-label={t('development.apitester.key_value')}
                className="h-7 min-w-0 flex-1 font-mono text-[length:var(--text-11)]"
              />
              <IconButton label={t('development.apitester.delete')} size="sm" onClick={() => updateHeaders(ws.headers.filter((entry) => entry.id !== header.id))}>
                <Trash2 size={12} />
              </IconButton>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="gap-1 text-[length:var(--text-11)]" onClick={() => updateHeaders([...ws.headers, kv()])}>
              <Plus size={12} /> {t('development.apitester.add')}
            </Button>
            <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('development.apitester.ws.relay_hint')}</span>
          </div>
        </div>
      </details>
      <div className="relative min-h-0 flex-1">
        <div ref={logRef} className="h-full overflow-y-auto overscroll-contain bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-11)]">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[var(--text-tertiary)]">{t('development.apitester.no_messages')}</div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className="mb-1 flex gap-1">
                <span className="shrink-0 text-[var(--text-quaternary)]">[{new Date(message.ts).toLocaleTimeString()}]</span>
                <span className={cn(
                  'min-w-0 break-all',
                  message.direction === 'in' ? 'text-[var(--success)]' : message.direction === 'out' ? 'text-[var(--accent)]' : 'italic text-[var(--text-tertiary)]',
                )}>{message.data}</span>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--border-subtle)] p-2">
        <Input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) send()
          }}
          placeholder={t('development.apitester.message_placeholder')}
          aria-label={t('development.apitester.message_placeholder')}
          className="h-8 min-w-0 flex-1 font-mono text-[length:var(--text-11-5)]"
        />
        <Button size="sm" className="gap-1" disabled={status !== 'open' || !input} onClick={send}>
          <Send size={13} /> {t('development.apitester.send_message')}
        </Button>
      </div>
    </div>
  )
}
