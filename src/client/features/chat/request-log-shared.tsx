import { useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw, Search, Star } from 'lucide-react'
import type { AssistantLogFacets, AssistantRequestLog } from '@shared/assistant'
import { LOG_MAX_PAGE_SIZE } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { api, type LogQuery } from '../../lib/api'
import { Button, IconButton } from '../../components/primitives'
import { Input, Select } from '../../components/form'
import { cn } from '../../lib/cn'
import { useUi } from '../../store/ui'

export const LOG_WINDOWS = [
  { ms: 3_600_000, key: 'assistant.logs.window_1h' },
  { ms: 86_400_000, key: 'assistant.logs.window_24h' },
  { ms: 604_800_000, key: 'assistant.logs.window_7d' },
  { ms: 2_592_000_000, key: 'assistant.logs.window_30d' },
  { ms: 0, key: 'assistant.logs.window_all' },
] as const

export const REFRESH_INTERVALS = [0, 5, 10, 30, 60] as const

export interface LogFilters {
  q: string
  providerId: string
  keyId: string
  model: string
  operation: string
  status: 'all' | 'ok' | 'failed'
  errorKind: string
  starred: boolean
  sinceMs: number
  minLatencyMs: number
  minInputTokens: number
}

export const DEFAULT_LOG_FILTERS: LogFilters = {
  q: '', providerId: '', keyId: '', model: '', operation: '', status: 'all',
  errorKind: '', starred: false, sinceMs: 0, minLatencyMs: 0, minInputTokens: 0,
}

export function useLogFilters() {
  const [filters, setFilters] = useState<LogFilters>(DEFAULT_LOG_FILTERS)
  const setFilter = <K extends keyof LogFilters>(key: K, value: LogFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }))
  }
  const query = useMemo((): LogQuery => ({
    ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
    ...(filters.providerId ? { providerId: filters.providerId } : {}),
    ...(filters.keyId ? { keyId: filters.keyId } : {}),
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.operation ? { operation: filters.operation } : {}),
    ...(filters.status !== 'all' ? { status: filters.status } : {}),
    ...(filters.errorKind ? { errorKind: filters.errorKind } : {}),
    ...(filters.starred ? { starred: true } : {}),
    ...(filters.sinceMs ? { sinceMs: filters.sinceMs } : {}),
    ...(filters.minLatencyMs ? { minLatencyMs: filters.minLatencyMs } : {}),
    ...(filters.minInputTokens ? { minInputTokens: filters.minInputTokens } : {}),
  }), [filters])
  const active = useMemo(() => Object.keys(query).length, [query])
  return { filters, setFilter, query, active, reset: () => setFilters(DEFAULT_LOG_FILTERS) }
}

export type LogFilterControls = ReturnType<typeof useLogFilters>

export function useLogFacets(): AssistantLogFacets {
  const [facets, setFacets] = useState<AssistantLogFacets>({ providers: [], keys: [], models: [], operations: [], errorKinds: [] })
  useEffect(() => {
    let cancelled = false
    // The menus are an aid, not the data: a refused facet read leaves the filters usable with empty lists.
    void api.assistant.logFacets()
      .then((answer) => { if (!cancelled) setFacets(answer) })
      .catch((error: unknown) => console.warn('log facets unavailable', error))
    return () => { cancelled = true }
  }, [])
  return facets
}

const FILTER_LABEL = 'w-full min-w-0 md:w-auto text-[length:var(--text-11)]'

