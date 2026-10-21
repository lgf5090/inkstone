import { useSyncExternalStore } from 'react'
import { MEMO_ORDER_FIELDS, type MemoDisplayPreferences, type MemoOrderDirection, type MemoOrderField } from '@shared/memos/types'

export interface MemoUrlState {
  q: string
  tag: string | null
  filter: string
  spaceId: string | null
  orderBy: MemoOrderField | null
  order: MemoOrderDirection | null
  columns: MemoDisplayPreferences['columns'] | null
  compact: boolean | null
  linkPreview: boolean | null
}

export interface MemoSearchInput {
  q?: string
  tag?: string | null
  filter?: string
  spaceId?: string | null
  orderBy?: MemoOrderField
  order?: MemoOrderDirection
  display?: MemoDisplayPreferences
}

const DEFAULT_ORDER_BY: MemoOrderField = 'created'
const DEFAULT_ORDER: MemoOrderDirection = 'desc'

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) window.addEventListener('popstate', emit)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('popstate', emit)
  }
}

function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search
}

export function useMemoSearch(): string {
  return useSyncExternalStore(subscribe, currentSearch, () => '')
}

function orderField(value: string): MemoOrderField | null {
  return (MEMO_ORDER_FIELDS as readonly string[]).includes(value) ? value as MemoOrderField : null
}

function orderDirection(value: string): MemoOrderDirection | null {
  return value === 'asc' || value === 'desc' ? value : null
}

function displayColumns(value: string): MemoDisplayPreferences['columns'] | null {
  if (value === '1') return 1
  if (value === '2') return 2
  if (value === '3') return 3
  if (value === 'auto') return 'auto'
  return null
}

export function readMemoUrlState(search: string): MemoUrlState {
  const params = new URLSearchParams(search)
  const sort = params.get('sort')
  const [sortField, sortDirection] = sort ? sort.split('-') : []
  const parsedOrderBy = sortField ? orderField(sortField) : null
  const parsedOrder = sortDirection ? orderDirection(sortDirection) : null
  let columns: MemoDisplayPreferences['columns'] | null = null
  let compact: boolean | null = null
  let linkPreview: boolean | null = null
  const display = params.get('display')
  if (display) {
    for (const token of display.split(',')) {
      const parsed = displayColumns(token)
      if (parsed !== null) columns = parsed
      else if (token === 'compact') compact = true
      else if (token === 'comfortable') compact = false
      else if (token === 'link-preview') linkPreview = true
      else if (token === 'no-link-preview') linkPreview = false
    }
  }
  const tag = params.get('tag')?.trim().replace(/^#/, '')
  return {
    q: params.get('q')?.trim() ?? '',
    tag: tag ? tag : null,
    filter: params.get('filter') ?? '',
    spaceId: params.get('space')?.trim() || null,
    orderBy: parsedOrderBy && parsedOrder ? parsedOrderBy : null,
    order: parsedOrderBy && parsedOrder ? parsedOrder : null,
    columns,
    compact,
    linkPreview,
  }
}

export function buildMemoSearch(input: MemoSearchInput): string {
  const params = new URLSearchParams()
  const q = input.q?.trim()
  if (q) params.set('q', q)
  if (input.tag) params.set('tag', input.tag)
  if (input.filter?.trim()) params.set('filter', input.filter.trim())
  if (input.spaceId) params.set('space', input.spaceId)
  const orderBy = input.orderBy ?? DEFAULT_ORDER_BY
  const order = input.order ?? DEFAULT_ORDER
  if (orderBy !== DEFAULT_ORDER_BY || order !== DEFAULT_ORDER) params.set('sort', `${orderBy}-${order}`)
  if (input.display) {
    const tokens: string[] = []
    if (input.display.columns !== 'auto') tokens.push(String(input.display.columns))
    if (input.display.compact) tokens.push('compact')
    if (!input.display.linkPreview) tokens.push('no-link-preview')
    if (tokens.length > 0) params.set('display', tokens.join(','))
  }
  return params.toString()
}

export function memoHref(pathname: string, search: string): string {
  return search ? `${pathname}?${search}` : pathname
}

export function navigateMemoUrl(pathname: string, search: string, options: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return
  const next = memoHref(pathname, search)
  const current = `${window.location.pathname}${window.location.search}`
  if (next === current) return
  if (options.replace) window.history.replaceState(null, '', next)
  else window.history.pushState(null, '', next)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function memoFilterExpression(query: string, filter: string): string {
  const clauses: string[] = []
  const needle = query.trim()
  if (needle) clauses.push(`content.contains(${JSON.stringify(needle)})`)
  const expression = filter.trim()
  if (expression) clauses.push(`(${expression})`)
  return clauses.join(' && ')
}
