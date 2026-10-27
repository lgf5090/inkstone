/**
 * D1: databases on the left, tables below them, and the query workbench on the right.
 *
 * The editor can draft before a database is chosen, but every command is disabled until one is. The
 * allow-write switch is only a convenience for the reader: the route checks the SQL again and refuses
 * writes without it, so the switch cannot be bypassed by editing the page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Database, History, Loader2, Plus, Settings, Trash2 } from 'lucide-react'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { quoteIdent } from '@shared/cloudflare/sql-utils'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { Checkbox } from '../../../../components/form'
import { Empty } from '../../../../components/feedback'
import { confirm } from '../../../../components/overlay'
import { t as uiT } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { storageApi, type D1Database, type D1QueryResult, type D1Table } from '../../api/storage'
import { SqlEditor, type SqlEditorHandle } from '../../components/SqlEditor'
import { SortableHead, Table, TableScroll, TBody, Td, THead, Tr } from '../../components/Table'
import { useCfT } from '../../i18n'
import { useSort } from '../../lib/sort'
import {
  clampHistoryLimit,
  pushHistory,
  readHistory,
  readHistoryLimit,
  writeHistory,
  writeHistoryLimit,
  type D1HistoryEntry,
} from './d1-history'
import { CreateNameDialog } from './CreateNameDialog'
import { CreateTableDialog } from './CreateTableDialog'
import { D1SchemaDialog } from './D1SchemaDialog'
import { SqlHistoryDialog } from './SqlHistoryDialog'
import { StorageError } from './StorageError'

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function D1Panel({ account }: { account: CloudflareAccount }) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const readOnly = account.is_demo
  const editorRef = useRef<SqlEditorHandle>(null)

  const [databases, setDatabases] = useState<D1Database[]>([])
  const [dbLoading, setDbLoading] = useState(true)
  const [dbError, setDbError] = useState<string | null>(null)
  const [selectedDb, setSelectedDb] = useState<D1Database | null>(null)

  const [tables, setTables] = useState<D1Table[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [tablesError, setTablesError] = useState<string | null>(null)

  const [sql, setSql] = useState('')
  const [allowWrite, setAllowWrite] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<D1QueryResult | null>(null)
  const [queryError, setQueryError] = useState<string | null>(null)

  const [history, setHistory] = useState<D1HistoryEntry[]>([])
  const [historyLimit, setHistoryLimit] = useState(50)
  const [historyOpen, setHistoryOpen] = useState(false)

  const [createDbOpen, setCreateDbOpen] = useState(false)
  const [createTableOpen, setCreateTableOpen] = useState(false)
  const [schemaTable, setSchemaTable] = useState<string | null>(null)

  const resultSort = useSort<Record<string, unknown>>()

  const resultColumns = useMemo(() => {
    const first = result?.results[0]
    return first ? Object.keys(first) : []
  }, [result])

  const sortedRows = useMemo(
    () => resultSort.sorted(result?.results ?? []),
    [resultSort, result],
  )

  const editorSchema = useMemo(
    () => tables.map((table) => ({ name: table.name, columns: [] as string[] })),
    [tables],
  )

  useEffect(() => {
    const limit = readHistoryLimit()
    setHistoryLimit(limit)
    setHistory(readHistory().slice(0, limit))
  }, [])

  const loadDatabases = useCallback(async () => {
    setDbLoading(true)
    setDbError(null)
    try {
      const data = await storageApi.listD1Databases(account.id)
      setDatabases(data.databases)
      setSelectedDb((current) => (
        current && data.databases.some((database) => database.id === current.id)
          ? current
          : data.databases[0] ?? null
      ))
    } catch (reason) {
      setDbError(cfErrorText(reason))
      setDatabases([])
      setSelectedDb(null)
    } finally {
      setDbLoading(false)
    }
  }, [account.id])

  useEffect(() => {
    void loadDatabases()
  }, [loadDatabases])

  const selectedDbId = selectedDb?.id ?? null

  const loadTables = useCallback(async () => {
    if (!selectedDbId) {
      setTables([])
      return
    }
    setTablesLoading(true)
    setTablesError(null)
    try {
      const data = await storageApi.listD1Tables(account.id, selectedDbId)
      setTables(data.tables)
    } catch (reason) {
      setTablesError(cfErrorText(reason))
      setTables([])
    } finally {
      setTablesLoading(false)
    }
  }, [account.id, selectedDbId])

  useEffect(() => {
    setTables([])
    setTablesError(null)
    if (selectedDbId) void loadTables()
  }, [selectedDbId, loadTables])

  useEffect(() => {
    setSchemaTable(null)
    setCreateTableOpen(false)
  }, [selectedDbId])

  function remember(sqlText: string): void {
    const next = pushHistory(history, sqlText, historyLimit)
    setHistory(next)
    writeHistory(next, historyLimit)
  }

  async function execute(sqlText: string, allow: boolean): Promise<void> {
    const target = sqlText.trim()
    if (!selectedDb || !target || running) return
    setRunning(true)
    setQueryError(null)
    try {
      const data = await storageApi.executeD1Query(account.id, selectedDb.id, target, allow)
      setResult(data)
      remember(target)
    } catch (reason) {
      setResult(null)
      setQueryError(cfErrorText(reason))
    } finally {
      setRunning(false)
    }
  }

  function runSelection(): void {
    const selected = editorRef.current?.selection().trim() ?? ''
    const target = selected || editorRef.current?.cursorLine().trim() || ''
    if (target) void execute(target, allowWrite)
  }

  function runCursorLine(): void {
    const line = editorRef.current?.cursorLine().trim() ?? ''
    if (line) void execute(line, allowWrite)
  }

  async function createDatabase(name: string): Promise<void> {
    const created = await storageApi.createD1Database(account.id, name)
    toast({ title: t('cloudflare.storage.msg.database_created'), tone: 'success' })
    setSelectedDb(created)
    await loadDatabases()
  }

  async function deleteDatabase(database: D1Database): Promise<void> {
    const ok = await confirm({
      title: t('cloudflare.storage.msg.delete_database_title'),
      description: t('cloudflare.storage.msg.delete_database_confirm', { name: database.name }),
      confirmLabel: t('cloudflare.storage.confirm_delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await storageApi.deleteD1Database(account.id, database.id)
      toast({ title: t('cloudflare.storage.msg.database_deleted'), tone: 'success' })
      if (selectedDb?.id === database.id) {
        setSelectedDb(null)
        setResult(null)
        setTables([])
      }
      await loadDatabases()
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    }
  }

  function openTable(table: D1Table): void {
    const statement = `SELECT * FROM ${quoteIdent(table.name)} LIMIT 100`
    setSql(statement)
    void execute(statement, allowWrite)
  }

  function pickHistory(sqlText: string): void {
    editorRef.current?.insertText(sqlText)
  }

  function changeHistoryLimit(value: number): void {
    const next = clampHistoryLimit(value)
    setHistoryLimit(next)
    writeHistoryLimit(next)
    const trimmed = history.slice(0, next)
    setHistory(trimmed)
    writeHistory(trimmed, next)
  }

  function clearHistory(): void {
    setHistory([])
    writeHistory([], historyLimit)
  }

  const meta = result?.meta

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-3 max-lg:max-h-[46vh]">
        <aside className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
            <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('cloudflare.storage.database')}
            </h2>
            <Button
              size="sm"
              variant="primary"
              icon={<Plus size={14} />}
              disabled={readOnly}
              onClick={() => setCreateDbOpen(true)}
            >
              {t('cloudflare.storage.create')}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {dbError && <div className="p-1.5"><StorageError message={dbError} onRetry={() => { void loadDatabases() }} /></div>}
            {dbLoading && databases.length === 0 ? (
              <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-[var(--text-tertiary)]" /></div>
            ) : databases.length === 0 ? (
              <Empty compact title={t('cloudflare.storage.no_database')} />
            ) : (
              <ul className="space-y-0.5">
                {databases.map((database) => {
                  const active = selectedDb?.id === database.id
                  return (
                    <li
                      key={database.id}
                      className={cn(
                        'flex items-center gap-1 rounded-[var(--r-md)] px-1',
                        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => setSelectedDb(database)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-xs)] px-1.5 py-1.5 text-left text-[length:var(--text-12-5)] text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                      >
                        <Database size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                        <span className="truncate">{database.name}</span>
                      </button>
                      {!readOnly && (
                        <IconButton
                          label={uiT('common.delete')}
                          size="xs"
                          onClick={() => { void deleteDatabase(database) }}
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </aside>

        <aside className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
            <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('cloudflare.storage.tables')}
            </h2>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus size={14} />}
              disabled={!selectedDb || readOnly}
              onClick={() => setCreateTableOpen(true)}
            >
              {t('cloudflare.storage.create_table')}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {tablesError && <div className="p-1.5"><StorageError message={tablesError} onRetry={() => { void loadTables() }} /></div>}
            {!selectedDb ? (
              <Empty compact title={t('cloudflare.storage.no_database')} />
            ) : tablesLoading && tables.length === 0 ? (
              <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-[var(--text-tertiary)]" /></div>
            ) : tables.length === 0 ? (
              <Empty compact title={t('cloudflare.storage.no_tables')} />
            ) : (
              <ul className="space-y-0.5">
                {tables.map((table) => (
                  <li key={table.name} className="flex items-center gap-1 rounded-[var(--r-md)] px-1 hover:bg-[var(--bg-hover)]">
                    <button
                      type="button"
                      onClick={() => openTable(table)}
                      title={table.name}
                      className="min-w-0 flex-1 truncate rounded-[var(--r-xs)] px-1.5 py-1.5 text-left font-mono text-[length:var(--text-12)] text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                    >
                      {table.name}
                    </button>
                    <Badge tone="neutral">{table.rows}</Badge>
                    <IconButton
                      label={t('cloudflare.storage.view_schema')}
                      size="xs"
                      onClick={() => setSchemaTable(table.name)}
                    >
                      <Settings size={13} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      <section className="flex min-h-0 flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('cloudflare.storage.sql_query')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={running}
              disabled={!selectedDb || !sql.trim()}
              onClick={() => { void execute(sql, allowWrite) }}
            >
              {t('cloudflare.storage.d1_run_all')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!selectedDb || !sql.trim() || running}
              onClick={runSelection}
            >
              {t('cloudflare.storage.d1_run_selected')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!selectedDb || !sql.trim() || running}
              onClick={runCursorLine}
            >
              {t('cloudflare.storage.d1_run_cursor_line')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Trash2 size={14} />}
              disabled={!sql}
              onClick={() => setSql('')}
            >
              {t('cloudflare.storage.d1_clear_editor')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<History size={14} />}
              onClick={() => setHistoryOpen(true)}
            >
              {t('cloudflare.storage.d1_history')} ({history.length})
            </Button>
            <Checkbox
              checked={allowWrite}
              disabled={readOnly}
              onChange={setAllowWrite}
              label={t('cloudflare.storage.allow_write')}
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <SqlEditor
            ref={editorRef}
            value={sql}
            onChange={setSql}
            schema={editorSchema}
            ariaLabel={t('cloudflare.storage.sql_query')}
            minHeight={200}
          />

          {queryError && <StorageError message={queryError} />}

          {!selectedDb && (
            <Empty compact title={t('cloudflare.storage.no_database')} />
          )}

          {result && (
            <div className="flex min-h-0 flex-1 flex-col">
              <p className="shrink-0 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {t('cloudflare.storage.rows_read', { count: meta?.rows_read ?? 0 })}{' '}
                {t('cloudflare.storage.rows_written', { count: meta?.rows_written ?? 0 })}{' '}
                {t('cloudflare.storage.duration', { ms: Math.round(meta?.duration ?? 0) })}
              </p>
              <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
                {resultColumns.length > 0 ? (
                  <TableScroll label={t('cloudflare.storage.sql_query')}>
                    <Table>
                      <THead>
                        <Tr>
                          {resultColumns.map((column) => (
                            <SortableHead
                              key={column}
                              label={column}
                              sortKey={column}
                              sort={resultSort.state}
                              onToggle={resultSort.toggle}
                            />
                          ))}
                        </Tr>
                      </THead>
                      <TBody>
                        {sortedRows.map((row, index) => (
                          <Tr key={index}>
                            {resultColumns.map((column) => (
                              <Td
                                key={column}
                                className="max-w-64 truncate font-mono text-[length:var(--text-11-5)]"
                                title={cellText(row[column])}
                              >
                                {cellText(row[column])}
                              </Td>
                            ))}
                          </Tr>
                        ))}
                        {!sortedRows.length && (
                          <Tr>
                            <Td colSpan={resultColumns.length} className="py-6 text-center text-[var(--text-tertiary)]">
                              {t('cloudflare.compact_card.no_data')}
                            </Td>
                          </Tr>
                        )}
                      </TBody>
                    </Table>
                  </TableScroll>
                ) : (
                  <p className="py-4 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('cloudflare.compact_card.no_data')}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <CreateNameDialog
        open={createDbOpen}
        title={t('cloudflare.storage.d1')}
        label={t('cloudflare.storage.name_label')}
        placeholder={t('cloudflare.storage.name_label')}
        submitLabel={t('cloudflare.storage.create')}
        onClose={() => setCreateDbOpen(false)}
        onSubmit={createDatabase}
      />

      {selectedDb && (
        <CreateTableDialog
          open={createTableOpen}
          accountId={account.id}
          databaseId={selectedDb.id}
          onClose={() => setCreateTableOpen(false)}
          onCreated={(name) => {
            toast({ title: t('cloudflare.storage.msg.table_created', { name }), tone: 'success' })
            void loadTables()
          }}
        />
      )}

      {selectedDb && schemaTable && (
        <D1SchemaDialog
          open={Boolean(schemaTable)}
          accountId={account.id}
          databaseId={selectedDb.id}
          tableName={schemaTable}
          readOnly={readOnly}
          onClose={() => setSchemaTable(null)}
          onChanged={() => { void loadTables() }}
        />
      )}

      <SqlHistoryDialog
        open={historyOpen}
        entries={history}
        limit={historyLimit}
        onClose={() => setHistoryOpen(false)}
        onPick={pickHistory}
        onClear={clearHistory}
        onLimitChange={changeHistoryLimit}
      />
    </div>
  )
}
