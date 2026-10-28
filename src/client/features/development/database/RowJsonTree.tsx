import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Copy, Search, X } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Input } from '../../../components/form'

interface RowJsonTreeProps {
  data: Record<string, unknown>
  className?: string
}

type JsonValue = unknown

const MAX_NODES = 800

function display(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === 'object') return `{${Object.keys(value as object).length}}`
  return String(value)
}

function pathLabel(path: string[]): string {
  return path.length === 0 ? '$' : `$.${path.join('.')}`
}

function matches(value: JsonValue, key: string, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  if (key.toLowerCase().includes(needle)) return true
  if (value === null || typeof value !== 'object') return String(value).toLowerCase().includes(needle)
  return false
}

function collect(value: JsonValue, query: string, budget: { left: number }): boolean {
  if (budget.left <= 0) return false
  budget.left--
  if (value === null || typeof value !== 'object') return true
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, JsonValue>)
  return entries.some(([key, child]) => matches(child, key, query) || collect(child, query, budget))
}

export function RowJsonTree({ data, className }: RowJsonTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['$']))
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  const visible = useMemo(() => {
    if (!query.trim()) return data
    const budget = { left: MAX_NODES }
    const entries = Object.entries(data).filter(([key, value]) => matches(value, key, query) || collect(value, query, budget))
    return Object.fromEntries(entries)
  }, [data, query])

  const toggle = (path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const copy = async (text: string) => {
    const ok = await copyText(text)
    setCopied(ok ? text : null)
    useUi.getState().toast({
      title: ok ? t('development.database.common.copied') : t('development.database.common.copy_failed'),
      tone: ok ? 'success' : 'danger',
    })
  }

  const rows: ReactNode[] = []
  let nodes = 0

  const walk = (value: JsonValue, key: string, path: string[], depth: number) => {
    if (nodes >= MAX_NODES) return
    nodes++
    const container = value !== null && typeof value === 'object'
    const open = expanded.has(pathLabel(path)) || Boolean(query.trim())
    const entries = container
      ? Array.isArray(value)
        ? value.map((item, index) => [String(index), item] as const)
        : Object.entries(value as Record<string, JsonValue>)
      : []
    const rowPath = pathLabel(path)
    rows.push(
      <div
        key={rowPath}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={container ? open : undefined}
        className={cn(
          'group flex min-h-8 items-start gap-1.5 rounded-[var(--r-sm)] px-1.5 py-1 text-[length:var(--text-12)]',
          'hover:bg-[var(--bg-hover)]',
        )}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {container ? (
          <button
            type="button"
            onClick={() => toggle(rowPath)}
            aria-label={open ? t('development.database.detail.collapse') : t('development.database.detail.expand')}
            className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
          >
            <ChevronRight size={13} className={cn('transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="mt-0.5 size-[13px] shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 break-words">
          <span className="font-mono text-[var(--text-secondary)]">{key}</span>
          <span className="text-[var(--text-quaternary)]">: </span>
          <span
            className={cn(
              'font-mono',
              value === null && 'italic text-[var(--text-quaternary)]',
              typeof value === 'number' && 'tabular-nums text-[var(--accent)]',
              typeof value === 'string' && 'text-[var(--text-primary)]',
              typeof value === 'boolean' && 'text-[var(--warning)]',
              container && 'text-[var(--text-tertiary)]',
            )}
          >
            {display(value)}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void copy(JSON.stringify(value, null, 2))}
          aria-label={t('development.database.detail.copy_value')}
          title={t('development.database.detail.copy_value')}
          className="shrink-0 rounded p-1 text-[var(--text-quaternary)] opacity-0 transition-opacity hover:text-[var(--text-secondary)] group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Copy size={12} />
        </button>
        {copied === JSON.stringify(value, null, 2) && (
          <span className="shrink-0 text-[length:var(--text-10)] text-[var(--success)]">
            {t('development.database.common.copied')}
          </span>
        )}
      </div>,
    )
    if (container && open) {
      for (const [childKey, child] of entries) walk(child, childKey, [...path, childKey], depth + 1)
    }
  }

  for (const [key, value] of Object.entries(visible)) {
    walk(value, key, [key], 0)
    if (nodes >= MAX_NODES) break
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="relative shrink-0 px-2 pb-2">
        <Search size={13} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('development.database.detail.search')}
          aria-label={t('development.database.detail.search')}
          className="pl-8 pr-8"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label={t('development.database.common.clear')}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div role="tree" aria-label={t('development.database.detail.tree')} className="min-h-0 flex-1 overflow-auto overscroll-contain px-1">
        {rows.length === 0 ? (
          <div className="px-2 py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('development.database.detail.no_match')}
          </div>
        ) : rows}
        {nodes >= MAX_NODES && (
          <div className="px-2 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('development.database.detail.too_many')}
          </div>
        )}
      </div>
    </div>
  )
}