export function LogFilterBar({ controls, facets, children, showStarred = true }: {
  controls: LogFilterControls
  facets: AssistantLogFacets
  children?: React.ReactNode
  showStarred?: boolean
}) {
  const { filters, setFilter, reset, active } = controls
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-[180px] flex-1">
          <Input
            type="search"
            aria-label={t('assistant.logs.search')}
            placeholder={t('assistant.logs.search_hint')}
            value={filters.q}
            leading={<Search size={12} />}
            onChange={(event) => setFilter('q', event.target.value)}
          />
        </div>
        {children}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.logs.window')}</span>
        <div className="flex flex-wrap items-center gap-0.5" role="group" aria-label={t('assistant.logs.window')}>
          {LOG_WINDOWS.map((window) => (
            <button
              key={window.key}
              type="button"
              aria-pressed={filters.sinceMs === window.ms}
              onClick={() => setFilter('sinceMs', window.ms)}
              className={cn(
                'rounded-[var(--r-md)] px-2 py-1 text-[length:var(--text-10-5)] transition-colors duration-[var(--dur-fast)]',
                filters.sinceMs === window.ms
                  ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
              )}
            >
              {t(window.key)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select aria-label={t('assistant.logs.filter_provider')} className={FILTER_LABEL} value={filters.providerId} onChange={(event) => setFilter('providerId', event.target.value)}>
          <option value="">{t('assistant.logs.filter_provider')}: {t('assistant.logs.all')}</option>
          {facets.providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.label || entry.id}</option>)}
        </Select>
        <Select aria-label={t('assistant.logs.filter_key')} className={FILTER_LABEL} value={filters.keyId} onChange={(event) => setFilter('keyId', event.target.value)}>
          <option value="">{t('assistant.logs.filter_key')}: {t('assistant.logs.all')}</option>
          {facets.keys.filter((entry) => !filters.providerId || entry.providerId === filters.providerId).map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.label || `····${entry.keyHint}`}</option>
          ))}
        </Select>
        <Select aria-label={t('assistant.logs.filter_model')} className={FILTER_LABEL} value={filters.model} onChange={(event) => setFilter('model', event.target.value)}>
          <option value="">{t('assistant.logs.filter_model')}: {t('assistant.logs.all')}</option>
          {facets.models.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </Select>
        <Select aria-label={t('assistant.logs.filter_status')} className={FILTER_LABEL} value={filters.status} onChange={(event) => setFilter('status', event.target.value as LogFilters['status'])}>
          <option value="all">{t('assistant.logs.filter_status')}: {t('assistant.logs.all')}</option>
          <option value="ok">{t('assistant.logs.status_ok')}</option>
          <option value="failed">{t('assistant.logs.status_failed')}</option>
        </Select>
        <Select aria-label={t('assistant.logs.filter_operation')} className={FILTER_LABEL} value={filters.operation} onChange={(event) => setFilter('operation', event.target.value)}>
          <option value="">{t('assistant.logs.filter_operation')}: {t('assistant.logs.all')}</option>
          {facets.operations.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </Select>
        {facets.errorKinds.length > 0 && (
          <Select aria-label={t('assistant.logs.filter_error_kind')} className={FILTER_LABEL} value={filters.errorKind} onChange={(event) => setFilter('errorKind', event.target.value)}>
            <option value="">{t('assistant.logs.filter_error_kind')}: {t('assistant.logs.all')}</option>
            {facets.errorKinds.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </Select>
        )}
        {showStarred && (
          <button
            type="button"
            aria-pressed={filters.starred}
            onClick={() => setFilter('starred', !filters.starred)}
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded-[var(--r-md)] border px-2 text-[length:var(--text-11)] transition-colors',
              filters.starred
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                : 'border-[var(--border-subtle)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
            )}
          >
            <Star size={12} fill={filters.starred ? 'currentColor' : 'none'} aria-hidden />
            {t('assistant.logs.starred_only')}
          </button>
        )}
        <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} disabled={active === 0} onClick={reset}>
          {t('assistant.logs.reset_filters')}
        </Button>
      </div>
    </div>
  )
}

const TONE_CLASS: Record<'ok' | 'bad' | 'warn' | 'plain', string> = {
  ok: 'text-[var(--success)]',
  bad: 'text-[var(--danger)]',
  warn: 'text-[var(--warning)]',
  plain: 'text-[var(--text-primary)]',
}

