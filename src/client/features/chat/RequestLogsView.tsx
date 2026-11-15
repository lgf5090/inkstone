import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronsUpDown, Columns3, Copy, Download,
  ExternalLink, FileText, MoreHorizontal, RefreshCw, Trash2, XCircle,
} from 'lucide-react'
import type {
  AssistantLogPage, AssistantLogSortDir, AssistantLogSortKey, AssistantRequestLog,
} from '@shared/assistant'
import { LOG_PAGE_SIZE } from '@shared/assistant'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Input, Select, Switch } from '../../components/form'
import { Menu, Modal, Tooltip, confirm, useContextMenu, type MenuItem } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import {
  REFRESH_INTERVALS, LogFilterBar, StarButton, count, exportLogs,
  ms, tokens, useAutoRefresh, useLogFacets, useLogFilters, when,
} from './request-log-shared'

type ColumnId = 'at' | 'status' | 'model' | 'provider' | 'key' | 'tokens' | 'latency' | 'error' | 'operation' | 'attempt' | 'conversation' | 'note'

interface ColumnDef {
  id: ColumnId
  label: MessageKey
  width: string
  sort?: AssistantLogSortKey
  end?: boolean
}

const COLUMNS: ColumnDef[] = [
  { id: 'at', label: 'assistant.logs.columns.time', width: '104px', sort: 'at' },
  { id: 'status', label: 'assistant.logs.columns.status', width: '92px', sort: 'status' },
  { id: 'model', label: 'assistant.logs.columns.model', width: 'minmax(128px,1.4fr)', sort: 'model' },
  { id: 'provider', label: 'assistant.logs.columns.provider', width: 'minmax(104px,1fr)', sort: 'provider' },
  { id: 'key', label: 'assistant.logs.columns.key', width: '88px', sort: 'key' },
  { id: 'tokens', label: 'assistant.logs.columns.tokens', width: '120px', sort: 'tokens' },
  { id: 'latency', label: 'assistant.logs.columns.latency', width: '80px', sort: 'latency', end: true },
  { id: 'error', label: 'assistant.logs.columns.error', width: 'minmax(128px,1.4fr)' },
  { id: 'operation', label: 'assistant.logs.columns.operation', width: '88px', sort: 'operation' },
  { id: 'attempt', label: 'assistant.logs.columns.attempt', width: '72px', sort: 'attempt', end: true },
  { id: 'conversation', label: 'assistant.logs.columns.conversation', width: '96px' },
  { id: 'note', label: 'assistant.logs.columns.note', width: 'minmax(120px,1fr)' },
]

const DEFAULT_COLUMNS: ColumnId[] = ['at', 'status', 'model', 'provider', 'key', 'tokens', 'latency', 'error']
const COLUMN_STORAGE_KEY = 'inkstone.logs.columns'

function readColumns(): ColumnId[] {
  try {
    const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) {
      const kept = parsed.filter((id): id is ColumnId => COLUMNS.some((column) => column.id === id))
      if (kept.length) return kept
    }
  } catch (error) {
    console.warn('log column preference unreadable', error)
  }
  return DEFAULT_COLUMNS
}

function saveColumns(columns: ColumnId[]): void {
  try {
    window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columns))
  } catch (error) {
    console.warn('log column preference not saved', error)
  }
}

