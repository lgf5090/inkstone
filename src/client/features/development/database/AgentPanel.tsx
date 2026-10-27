import { useEffect, useRef, useState } from 'react'
import { Bot, CheckCircle2, CircleAlert, Loader2, Send, Square, Trash2, Wrench } from 'lucide-react'
import { DATABASE_TOOL_DEFS } from '@shared/development/database/tools'
import { isImeComposing } from '../../../lib/ime'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { Button } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { useUi } from '../../../store/ui'
import { useAgentChat } from './useAgentChat'
import { useAiStatus } from './useAiStatus'
import type { AgentMessagePart } from './types'

export interface AgentPanelProps {
  onToolComplete?: () => void
  className?: string
}

function toolLabel(name: string): string {
  switch (name) {
    case 'list_connections': return t('development.database.agent_tool.list_connections')
    case 'list_tables': return t('development.database.agent_tool.list_tables')
    case 'search_tables': return t('development.database.agent_tool.search_tables')
    case 'get_table_schema': return t('development.database.agent_tool.get_table_schema')
    case 'get_table_ddl': return t('development.database.agent_tool.get_table_ddl')
    case 'list_indexes': return t('development.database.agent_tool.list_indexes')
    case 'get_table_foreign_keys': return t('development.database.agent_tool.get_table_foreign_keys')
    case 'preview_table': return t('development.database.agent_tool.preview_table')
    case 'get_table_row_count': return t('development.database.agent_tool.get_table_row_count')
    case 'run_query': return t('development.database.agent_tool.run_query')
    case 'explain_query': return t('development.database.agent_tool.explain_query')
    default: return name
  }
}

function ToolBadge({ part }: { part: Extract<AgentMessagePart, { type: 'tool-call' }> }) {
  const error = part.state === 'output-error'
  const running = part.state === 'running'
  return (
    <div className={cn('flex items-center gap-1.5 rounded-[var(--r-md)] border px-2 py-1 text-[length:var(--text-11)]', error ? 'border-[var(--danger)]/30 bg-[var(--danger-soft)]' : 'border-[var(--border-subtle)] bg-[var(--bg-inset)]')}>
      <Wrench size={12} className="text-[var(--accent)]" />
      <span className="font-medium text-[var(--text-secondary)]">{toolLabel(part.toolName)}</span>
      {running ? <Loader2 size={12} className="ml-auto animate-spin text-[var(--text-tertiary)]" /> : error ? <CircleAlert size={12} className="ml-auto text-[var(--danger)]" /> : <CheckCircle2 size={12} className="ml-auto text-[var(--success)]" />}
    </div>
  )
}