export function Stat({ label, value, tone = 'plain', icon }: {
  label: string
  value: string
  tone?: 'ok' | 'bad' | 'warn' | 'plain'
  icon?: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2">
      {icon && <span className={cn('mt-0.5 shrink-0 opacity-80', TONE_CLASS[tone])} aria-hidden>{icon}</span>}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{label}</span>
        <span className={cn('truncate tabular text-[length:var(--text-16)] font-semibold', TONE_CLASS[tone])}>{value}</span>
      </div>
    </div>
  )
}

/** A colour the theme owns, read at draw time so a light/dark switch is one repaint. */
export function themeColor(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export function count(value: number): string { return value.toLocaleString() }

export function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function when(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function dayLabel(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function bucketLabel(at: number, hourly: boolean): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return hourly ? `${pad(date.getHours())}:00` : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function ms(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}ms`
}

const CSV_HEADER = 'at,provider,provider_id,key_id,key_hint,model,model_id,operation,ok,http_status,error_kind,error_message,input_tokens,output_tokens,cached_input_tokens,latency_ms,attempt,conversation_id,starred,note'

function csvCell(value: string | number | boolean | null): string {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function toCsv(logs: AssistantRequestLog[], includeBody: boolean): string {
  const header = includeBody ? `${CSV_HEADER},request_body` : CSV_HEADER
  const rows = logs.map((entry) => {
    const cells: Array<string | number | boolean | null> = [
      new Date(entry.at).toISOString(), entry.providerLabel, entry.providerId, entry.keyId, entry.keyHint,
      entry.modelLabel, entry.modelId, entry.operation, entry.ok, entry.httpStatus, entry.errorKind,
      entry.errorMessage, entry.inputTokens, entry.outputTokens, entry.cachedInputTokens, entry.latencyMs,
      entry.attempt, entry.conversationId, entry.starred, entry.note,
    ]
    if (includeBody) cells.push(entry.requestBody)
    return cells.map(csvCell).join(',')
  })
  return '\uFEFF' + [header, ...rows].join('\r\n') + '\r\n'
}

export async function exportLogs(query: LogQuery, format: 'json' | 'csv', includeBody: boolean): Promise<void> {
  const answer = await api.assistant.requestLogs({ ...query, page: 1, pageSize: LOG_MAX_PAGE_SIZE })
  const logs = includeBody ? answer.logs : answer.logs.map((entry) => ({ ...entry, requestBody: null }))
  const text = format === 'json' ? JSON.stringify(logs, null, 2) : toCsv(logs, includeBody)
  const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `request-logs.${format}`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function useAutoRefresh(intervalSeconds: number, reload: () => void): void {
  // The reader's reload callback changes on every render; the timer must not, or each keystroke in the
  // search box would restart the countdown and a short interval would never arrive.
  const latest = useRef(reload)
  useEffect(() => { latest.current = reload }, [reload])
  useEffect(() => {
    if (intervalSeconds <= 0) return
    const timer = window.setInterval(() => latest.current(), intervalSeconds * 1_000)
    return () => window.clearInterval(timer)
  }, [intervalSeconds])
}

export function StarButton({ entry, onChange }: { entry: AssistantRequestLog, onChange: (entry: AssistantRequestLog) => void }) {
  const toast = useUi((state) => state.toast)
  const toggle = async () => {
    try {
      const answer = await api.assistant.patchRequestLog(entry.id, { starred: !entry.starred })
      onChange(answer.entry)
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }
  return (
    <IconButton
      size="xs"
      label={entry.starred ? t('assistant.logs.unstar') : t('assistant.logs.star')}
      active={entry.starred}
      onClick={() => void toggle()}
    >
      <Star size={12} fill={entry.starred ? 'currentColor' : 'none'} className={entry.starred ? 'text-[var(--warning)]' : undefined} />
    </IconButton>
  )
}