export function RequestLogsView() {
  const toast = useUi((state) => state.toast)
  const controls = useLogFilters()
  const facets = useLogFacets()
  const [page, setPage] = useState(1)
  const [answer, setAnswer] = useState<AssistantLogPage | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [refreshSeconds, setRefreshSeconds] = useState(0)
  const [includeBody, setIncludeBody] = useState(false)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [columns, setColumns] = useState<ColumnId[]>(readColumns)
  const [sort, setSort] = useState<{ by?: AssistantLogSortKey, dir: AssistantLogSortDir }>({ dir: 'none' })
  const columnsRef = useRef<HTMLButtonElement>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  /** Only the newest read may paint: a filter change can leave two requests in flight at once. */
  const loadId = useRef(0)

  const load = useCallback(async () => {
    const id = ++loadId.current
    setBusy(true)
    setFailure(null)
    try {
      const answer = await api.assistant.requestLogs({
        ...controls.query,
        page,
        pageSize: LOG_PAGE_SIZE,
        ...(sort.by ? { sortBy: sort.by, sortDir: sort.dir } : {}),
      })
      if (id !== loadId.current) return
      setAnswer(answer)
    } catch (error) {
      if (id !== loadId.current) return
      setAnswer(null)
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      if (id === loadId.current) setBusy(false)
    }
  }, [controls.query, page, sort])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setPage(1); setSelected(new Set()) }, [controls.query, sort])
  useEffect(() => { saveColumns(columns) }, [columns])
  useAutoRefresh(refreshSeconds, () => void load())

  const logs = answer?.logs ?? []
  const pages = Math.max(1, Math.ceil((answer?.total ?? 0) / LOG_PAGE_SIZE))
  const allOnPage = logs.length > 0 && logs.every((entry) => selected.has(entry.id))
  const visible = COLUMNS.filter((column) => columns.includes(column.id))
  const template = useMemo(() => `24px ${visible.map((column) => column.width).join(' ')} 28px 28px 28px`, [visible])

  const cycleSort = (key: AssistantLogSortKey) => {
    if (sort.by !== key) setSort({ by: key, dir: 'desc' })
    else if (sort.dir === 'desc') setSort({ by: key, dir: 'asc' })
    else if (sort.dir === 'asc') setSort({ dir: 'none' })
    else setSort({ by: key, dir: 'desc' })
  }

  const replace = (entry: AssistantRequestLog) => {
    setAnswer((current) => current ? { ...current, logs: current.logs.map((row) => row.id === entry.id ? entry : row) } : current)
  }

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const remove = async (ids: string[]) => {
    if (!ids.length) return
    const agreed = await confirm({
      title: t('assistant.logs.delete_selected_title', { count: ids.length }),
      description: t('assistant.logs.delete_selected_body'),
      confirmLabel: t('assistant.logs.delete_selected'),
      tone: 'danger',
    })
    if (!agreed) return
    try {
      await api.assistant.deleteRequestLogs(ids)
      setSelected(new Set())
      setExpanded(null)
      toast({ title: t('assistant.logs.cleanup_done', { count: ids.length }), tone: 'default' })
      await load()
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  const download = async (format: 'json' | 'csv') => {
    try {
      await exportLogs(controls.query, format, includeBody)
    } catch (error) {
      toast({ title: t('assistant.logs.export_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  const columnItems: MenuItem[] = COLUMNS.map((column) => ({
    id: column.id,
    label: t(column.label),
    checked: columns.includes(column.id),
    onSelect: () => setColumns((current) => {
      const next = current.includes(column.id) ? current.filter((id) => id !== column.id) : [...current, column.id]
      if (!next.length) return current
      return COLUMNS.filter((entry) => next.includes(entry.id)).map((entry) => entry.id)
    }),
  }))
  columnItems.push({
    id: 'reset',
    label: t('assistant.logs.columns.reset'),
    separatorBefore: true,
    onSelect: () => setColumns(DEFAULT_COLUMNS),
  })

  return (
    <div className="no-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-3 px-4 py-4 md:px-6">
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('assistant.logs.title')}</h2>
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.logs.hint')}</p>
        </div>

        <LogFilterBar controls={controls} facets={facets}>
          <Select
            aria-label={t('assistant.logs.auto_refresh')}
            className="w-[120px] shrink-0 text-[length:var(--text-11)]"
            value={String(refreshSeconds)}
            onChange={(event) => setRefreshSeconds(Number(event.target.value))}
          >
            {REFRESH_INTERVALS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds === 0 ? t('assistant.logs.auto_refresh_off') : t('assistant.logs.auto_refresh_every', { seconds })}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="secondary" icon={<RefreshCw size={12} />} disabled={busy} onClick={() => void load()}>
            {t('assistant.logs.refresh')}
          </Button>
        </LogFilterBar>

        <div className="flex flex-wrap items-center gap-1.5 border-y border-[var(--border-subtle)] py-2">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('assistant.logs.total', { count: count(answer?.total ?? 0) })}
          </span>
          <label className="flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            <input
              type="checkbox"
              checked={allOnPage}
              aria-label={t('assistant.logs.select_all')}
              onChange={() => setSelected(allOnPage ? new Set() : new Set(logs.map((entry) => entry.id)))}
            />
            {t('assistant.logs.select_all')}
          </label>
          {selected.size > 0 && (
            <>
              <span className="text-[length:var(--text-10-5)] text-[var(--accent-on-soft)]">{t('assistant.logs.selected', { count: selected.size })}</span>
              <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void remove([...selected])}>
                {t('assistant.logs.delete_selected')}
              </Button>
            </>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <span ref={columnsRef} className="inline-flex">
              <Button
                size="sm"
                variant="ghost"
                icon={<Columns3 size={12} />}
                aria-expanded={columnsOpen}
                onClick={() => setColumnsOpen((open) => !open)}
              >
                {t('assistant.logs.columns.title')}
              </Button>
            </span>
            <span className="flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {t('assistant.logs.export_body')}
              <Switch checked={includeBody} label={t('assistant.logs.export_body')} onChange={setIncludeBody} />
            </span>
            <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={() => void download('json')}>
              {t('assistant.insights.export_json')}
            </Button>
            <Button size="sm" variant="ghost" icon={<Download size={12} />} onClick={() => void download('csv')}>
              {t('assistant.insights.export_csv')}
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setCleanupOpen(true)}>
              {t('assistant.logs.cleanup')}
            </Button>
          </span>
        </div>

        {failure && (
          <p role="alert" className="flex items-center gap-1.5 text-[length:var(--text-12)] text-[var(--danger)]">
            <AlertTriangle size={13} /> {t('assistant.logs.load_failed')} · {failure}
          </p>
        )}
        {answer === null && busy && <div className="flex justify-center py-8"><Spinner /></div>}
        {answer !== null && logs.length === 0 && (
          <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.logs.empty')}</p>
        )}
        {logs.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <div className="min-w-[720px]" role="table" aria-label={t('assistant.logs.title')}>
                <div
                  role="row"
                  className="grid items-center gap-2 border-b border-[var(--border-subtle)] px-2 pb-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"
                  style={{ gridTemplateColumns: template }}
                >
                  <span role="columnheader" />
                  {visible.map((column) => (
                    <button
                      key={column.id}
                      type="button"
                      role="columnheader"
                      disabled={!column.sort}
                      aria-sort={column.sort && sort.by === column.sort
                        ? (sort.dir === 'asc' ? 'ascending' : sort.dir === 'desc' ? 'descending' : 'none')
                        : undefined}
                      title={column.sort ? t('assistant.logs.click_to_sort') : undefined}
                      aria-label={column.sort
                        ? `${t(column.label)} · ${t(sort.by === column.sort
                          ? (sort.dir === 'desc' ? 'assistant.logs.sort_asc' : sort.dir === 'asc' ? 'assistant.logs.sort_none' : 'assistant.logs.sort_desc')
                          : 'assistant.logs.sort_desc')}`
                        : undefined}
                      onClick={() => column.sort && cycleSort(column.sort)}
                      className={cn(
                        'flex min-w-0 items-center gap-1 text-left',
                        column.end && 'justify-end',
                        column.sort && 'hover:text-[var(--text-secondary)]',
                      )}
                    >
                      <span className="truncate">{t(column.label)}</span>
                      {column.sort && (sort.by === column.sort && sort.dir !== 'none'
                        ? (sort.dir === 'asc' ? <ArrowUp size={9} /> : <ArrowDown size={9} />)
                        : <ChevronsUpDown size={9} className="opacity-50" />)}
                    </button>
                  ))}
                  <span role="columnheader" className="text-center">{t('assistant.logs.columns.star')}</span>
                  <span role="columnheader" />
                  <span role="columnheader" />
                </div>
                <ul role="rowgroup" className="flex flex-col">
                  {logs.map((entry) => (
                    <LogRow
                      key={entry.id}
                      entry={entry}
                      columns={visible}
                      template={template}
                      selected={selected.has(entry.id)}
                      expanded={expanded === entry.id}
                      facets={facets}
                      onToggle={() => toggle(entry.id)}
                      onExpand={() => setExpanded((current) => current === entry.id ? null : entry.id)}
                      onChange={replace}
                      onDeleted={load}
                      onFilter={(key, value) => controls.setFilter(key, value)}
                    />
                  ))}
                </ul>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 py-2">
              <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                {t('assistant.logs.page', { page: answer?.page ?? 1, pages })}
              </span>
              <span className="flex items-center gap-1">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                  {t('assistant.logs.prev')}
                </Button>
                <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
                  {t('assistant.logs.next')}
                </Button>
              </span>
            </div>
          </>
        )}
      </div>
      <Menu open={columnsOpen} anchor={columnsRef} items={columnItems} onClose={() => setColumnsOpen(false)} width={220} label={t('assistant.logs.columns.title')} />
      {cleanupOpen && (
        <CleanupDialog
          query={controls.query}
          onClose={() => setCleanupOpen(false)}
          onDone={(deleted) => { setCleanupOpen(false); toast({ title: t('assistant.logs.cleanup_done', { count: deleted }), tone: 'default' }); void load() }}
        />
      )}
    </div>
  )
}

