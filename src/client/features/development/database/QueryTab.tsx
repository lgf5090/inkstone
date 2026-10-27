import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bookmark,
  Eraser,
  FolderPen,
  History,
  Loader2,
  Play,
  Save,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import type { QueryHistoryEntry, QueryResult, SavedQuery, SchemaModel } from '@shared/development/database/types'
import { splitSqlStatements, isWriteSql } from '@shared/development/database/sql-utils'
import { isImeComposing } from '../../../lib/ime'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Input, Field } from '../../../components/form'
import { Modal, confirm } from '../../../components/overlay'
import { ToolbarPanel } from './ToolbarPanel'
import { SqlEditor } from './SqlEditor'
import { ResultGrid } from './ResultGrid'
import { RowDetailPanel } from './RowDetailPanel'
import { ExportPanel } from './ExportPanel'
import { AggregatePanel } from './AggregatePanel'
import { ExplainPlanView, isExplainPlanResult, toExplainPlanRows } from './ExplainPlanView'
import { AiSqlPanel } from './AiSqlPanel'
import { AgentPanel } from './AgentPanel'
import type { StudioDriver } from './drivers'
import { findPlaceholders, replacePlaceholders, type PlaceholderValues } from './placeholders'
import { formatSql } from './format-sql'
import {
  clearHistory,
  createSavedQuery,
  deleteSavedQuery,
  listHistory,
  listSavedQueries,
  updateSavedQuery,
  getSettings,
  updateSettings,
} from './api'

const LOCAL_HISTORY_PREFIX = 'inkstone.development.database.history.'
const LOCAL_SAVED_PREFIX = 'inkstone.development.database.saved.'
const MAX_LOCAL_HISTORY = 30

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch (error) {
    console.warn('[inkstone] Development database local history could not be read:', error)
    return fallback
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn('[inkstone] Development database local history could not be saved:', error)
  }
}

function historyToSql(entry: QueryHistoryEntry | string): string {
  return typeof entry === 'string' ? entry : entry.query
}

