import { Radio, Webhook, X } from 'lucide-react'
import type { CollectionNode, RequestKind, ResponseResult } from '@shared/development/api-tester/types'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'

function kindOf(node: CollectionNode): RequestKind {
  return (node.kind ?? 'rest') as RequestKind
}

function statusClass(status?: number): string {
  if (!status) return ''
  if (status >= 200 && status < 300) return 'text-[var(--success)]'
  if (status >= 400) return 'text-[var(--danger)]'
  return 'text-[var(--warning)]'
}

export function TabBar({
  tabs,
  activeId,
  results,
  loading,
  onSelect,
  onClose,
}: {
  tabs: CollectionNode[]
  activeId: string | null
  results: Record<string, ResponseResult>
  loading: Record<string, boolean>
  onSelect: (id: string) => void
  onClose: (id: string) => void
}) {
  if (tabs.length === 0) return null
  return (
    <div role="tablist" aria-label={t('development.apitester.tabs.label')} className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
      {tabs.map((node) => {
        const active = node.id === activeId
        const kind = kindOf(node)
        const status = results[node.id]?.status ?? node.lastStatus ?? 0
        return (
          <div
            key={node.id}
            role="presentation"
            className={cn(
              'group flex min-w-[132px] max-w-[220px] items-center gap-1.5 border-r border-[var(--border-subtle)] px-2',
              'border-t-2 text-[length:var(--text-12)] transition-colors',
              active
                ? 'border-t-[var(--accent)] bg-[var(--bg-base)] text-[var(--text-primary)]'
                : 'border-t-transparent text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(node.id)}
              aria-keyshortcuts="Delete Backspace"
              onKeyDown={(event) => {
                const list = event.currentTarget.closest('[role="tablist"]')
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault()
                  const index = tabs.findIndex((entry) => entry.id === node.id)
                  const neighbor = tabs[index + 1] ?? tabs[index - 1]
                  onClose(node.id)
                  if (neighbor) list?.querySelector<HTMLElement>(`[data-tab="${neighbor.id}"]`)?.focus()
                  return
                }
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
                event.preventDefault()
                const index = tabs.findIndex((entry) => entry.id === node.id)
                const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
                if (next) {
                  list?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus()
                  onSelect(next.id)
                }
              }}
              data-tab={node.id}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              {kind === 'websocket' ? (
                <Radio size={12} className="shrink-0 text-[var(--accent)]" />
              ) : kind === 'graphql' ? (
                <Webhook size={12} className="shrink-0 text-[var(--accent)]" />
              ) : (
                <span className="shrink-0 font-mono text-[length:var(--text-10)] font-semibold text-[var(--text-secondary)]">
                  {node.request?.method?.slice(0, 4) ?? 'GET'}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {status > 0 && <span className={cn('shrink-0 font-mono text-[length:var(--text-10)]', statusClass(status))}>{status}</span>}
              {loading[node.id] && <span className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" />}
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('development.apitester.tabs.close')}
              title={t('development.apitester.tabs.close')}
              onClick={() => onClose(node.id)}
              className="flex size-4 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