function StatusBadge({ entry }: { entry: AssistantRequestLog }) {
  const label = entry.ok
    ? t('assistant.logs.status_ok')
    : entry.httpStatus !== null ? String(entry.httpStatus) : t('assistant.logs.status_failed')
  const badge = (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[length:var(--text-10-5)] font-medium',
      entry.ok
        ? 'bg-[color-mix(in_oklab,var(--success)_14%,transparent)] text-[var(--success)]'
        : 'bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] text-[var(--danger)]',
    )}
    >
      {entry.ok ? <CheckCircle2 size={10} aria-hidden /> : <XCircle size={10} aria-hidden />}
      {label}
    </span>
  )
  const reason = entry.ok ? null : [entry.errorKind, entry.errorMessage].filter(Boolean).join(' · ')
  return reason ? <Tooltip label={reason} side="top"><span>{badge}</span></Tooltip> : badge
}

function LogCell({ entry, column, facets }: {
  entry: AssistantRequestLog
  column: ColumnDef
  facets: ReturnType<typeof useLogFacets>
}) {
  switch (column.id) {
    case 'at':
      return <span title={when(entry.at)} className="truncate font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{when(entry.at).slice(5)}</span>
    case 'status':
      return <StatusBadge entry={entry} />
    case 'model':
      return <span className="truncate text-[var(--text-secondary)]">{entry.modelLabel || entry.modelId || t('assistant.logs.none')}</span>
    case 'provider':
      return (
        <span className="truncate text-[var(--text-tertiary)]">
          {facets.providers.find((row) => row.id === entry.providerId)?.label || entry.providerLabel || entry.providerId}
        </span>
      )
    case 'key':
      return <span className="truncate font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">····{entry.keyHint}</span>
    case 'tokens':
      return (
        <Tooltip label={t('assistant.logs.cached_line', { count: count(entry.cachedInputTokens) })} side="top">
          <span className="truncate tabular text-[var(--text-tertiary)]">{tokens(entry.inputTokens)} / {tokens(entry.outputTokens)}</span>
        </Tooltip>
      )
    case 'latency':
      return (
        <span className={cn('tabular',
          entry.latencyMs === null ? 'text-[var(--text-quaternary)]'
            : entry.latencyMs > 3000 ? 'text-[var(--danger)]'
              : entry.latencyMs > 1200 ? 'text-[var(--warning)]' : 'text-[var(--text-tertiary)]')}
        >
          {ms(entry.latencyMs)}
        </span>
      )
    case 'error':
      return entry.ok
        ? <span className="truncate text-[var(--text-quaternary)]">—</span>
        : (
          <span className="flex min-w-0 items-center gap-1">
            {entry.errorKind && (
              <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] px-1.5 text-[length:var(--text-10-5)] text-[var(--danger)]">
                {entry.errorKind}
              </span>
            )}
            <span className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]" title={entry.errorMessage ?? undefined}>
              {entry.errorMessage ?? ''}
            </span>
          </span>
        )
    case 'operation':
      return <span className="truncate text-[var(--text-quaternary)]">{entry.operation}</span>
    case 'attempt':
      return <span className="tabular text-[var(--text-quaternary)]">#{entry.attempt}</span>
    case 'conversation':
      return <span className="truncate font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{entry.conversationId ? entry.conversationId.slice(-6) : '—'}</span>
    case 'note':
      return <span className="truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{entry.note || '—'}</span>
  }
}

