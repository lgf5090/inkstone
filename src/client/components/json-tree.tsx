import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../lib/cn'
import { t } from '../lib/i18n'
import { Input } from './form'

const MAX_NODES = 800

type JsonValue = unknown

function isContainer(value: JsonValue): value is Record<string, JsonValue> | JsonValue[] {
  return value !== null && typeof value === 'object'
}

function entriesOf(value: JsonValue): Array<[string, JsonValue]> {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item])
  if (value && typeof value === 'object') return Object.entries(value as Record<string, JsonValue>)
  return []
}

function preview(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === 'object') return `{${Object.keys(value as object).length}}`
  return String(value)
}

function valueTone(value: JsonValue): string {
  if (value === null) return 'text-[var(--text-quaternary)]'
  if (typeof value === 'string') return 'text-[var(--success)]'
  if (typeof value === 'number') return 'text-[var(--accent)]'
  if (typeof value === 'boolean') return 'text-[var(--warning)]'
  return 'text-[var(--text-secondary)]'
}

function pathKey(path: readonly (string | number)[]): string {
  return path.length === 0 ? '$' : path.join('\u0000')
}

function collectExpanded(
  value: JsonValue,
  depth: number,
  maxDepth: number,
  path: Array<string | number>,
  out: Set<string>,
): void {
  if (!isContainer(value) || depth >= maxDepth) return
  out.add(pathKey(path))
  for (const [key, child] of entriesOf(value)) {
    collectExpanded(child, depth + 1, maxDepth, [...path, key], out)
  }
}

function collectMatches(
  value: JsonValue,
  key: string,
  query: string,
  path: Array<string | number>,
  visible: Set<string>,
  ancestors: Array<Array<string | number>>,
  budget: { left: number },
): boolean {
  if (budget.left <= 0) return false
  budget.left -= 1
  const needle = query.toLowerCase()
  const own = key.toLowerCase().includes(needle) || (!isContainer(value) && String(value).toLowerCase().includes(needle))
  let childMatch = false
  for (const [childKey, child] of entriesOf(value)) {
    childMatch = collectMatches(child, childKey, query, [...path, childKey], visible, [...ancestors, [...path, childKey]], budget) || childMatch
  }
  if (own || childMatch) {
    visible.add(pathKey(path))
    for (const ancestor of ancestors) visible.add(pathKey(ancestor))
    return true
  }
  return false
}

export function JsonTree({
  data,
  className,
  searchable = true,
  defaultExpandedDepth = 1,
}: {
  data: JsonValue
  className?: string
  searchable?: boolean
  defaultExpandedDepth?: number
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    const next = new Set<string>()
    collectExpanded(data, 0, defaultExpandedDepth, [], next)
    setExpanded(next)
    setQuery('')
  }, [data, defaultExpandedDepth])

  const visible = useMemo(() => {
    if (!query.trim()) return null
    const set = new Set<string>()
    collectMatches(data, '$', query.trim(), [], set, [], { left: MAX_NODES * 2 })
    return set
  }, [data, query])

  useEffect(() => {
    if (!visible) return
    setExpanded((current) => {
      const next = new Set(current)
      visible.forEach((key) => next.add(key))
      return next
    })
  }, [visible])

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  let count = 0
  const render = (value: JsonValue, key: string, path: Array<string | number>, depth: number): React.ReactNode => {
    if (count > MAX_NODES) return null
    count += 1
    const keyPath = pathKey(path)
    if (visible && !visible.has(keyPath)) return null
    const container = isContainer(value)
    const open = expanded.has(keyPath)
    const label = depth === 0 ? '$' : key
    return (
      <div key={keyPath} className="min-w-0">
        <div
          className={cn('flex min-w-0 items-start gap-1 rounded-[var(--r-xs)] px-1 hover:bg-[var(--bg-hover)]')}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          {container ? (
            <button
              type="button"
              aria-label={open ? t('development.apitester.common.collapse') : t('development.apitester.common.expand')}
              aria-expanded={open}
              onClick={() => toggle(keyPath)}
              className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] hover:text-[var(--text-primary)]"
            >
              <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} />
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <span className="shrink-0 font-mono text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{label}</span>
          <span className="shrink-0 text-[var(--text-quaternary)]">:</span>
          <span
            className={cn('min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[length:var(--text-11-5)]', valueTone(value))}
            title={typeof value === 'string' ? value : undefined}
          >
            {preview(value)}
          </span>
        </div>
        {container && open && (
          <div>
            {entriesOf(value).map(([childKey, child]) => render(child, childKey, [...path, childKey], depth + 1))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {searchable && (
        <div className="shrink-0 border-b border-[var(--border-subtle)] p-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('development.apitester.common.search_json')}
            aria-label={t('development.apitester.common.search_json')}
            className="h-7 font-mono text-[length:var(--text-11-5)]"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-1 font-mono text-[length:var(--text-12)]">
        {render(data, '$', [], 0)}
        {count > MAX_NODES && (
          <p className="px-2 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('development.apitester.common.tree_truncated', { count: MAX_NODES })}
          </p>
        )}
      </div>
    </div>
  )
}