export function AgentPanel({ onToolComplete, className }: AgentPanelProps) {
  const { messages, status, sendMessage, stop, clear } = useAgentChat({ ...(onToolComplete ? { onToolComplete } : {}) })
  const [tab, setTab] = useState<'agent' | 'mcp'>('agent')
  const [input, setInput] = useState('')
  const { configured, failed, reload } = useAiStatus()
  const bottom = useRef<HTMLDivElement>(null)
  const busy = status === 'submitted' || status === 'streaming'
  const disabled = configured === false
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const suggestions = [
    t('development.database.agent.suggest_tables'),
    t('development.database.agent.suggest_schema'),
    t('development.database.agent.suggest_rows'),
  ]

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages, status])

  const send = () => {
    if (!input.trim() || busy || disabled) return
    sendMessage(input.trim())
    setInput('')
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--border-subtle)]" role="tablist" aria-label={t('development.database.agent.title')}>
        {(['agent', 'mcp'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            onClick={() => setTab(entry)}
            className={cn(
              'flex h-10 flex-1 items-center justify-center gap-1.5 text-[length:var(--text-12)] font-medium transition-colors',
              tab === entry ? 'border-b-2 border-[var(--accent)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
            )}
          >
            {entry === 'agent' ? <Bot size={14} /> : <Wrench size={14} />}
            {entry === 'agent' ? t('development.database.agent.tab_agent') : t('development.database.agent.tab_mcp')}
          </button>
        ))}
      </div>

      {tab === 'agent' ? (
        <>
          {disabled && (
            <div className="shrink-0 border-b border-[var(--warning)]/30 bg-[var(--warning-soft)] p-2.5 text-[length:var(--text-11)] leading-relaxed text-[var(--warning)]">
              <p>{t('development.database.ai.no_model')}</p>
              <Button variant="secondary" size="sm" className="mt-2" onClick={() => useUi.getState().openPanel('settings')}>
                {t('development.database.ai.open_settings')}
              </Button>
            </div>
          )}
          {failed && (
            <div className="shrink-0 border-b border-[var(--danger)]/30 bg-[var(--danger-soft)] p-2.5 text-[length:var(--text-11)] leading-relaxed text-[var(--danger)]">
              <p>{t('development.database.ai.status_failed')}</p>
              <Button variant="secondary" size="sm" className="mt-2" onClick={reload}>
                {t('common.retry')}
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            {messages.length === 0 ? (
              <div className="space-y-2">
                <p className="px-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('development.database.agent.intro')}</p>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={busy || disabled}
                    onClick={() => sendMessage(suggestion)}
                    className="block w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2 text-left text-[length:var(--text-11)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)] disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {messages.map((message) => (
                  <div key={message.id} className={cn('flex gap-2', message.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>
                    <div className={cn('flex size-6 shrink-0 items-center justify-center rounded-full', message.role === 'user' ? 'bg-[var(--accent)] text-[var(--accent-contrast)]' : 'bg-[var(--bg-inset)] text-[var(--text-secondary)]')}>
                      {message.role === 'user' ? <Send size={11} /> : <Bot size={11} />}
                    </div>
                    <div className={cn('flex min-w-0 max-w-[85%] flex-col gap-1', message.role === 'user' ? 'items-end' : 'items-start')}>
                      {message.parts.map((part, index) => part.type === 'text' ? (
                        <div key={index} className={cn('rounded-[var(--r-md)] px-3 py-2 text-[length:var(--text-12)] leading-relaxed break-words whitespace-pre-wrap', message.role === 'user' ? 'bg-[var(--accent)] text-[var(--accent-contrast)]' : 'border border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)]')}>
                          {part.text}
                        </div>
                      ) : (
                        <ToolBadge key={index} part={part} />
                      ))}
                    </div>
                  </div>
                ))}
                {busy && messages[messages.length - 1]?.role === 'assistant' && messages[messages.length - 1]?.parts.length === 0 && (
                  <div className="flex items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    <Loader2 size={12} className="animate-spin" />
                    {t('development.database.agent.thinking')}
                  </div>
                )}
                <div ref={bottom} />
              </div>
            )}
          </div>
          <div className="shrink-0 space-y-1.5 border-t border-[var(--border-subtle)] p-2.5">
            <div className="flex items-center gap-1.5">
              <Input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter' && !event.shiftKey) send() }}
                placeholder={t('development.database.agent.input_placeholder')}
                disabled={busy || disabled}
                className="h-9 flex-1 text-[length:var(--text-11)]"
              />
              {busy ? (
                <Button size="sm" onClick={stop} aria-label={t('development.database.agent.stop')}><Square size={13} /></Button>
              ) : (
                <Button size="sm" onClick={send} disabled={!input.trim() || disabled} aria-label={t('development.database.agent.send')}><Send size={13} /></Button>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.agent.enter_to_send')}</span>
              {messages.length > 0 && (
                <button type="button" onClick={clear} className="flex items-center gap-1 text-[length:var(--text-10)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                  <Trash2 size={11} />
                  {t('development.database.agent.clear')}
                </button>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          <div className="space-y-3">
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
              <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('development.database.mcp.title')}</p>
              <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('development.database.mcp.intro')}</p>
            </div>
            <div>
              <p className="mb-1 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.mcp.endpoint')}</p>
              <code className="block truncate rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-1.5 font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">{origin}{t('development.database.mcp.path')}</code>
            </div>
            <div>
              <p className="mb-1 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.mcp.tools', { count: DATABASE_TOOL_DEFS.length })}</p>
              <div className="space-y-1.5">
                {DATABASE_TOOL_DEFS.map((tool) => (
                  <div key={tool.name} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-2">
                    <p className="font-mono text-[length:var(--text-11)] font-medium text-[var(--accent)]">{tool.name}</p>
                    <p className="mt-0.5 text-[length:var(--text-10)] leading-relaxed text-[var(--text-tertiary)]">{tool.description}</p>
                  </div>
                ))}
              </div>
            </div>
            <p className="rounded-[var(--r-md)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-2 text-[length:var(--text-10)] leading-relaxed text-[var(--warning)]">
              {t('development.database.mcp.scope_hint')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