function LogRow({ entry, columns, template, selected, expanded, facets, onToggle, onExpand, onChange, onDeleted, onFilter }: {
  entry: AssistantRequestLog
  columns: ColumnDef[]
  template: string
  selected: boolean
  expanded: boolean
  facets: ReturnType<typeof useLogFacets>
  onToggle: () => void
  onExpand: () => void
  onChange: (entry: AssistantRequestLog) => void
  onDeleted: () => Promise<void>
  onFilter: (key: 'providerId' | 'keyId' | 'model', value: string) => void
}) {
  const toast = useUi((state) => state.toast)
  const setView = useAssistant((state) => state.setView)
  const openConversation = useAssistant((state) => state.openConversation)
  const contextMenu = useContextMenu()
  const [note, setNote] = useState(entry.note)
  const [saving, setSaving] = useState(false)

  const copy = async (text: string) => {
    if (await copyText(text)) toast({ title: t('assistant.keys.copied'), tone: 'default' })
    else toast({ title: t('assistant.logs.copy_failed'), tone: 'danger' })
  }

  const saveNote = async () => {
    setSaving(true)
    try {
      const answer = await api.assistant.patchRequestLog(entry.id, { note })
      onChange(answer.entry)
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  const removeOne = async () => {
    const agreed = await confirm({
      title: t('assistant.logs.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    try {
      await api.assistant.deleteRequestLog(entry.id)
      await onDeleted()
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  const star = async () => {
    try {
      const answer = await api.assistant.patchRequestLog(entry.id, { starred: !entry.starred })
      onChange(answer.entry)
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  const items: MenuItem[] = [
    { id: 'expand', label: t('assistant.logs.details'), icon: <FileText size={13} />, onSelect: onExpand },
    { id: 'copy-id', label: t('assistant.logs.copy_id'), icon: <Copy size={13} />, onSelect: () => void copy(entry.id) },
    {
      id: 'copy-error',
      label: t('assistant.logs.copy_error'),
      icon: <AlertTriangle size={13} />,
      disabled: !entry.errorMessage,
      onSelect: () => void copy(entry.errorMessage ?? ''),
    },
    { id: 'star', label: entry.starred ? t('assistant.logs.unstar') : t('assistant.logs.star'), separatorBefore: true, onSelect: () => void star() },
    {
      id: 'open-conversation',
      label: t('assistant.logs.open_conversation'),
      icon: <ExternalLink size={13} />,
      disabled: !entry.conversationId,
      onSelect: () => { void openConversation(entry.conversationId); setView('chat') },
    },
    {
      id: 'filter-provider',
      label: t('assistant.logs.filter_by_provider'),
      disabled: !entry.providerId,
      separatorBefore: true,
      onSelect: () => onFilter('providerId', entry.providerId),
    },
    {
      id: 'filter-model',
      label: t('assistant.logs.filter_by_model'),
      disabled: !(entry.modelLabel || entry.modelId),
      onSelect: () => onFilter('model', entry.modelLabel || entry.modelId),
    },
    {
      id: 'filter-key',
      label: t('assistant.logs.filter_by_key'),
      disabled: !entry.keyId,
      onSelect: () => onFilter('keyId', entry.keyId),
    },
    {
      id: 'delete',
      label: t('assistant.logs.delete'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => void removeOne(),
    },
  ]

  return (
    <li
      role="row"
      className={cn(
        'rounded-[var(--r-md)] border border-transparent border-l-[3px] transition-colors hover:bg-[var(--bg-hover)]',
        entry.ok ? 'border-l-transparent' : 'border-l-[var(--danger)]',
      )}
      onContextMenu={contextMenu.onContextMenu}
    >
      <div className="grid items-center gap-2 px-2 py-1.5 text-[length:var(--text-11)]" style={{ gridTemplateColumns: template }}>
        <div role="cell">
          <input type="checkbox" checked={selected} aria-label={t('assistant.logs.select_one')} onChange={onToggle} />
        </div>
        {columns.map((column) => (
          <div key={column.id} role="cell" className={cn('flex min-w-0 items-center', column.end && 'justify-end')}>
            <button
              type="button"
              onClick={onExpand}
              aria-expanded={expanded}
              title={t('assistant.logs.detail_hint')}
              className="flex min-w-0 flex-1 items-center"
            >
              <LogCell entry={entry} column={column} facets={facets} />
            </button>
          </div>
        ))}
        <div role="cell" className="flex justify-center"><StarButton entry={entry} onChange={onChange} /></div>
        <div role="cell">
          <IconButton size="xs" label={t('assistant.logs.delete')} onClick={() => void removeOne()}>
            <Trash2 size={12} />
          </IconButton>
        </div>
        {/* The same menu a right click opens, reachable from the keyboard through a real button. */}
        <div role="cell">
          <IconButton
            size="xs"
            label={t('assistant.logs.row_menu')}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              contextMenu.openAt({ x: rect.left, y: rect.bottom })
            }}
          >
            <MoreHorizontal size={12} />
          </IconButton>
        </div>
      </div>
      {expanded && (
        <div className="flex flex-col gap-2 border-t border-[var(--border-subtle)] px-2.5 py-2 text-[length:var(--text-11)]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-[var(--text-quaternary)]">{t('assistant.logs.columns.status')}</dt>
            <dd className={entry.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
              {entry.ok ? t('assistant.logs.status_ok') : t('assistant.logs.status_failed')}
              {entry.httpStatus !== null ? ` · ${t('assistant.logs.http_status', { status: entry.httpStatus })}` : ''}
            </dd>
            <dt className="text-[var(--text-quaternary)]">{t('assistant.logs.field_time')}</dt>
            <dd className="text-[var(--text-secondary)]">{when(entry.at)}</dd>
            <dt className="text-[var(--text-quaternary)]">{t('assistant.logs.columns.provider')}</dt>
            <dd className="truncate text-[var(--text-secondary)]">{entry.providerLabel || entry.providerId}</dd>
            <dt className="text-[var(--text-quaternary)]">{t('assistant.logs.columns.model')}</dt>
            <dd className="truncate text-[var(--text-secondary)]">{entry.modelLabel || t('assistant.logs.none')} · {entry.modelId || t('assistant.logs.none')}</dd>
            <dt className="text-[var(--text-quaternary)]">{t('assistant.logs.columns.key')}</dt>
            <dd className="truncate text-[var(--text-secondary)]">{entry.keyLabel || `····${entry.keyHint}`}</dd>
            <dt className="text-[var(--text-quaternary)]">{t('assistant.logs.columns.operation')}</dt>
            <dd className="text-[var(--text-secondary)]">{entry.operation}</dd>
            <dt className="text-[var(--text-quaternary)]">{t('assistant.logs.columns.attempt')}</dt>
            <dd className="text-[var(--text-secondary)]">#{entry.attempt}</dd>
            <dt className="text-[var(--text-quaternary)]">{t('assistant.logs.columns.tokens')}</dt>
            <dd className="tabular text-[var(--text-secondary)]">
              {count(entry.inputTokens)} / {count(entry.outputTokens)} / {count(entry.cachedInputTokens)}
            </dd>
            <dt className="text-[var(--text-quaternary)]">{t('assistant.logs.columns.conversation')}</dt>
            <dd className="flex items-center gap-1">
              <span className="truncate font-mono text-[var(--text-secondary)]">{entry.conversationId || t('assistant.logs.none')}</span>
              {entry.conversationId && (
                <IconButton
                  size="xs"
                  label={t('assistant.logs.open_conversation')}
                  onClick={() => { void openConversation(entry.conversationId); setView('chat') }}
                >
                  <ExternalLink size={11} />
                </IconButton>
              )}
            </dd>
            {entry.errorMessage && (<>
              <dt className="text-[var(--text-quaternary)]">{t('assistant.logs.columns.error')}</dt>
              <dd className="break-words text-[var(--danger)]">{entry.errorMessage}</dd>
            </>)}
          </dl>
          {entry.requestBody && (
            <details>
              <summary className="flex cursor-pointer items-center gap-1 text-[var(--text-quaternary)]">
                <FileText size={11} /> {t('assistant.logs.request_body')}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-10-5)] whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                {entry.requestBody}
              </pre>
            </details>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              aria-label={t('assistant.logs.note')}
              placeholder={t('assistant.logs.note_hint')}
              value={note}
              maxLength={500}
              className="min-w-[160px] flex-1"
              onChange={(event) => setNote(event.target.value)}
            />
            <Button size="sm" variant="secondary" disabled={saving || note === entry.note} onClick={() => void saveNote()}>
              {t('assistant.logs.save_note')}
            </Button>
          </div>
        </div>
      )}
      {contextMenu.point && (
        <Menu open anchor={contextMenu.point} items={items} onClose={contextMenu.close} label={t('assistant.logs.row_menu')} />
      )}
    </li>
  )
}

function CleanupDialog({ query, onClose, onDone }: {
  query: Parameters<typeof api.assistant.cleanupRequestLogs>[0]
  onClose: () => void
  onDone: (deleted: number) => void
}) {
  const toast = useUi((state) => state.toast)
  const [days, setDays] = useState(7)
  const [rows, setRows] = useState(0)
  const [matched, setMatched] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const preview = async () => {
    setBusy(true)
    try {
      const answer = await api.assistant.cleanupRequestLogs(query, { days, rows, dryRun: true })
      setMatched(answer.matched)
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    setBusy(true)
    try {
      const answer = await api.assistant.cleanupRequestLogs(query, { days, rows, dryRun: false })
      onDone(answer.deleted)
    } catch (error) {
      toast({ title: t('assistant.logs.cleanup_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} width={480} title={t('assistant.logs.cleanup_title')} description={t('assistant.logs.cleanup_hint')}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('assistant.logs.cleanup_days')}
          <Input type="number" min={0} max={365} value={days} onChange={(event) => { setDays(Number(event.target.value)); setMatched(null) }} />
        </label>
        <label className="flex flex-col gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('assistant.logs.cleanup_rows')}
          <Input type="number" min={0} max={20_000} value={rows} onChange={(event) => { setRows(Number(event.target.value)); setMatched(null) }} />
        </label>
        <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('assistant.logs.cleanup_scope_hint')}</p>
        {matched !== null && (
          <p role="status" className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('assistant.logs.cleanup_preview', { count: count(matched) })}
          </p>
        )}
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="secondary" disabled={busy || (days <= 0 && rows <= 0)} onClick={() => void preview()}>
            {t('assistant.logs.cleanup_preview_button')}
          </Button>
          <Button size="sm" variant="danger" disabled={busy || matched === null || matched === 0} onClick={() => void apply()}>
            {t('assistant.logs.cleanup_apply', { count: count(matched ?? 0) })}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
