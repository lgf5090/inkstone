import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Plus, Send, Trash2 } from 'lucide-react'
import { kv } from '@shared/development/api-tester/state'
import type { CollectionNode, KeyValue } from '@shared/development/api-tester/types'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import {
  connectWs,
  disconnectWs,
  sendWsMessage,
  subscribeWsSessions,
  wsSessionOf,
  type WsStatus,
} from '../ws-session'

const STATUS_CLASS: Record<WsStatus, string> = {
  idle: 'text-[var(--text-tertiary)]',
  connecting: 'text-[var(--warning)]',
  open: 'text-[var(--success)]',
  closed: 'text-[var(--text-tertiary)]',
  error: 'text-[var(--danger)]',
}

export function WebSocketPanel({
  node,
  onChange,
}: {
  node: CollectionNode
  onChange: (patch: Partial<CollectionNode>) => void
}) {
  const ws = node.ws ?? { url: '', headers: [] }
  const session = useSyncExternalStore(
    subscribeWsSessions,
    () => wsSessionOf(node.id),
    () => wsSessionOf(node.id),
  )
  const { status, messages } = session
  const [input, setInput] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages])

  const connect = () => {
    void connectWs(
      node.id,
      ws.url,
      ws.headers.filter((header) => header.enabled && header.key).map((header) => ({ key: header.key, value: header.value })),
    )
  }

  const send = () => {
    if (sendWsMessage(node.id, input)) setInput('')
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
          <Button size="sm" variant="danger" onClick={() => disconnectWs(node.id)}>{t('development.apitester.disconnect')}</Button>
        ) : (
          <Button size="sm" disabled={!ws.url || status === 'connecting'} onClick={connect}>{t('development.apitester.connect')}</Button>
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