function resultTableName(sql: string): string | null {
  const match = sql.match(/\bfrom\s+("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*)/i)
  if (!match?.[1]) return null
  return match[1].replace(/^"|"$/g, '').replace(/^`|`$/g, '').replace(/^\[|\]$/g, '')
}

export interface QueryTabProps {
  driver: StudioDriver
  connectionId: string
  connectionType: 'd1' | 'turso' | 'sqlite'
  schemaModel: SchemaModel
  initialSql?: string
  onError: (message: string) => void
}

export function QueryTab({ driver, connectionId, connectionType, schemaModel, initialSql, onError }: QueryTabProps) {
  const isLocal = connectionType === 'sqlite'
  const [sql, setSql] = useState(initialSql ?? '')
  const [results, setResults] = useState<QueryResult[]>([])
  const [executedSql, setExecutedSql] = useState('')
  const [activeResult, setActiveResult] = useState(0)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const [cursor, setCursor] = useState({ line: 1, column: 0 })
  const [resultSearch, setResultSearch] = useState('')
  const [detailRow, setDetailRow] = useState<number | null>(null)
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [history, setHistory] = useState<string[]>([])
  const [saved, setSaved] = useState<SavedQuery[]>([])
  const [historySearch, setHistorySearch] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [savedOpen, setSavedOpen] = useState(false)
  const [historyLimited, setHistoryLimited] = useState(30)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveNamespace, setSaveNamespace] = useState('')
  const [editingSaved, setEditingSaved] = useState<SavedQuery | null>(null)
  const [renameNamespace, setRenameNamespace] = useState<{ old: string; value: string } | null>(null)
  const [placeholderValues, setPlaceholderValues] = useState<PlaceholderValues>({})
  const [sidePanel, setSidePanel] = useState<'ai' | 'agent' | null>(null)
  const historyAnchor = useRef<HTMLButtonElement>(null)
  const savedAnchor = useRef<HTMLButtonElement>(null)
  const settingsSaving = useRef(false)

  const namespace = useMemo(() => {
    const result: Record<string, string[]> = {}
    for (const table of schemaModel.tables) result[table.name] = table.columns.map((column) => column.name)
    return result
  }, [schemaModel])

  const placeholders = useMemo(() => findPlaceholders(sql), [sql])

  useEffect(() => {
    setPlaceholderValues((current) => {
      const next: PlaceholderValues = {}
      for (const name of placeholders) next[name] = current[name] ?? ''
      return next
    })
  }, [placeholders])

  useEffect(() => {
    if (!isLocal) {
      void listHistory(connectionId).then((entries) => setHistory(entries.map(historyToSql))).catch((cause) => onError(cause instanceof Error ? cause.message : String(cause)))
      void listSavedQueries(connectionId).then(setSaved).catch((cause) => onError(cause instanceof Error ? cause.message : String(cause)))
      void getSettings().then((settings) => setHistoryLimited(settings.historyLimit)).catch((error) => console.warn('[inkstone] Development database history settings could not be read:', error))
    } else {
      setHistory(readLocal<string[]>(`${LOCAL_HISTORY_PREFIX}${connectionId}`, []).slice(0, MAX_LOCAL_HISTORY))
      setSaved(readLocal<SavedQuery[]>(`${LOCAL_SAVED_PREFIX}${connectionId}`, []))
    }
  }, [connectionId, isLocal, onError])

  useEffect(() => {
    if (initialSql) setSql(initialSql)
  }, [initialSql])

  const pushHistory = useCallback((text: string) => {
    setHistory((current) => {
      const next = [text, ...current.filter((entry) => entry !== text)].slice(0, historyLimited)
      if (isLocal) writeLocal(`${LOCAL_HISTORY_PREFIX}${connectionId}`, next)
      return next
    })
  }, [connectionId, historyLimited, isLocal])

  const execute = useCallback(async (text?: string) => {
    const target = (text ?? sql).trim()
    if (!target) return
    const names = findPlaceholders(target)
    if (names.some((name) => String(placeholderValues[name] ?? '').trim() === '')) {
      onError(t('development.database.query.fill_placeholders'))
      return
    }
    const resolved = names.length ? replacePlaceholders(target, placeholderValues) : target
    const statements = splitSqlStatements(resolved)
    if (statements.length === 0) {
      setError(t('development.database.query.no_statements'))
      return
    }
    setRunning(true)
    setError(null)
    try {
      const next: QueryResult[] = []
      for (let index = 0; index < statements.length; index++) {
        setProgress({ current: index + 1, total: statements.length })
        next.push(await driver.query(statements[index]!))
      }
      setResults(next)
      setExecutedSql(target)
      setActiveResult(0)
      setDetailRow(null)
      setSelectedRows(new Set())
      pushHistory(target)
      if (!isLocal) {
        void listHistory(connectionId).then((entries) => setHistory(entries.map(historyToSql))).catch((error) => console.warn('[inkstone] Development database history settings could not be read:', error))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProgress(null)
      setRunning(false)
    }
  }, [connectionId, driver, isLocal, onError, placeholderValues, pushHistory, sql])

  const explain = useCallback(async () => {
    const target = sql.trim()
    if (!target) return
    const statements = splitSqlStatements(target)
    if (statements.length === 0) {
      setError(t('development.database.query.no_statements'))
      return
    }
    setRunning(true)
    setError(null)
    try {
      const result = await driver.query(`EXPLAIN QUERY PLAN ${statements[0]}`)
      setResults([result])
      setActiveResult(0)
      setDetailRow(null)
      setSelectedRows(new Set())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
    }
  }, [driver, sql])

  const format = useCallback(async () => {
    const result = await formatSql(sql)
    if (!result.ok) {
      onError(result.error)
      return
    }
    setSql(result.sql)
  }, [onError, sql])

  const active = results[activeResult]
  const filteredRows = useMemo(() => {
    if (!active) return []
    const query = resultSearch.trim().toLowerCase()
    if (!query) return active.rows
    return active.rows.filter((row) => active.columns.some((_, index) => {
      const value = row[index]
      return value !== null && value !== undefined && String(value).toLowerCase().includes(query)
    }))
  }, [active, resultSearch])

  const selectResult = (index: number) => {
    setActiveResult(index)
    setResultSearch('')
    setDetailRow(null)
    setSelectedRows(new Set())
  }

  const saveQuery = async () => {
    if (!saveName.trim() || !sql.trim()) return
    const queryNamespace = saveNamespace.trim() || 'default'
    try {
      if (isLocal) {
        const now = Date.now()
        const item: SavedQuery = editingSaved
          ? { ...editingSaved, name: saveName.trim(), sql, namespace: queryNamespace, updatedAt: now }
          : { id: `local-${now}`, connectionId, name: saveName.trim(), sql, namespace: queryNamespace, updatedAt: now }
        const next = editingSaved
          ? saved.map((entry) => entry.id === item.id ? item : entry)
          : [...saved, item]
        setSaved(next)
        writeLocal(`${LOCAL_SAVED_PREFIX}${connectionId}`, next)
      } else if (editingSaved) {
        const updated = await updateSavedQuery(editingSaved.id, { name: saveName.trim(), sql, namespace: queryNamespace })
        setSaved((current) => current.map((entry) => entry.id === updated.id ? updated : entry))
      } else {
        const created = await createSavedQuery({ connectionId, name: saveName.trim(), sql, namespace: queryNamespace })
        setSaved((current) => [created, ...current])
      }
      setSaveOpen(false)
      setEditingSaved(null)
      setSaveName('')
      setSaveNamespace('')
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const removeSaved = async (item: SavedQuery) => {
    try {
      if (!isLocal) await deleteSavedQuery(item.id)
      const next = saved.filter((entry) => entry.id !== item.id)
      setSaved(next)
      if (isLocal) writeLocal(`${LOCAL_SAVED_PREFIX}${connectionId}`, next)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const renameGroup = async (oldName: string, value: string) => {
    const nextName = value.trim() || 'default'
    if (nextName === oldName) return
    try {
      if (isLocal) {
        const next = saved.map((entry) => (entry.namespace || 'default') === oldName ? { ...entry, namespace: nextName } : entry)
        setSaved(next)
        writeLocal(`${LOCAL_SAVED_PREFIX}${connectionId}`, next)
      } else {
        for (const entry of saved.filter((item) => (item.namespace || 'default') === oldName)) {
          const updated = await updateSavedQuery(entry.id, { namespace: nextName })
          setSaved((current) => current.map((item) => item.id === updated.id ? updated : item))
        }
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRenameNamespace(null)
    }
  }

  const deleteGroup = async (name: string) => {
    const ok = await confirm({
      title: t('development.database.query.delete_group_title', { name }),
      description: t('development.database.query.delete_group_description'),
      confirmLabel: t('development.database.query.delete_group'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      if (isLocal) {
        const next = saved.filter((entry) => (entry.namespace || 'default') !== name)
        setSaved(next)
        writeLocal(`${LOCAL_SAVED_PREFIX}${connectionId}`, next)
      } else {
        for (const entry of saved.filter((item) => (item.namespace || 'default') === name)) await deleteSavedQuery(entry.id)
        setSaved((current) => current.filter((entry) => (entry.namespace || 'default') !== name))
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const saveHistoryLimit = async () => {
    if (settingsSaving.current) return
    if (historyLimited < 5 || historyLimited > 500) {
      onError(t('development.database.query.history_limit_range'))
      return
    }
    settingsSaving.current = true
    try {
      if (!isLocal) {
        await updateSettings(historyLimited)
        const entries = await listHistory(connectionId)
        setHistory(entries.map(historyToSql))
      } else {
        const next = history.slice(0, historyLimited)
        setHistory(next)
        writeLocal(`${LOCAL_HISTORY_PREFIX}${connectionId}`, next)
      }
      setSettingsOpen(false)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      settingsSaving.current = false
    }
  }

  const insertSql = (text: string) => {
    const cleaned = text.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    if (!cleaned) return
    setSql((current) => {
      const base = current.trim()
      if (!base) return `${cleaned};`
      return `${base}${base.endsWith(';') ? '' : ';'}\n\n${cleaned};`
    })
  }

  const filteredHistory = history.filter((entry) => entry.toLowerCase().includes(historySearch.trim().toLowerCase()))
  const groups = useMemo(() => {
    const map = new Map<string, SavedQuery[]>()
    for (const entry of saved) {
      const name = entry.namespace || 'default'
      map.set(name, [...(map.get(name) ?? []), entry])
    }
    return [...map.entries()]
  }, [saved])

  const detail = detailRow !== null ? filteredRows[detailRow] : null

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-40 shrink-0 flex-col border-b border-[var(--border-subtle)]">
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1">
            <Button size="sm" onClick={() => void execute()} disabled={running || !sql.trim()}>
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {t('development.database.query.run')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void explain()} disabled={running || !sql.trim()}>
              {t('development.database.query.explain')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setSidePanel((current) => current === 'ai' ? null : 'ai')}>
              <Sparkles size={14} />
              {t('development.database.query.ai')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setSidePanel((current) => current === 'agent' ? null : 'agent')}>
              {t('development.database.query.agent')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void format()} title={t('development.database.query.format_hint')}>
              <Wand2 size={14} />
              {t('development.database.query.format')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setResults([]); setError(null) }} disabled={results.length === 0}>
              <Eraser size={14} />
              {t('development.database.query.clear_results')}
            </Button>
            <Button ref={historyAnchor} variant="ghost" size="sm" onClick={() => setHistoryOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={historyOpen}>
              <History size={14} />
              {t('development.database.query.history')}
            </Button>
            <Button ref={savedAnchor} variant="ghost" size="sm" onClick={() => setSavedOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={savedOpen}>
              <Bookmark size={14} />
              {t('development.database.query.saved_queries')}
            </Button>
            <div className="flex-1" />
            {!isWriteSql(sql) && sql.trim() && (
              <span className="hidden text-[length:var(--text-10)] text-[var(--text-tertiary)] sm:inline">{t('development.database.query.read_only')}</span>
            )}
            <Button variant="secondary" size="sm" onClick={() => { setEditingSaved(null); setSaveName(''); setSaveNamespace(''); setSaveOpen(true) }}>
              <Save size={14} />
              {t('development.database.query.save')}
            </Button>
          </div>
          <div className="min-h-28 flex-1">
            <SqlEditor
              value={sql}
              onChange={setSql}
              schema={namespace}
              onExecute={(text) => void execute(text)}
              onFormat={() => void format()}
              onCursorChange={(line, column) => setCursor({ line, column })}
              className="h-full min-h-0"
            />
          </div>
          <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
            <span className="tabular-nums">{t('development.database.query.line')} {cursor.line}, {t('development.database.query.column')} {cursor.column + 1}</span>
            <div className="flex-1" />
            <span className="hidden sm:inline">{t('development.database.query.status_hints')}</span>
          </div>
          {placeholders.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
              <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.query.placeholders')}</span>
              {placeholders.map((name) => (
                <label key={name} className="flex items-center gap-1">
                  <span className="font-mono text-[length:var(--text-10)] text-[var(--accent)]">:{name}</span>
                  <Input
                    value={String(placeholderValues[name] ?? '')}
                    onChange={(event) => setPlaceholderValues((current) => ({ ...current, [name]: event.target.value }))}
                    onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') void execute() }}
                    placeholder={t('development.database.query.placeholder_value')}
                    className="h-7 w-36 text-[length:var(--text-11)]"
                  />
                </label>
              ))}
            </div>
          )}
          {progress && (
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1">
              <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
              <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                {t('development.database.query.executing', { current: progress.current, total: progress.total })}
              </span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--bg-inset)]">
                <div className="h-full rounded-full bg-[var(--accent)] transition-all" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
              </div>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {error && <div className="shrink-0 border-b border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-1.5 text-[length:var(--text-12)] text-[var(--danger)]">{error}</div>}
          {results.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {results.map((result, index) => (
                  <Button key={index} variant={index === activeResult ? 'primary' : 'ghost'} size="sm" onClick={() => selectResult(index)}>
                    {t('development.database.query.result', { n: index + 1 })}
                    <span className="ml-1 opacity-70">{result.columns.length} {t('development.database.query.cols')}</span>
                    {typeof result.rowsAffected === 'number' && result.rowsAffected > 0 && <span className="ml-1 opacity-70">{t('development.database.query.affected', { count: result.rowsAffected })}</span>}
                  </Button>
                ))}
              </div>
              {active && <ExportPanel columns={active.columns} rows={filteredRows} tableName={resultTableName(executedSql) ?? t('development.database.query.result_name', { n: activeResult + 1 })} selectedRows={selectedRows} />}
              {active && <AggregatePanel columns={active.columns} rows={filteredRows} selectedRows={selectedRows} />}
              {active && (
                <span className="shrink-0 pl-2 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                  {filteredRows.length.toLocaleString()} {t('development.database.query.rows')} · {active.durationMs}{t('development.database.query.ms')}
                  {typeof active.meta?.rows_read === 'number' && <> · {t('development.database.query.rows_read', { count: active.meta.rows_read as number })}</>}
                  {typeof active.meta?.rows_written === 'number' && (active.meta.rows_written as number) > 0 && <> · {t('development.database.query.rows_written', { count: active.meta.rows_written as number })}</>}
                </span>
              )}
            </div>
          )}
          {active && (
            <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
              <div className="relative min-w-0 flex-1">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                <Input
                  value={resultSearch}
                  onChange={(event) => setResultSearch(event.target.value)}
                  onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Escape') setResultSearch('') }}
                  placeholder={t('development.database.query.search_result', { n: activeResult + 1, cols: active.columns.length })}
                  className="h-8 pl-8 pr-8 text-[length:var(--text-11)]"
                />
                {resultSearch && (
                  <button type="button" onClick={() => setResultSearch('')} aria-label={t('development.database.common.clear')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-tertiary)]">
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0">
              {active ? (
                isExplainPlanResult(active.columns) ? (
                  <ExplainPlanView rows={toExplainPlanRows(active.rows)} className="h-full" />
                ) : (
                  <ResultGrid
                    columns={active.columns}
                    rows={filteredRows}
                    selectedRows={selectedRows}
                    onSelectionChange={setSelectedRows}
                    selectedRow={detailRow}
                    onRowClick={(index) => setDetailRow(index)}
                  />
                )
              ) : (
                <div className="flex h-full items-center justify-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                  {running ? t('development.database.query.executing_hint') : t('development.database.query.result_placeholder')}
                </div>
              )}
            </div>
            {detail !== null && detailRow !== null && (
              <div className="absolute inset-y-0 right-0 z-20 w-[85vw] max-w-sm">
                <RowDetailPanel
                  columns={active?.columns ?? []}
                  row={detail}
                  title={t('development.database.query.row_detail', { n: activeResult + 1, row: detailRow + 1 })}
                  onClose={() => setDetailRow(null)}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {sidePanel && (
        <aside className="relative z-20 flex w-[360px] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-base)] max-sm:absolute max-sm:inset-y-0 max-sm:right-0 max-sm:w-full">
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
              {sidePanel === 'ai' ? <Sparkles size={14} className="text-[var(--accent)]" /> : null}
              {sidePanel === 'ai' ? t('development.database.query.ai_assistant') : t('development.database.query.db_agent')}
            </span>
            <IconButton label={t('development.database.query.close_sidebar')} size="sm" onClick={() => setSidePanel(null)}>
              <X size={14} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1">
            {sidePanel === 'ai' ? (
              <AiSqlPanel
                tables={schemaModel.tables.map((table) => ({ name: table.name, columns: table.columns.map((column) => ({ name: column.name, type: column.type })) }))}
                currentSql={sql}
                onInsert={insertSql}
                onError={onError}
                className="h-full"
              />
            ) : (
              <AgentPanel className="h-full" />
            )}
          </div>
        </aside>
      )}

      <ToolbarPanel open={historyOpen} onClose={() => setHistoryOpen(false)} anchor={historyAnchor} label={t('development.database.query.history')} width={340}>
        <div className="mb-2 flex items-center gap-1.5">
          <Input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder={t('development.database.query.search_history')} className="h-8 text-[length:var(--text-11)]" />
          <IconButton label={t('development.database.query.history_settings')} size="sm" onClick={() => { setHistoryOpen(false); setSettingsOpen(true) }}>
            <Settings size={13} />
          </IconButton>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {filteredHistory.length === 0 ? (
            <div className="px-1 py-3 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.query.no_history')}</div>
          ) : filteredHistory.map((entry, index) => (
            <button key={`${entry}-${index}`} type="button" onClick={() => { setSql(entry); setHistoryOpen(false) }} className="block w-full truncate rounded px-1.5 py-1.5 text-left font-mono text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
              {entry}
            </button>
          ))}
        </div>
        {history.length > 0 && (
          <Button variant="ghost" size="sm" className="mt-2 w-full justify-start text-[var(--danger)]" onClick={() => { void (async () => {
            if (!isLocal) await clearHistory(connectionId)
            setHistory([])
            if (isLocal) writeLocal(`${LOCAL_HISTORY_PREFIX}${connectionId}`, [])
          })().catch((cause) => onError(cause instanceof Error ? cause.message : String(cause))) }}>
            <Trash2 size={13} />
            {t('development.database.query.clear_history')}
          </Button>
        )}
      </ToolbarPanel>

      <ToolbarPanel open={savedOpen} onClose={() => setSavedOpen(false)} anchor={savedAnchor} label={t('development.database.query.saved_queries')} width={360}>
        {groups.length === 0 ? (
          <div className="px-1 py-3 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.query.no_saved')}</div>
        ) : groups.map(([group, items]) => (
          <div key={group} className="mb-2">
            <div className="flex items-center gap-1 px-1 py-1">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]">{group} ({items.length})</span>
              <IconButton label={t('development.database.query.rename_group')} size="xs" onClick={() => setRenameNamespace({ old: group, value: group })}>
                <FolderPen size={12} />
              </IconButton>
              <IconButton label={t('development.database.query.delete_group')} size="xs" onClick={() => void deleteGroup(group)}>
                <Trash2 size={12} />
              </IconButton>
            </div>
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-1">
                <button type="button" onClick={() => { setSql(item.sql); setSavedOpen(false) }} className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                  {item.name}
                </button>
                <IconButton label={t('development.database.query.update_saved')} size="xs" onClick={() => { setEditingSaved(item); setSaveName(item.name); setSaveNamespace(item.namespace || 'default'); setSavedOpen(false); setSaveOpen(true) }}>
                  <Bookmark size={12} />
                </IconButton>
                <IconButton label={t('development.database.query.delete_saved')} size="xs" onClick={() => void removeSaved(item)}>
                  <Trash2 size={12} />
                </IconButton>
              </div>
            ))}
          </div>
        ))}
      </ToolbarPanel>

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title={editingSaved ? t('development.database.query.update_saved') : t('development.database.query.save_query')}
        width={420}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSaveOpen(false)}>{t('development.database.common.cancel')}</Button>
            <Button size="sm" onClick={() => void saveQuery()} disabled={!saveName.trim() || !sql.trim()}>{t('development.database.common.save')}</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('development.database.query.name')} required>
            <Input value={saveName} onChange={(event) => setSaveName(event.target.value)} placeholder={t('development.database.query.name_placeholder')} />
          </Field>
          <Field label={t('development.database.query.namespace')}>
            <Input value={saveNamespace} onChange={(event) => setSaveNamespace(event.target.value)} placeholder="default" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={renameNamespace !== null}
        onClose={() => setRenameNamespace(null)}
        title={t('development.database.query.rename_group_title', { name: renameNamespace?.old ?? '' })}
        width={360}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRenameNamespace(null)}>{t('development.database.common.cancel')}</Button>
            <Button size="sm" onClick={() => { if (renameNamespace) void renameGroup(renameNamespace.old, renameNamespace.value) }}>{t('development.database.query.rename')}</Button>
          </>
        }
      >
        <Input value={renameNamespace?.value ?? ''} onChange={(event) => setRenameNamespace((current) => current ? { ...current, value: event.target.value } : current)} />
      </Modal>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={t('development.database.query.history_settings')}
        width={360}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(false)}>{t('development.database.common.cancel')}</Button>
            <Button size="sm" onClick={() => void saveHistoryLimit()}>{t('development.database.common.save')}</Button>
          </>
        }
      >
        <Field label={t('development.database.query.history_limit')} hint={t('development.database.query.history_limit_hint')}>
          <Input type="number" min={5} max={500} value={String(historyLimited)} onChange={(event) => setHistoryLimited(Number(event.target.value))} />
        </Field>
      </Modal>
    </div>
  )
}
