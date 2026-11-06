/**
 * A window onto one D1 table: pageable rows, a search across every column, cell viewing, and
 * single-row edit/delete once the reader explicitly turns writes on. The key is the table's primary
 * key; the server rebuilds both statements from the schema and binds every value.
 */
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Pencil, Trash2 } from 'lucide-react'
import { LoadingBlock } from '../../../../components/feedback'
import { Checkbox, Field, Input } from '../../../../components/form'
import { Modal, confirm } from '../../../../components/overlay'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { t as uiT } from '../../../../lib/i18n'
import { quoteIdent } from '@shared/cloudflare/sql-utils'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { storageApi, type D1RowsPage } from '../../api/storage'
import { useCfT } from '../../i18n'
import { SearchField } from '../../components/SearchField'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../../components/Table'
import { PanelError } from '../dns/PanelError'

const PAGE_SIZE = 50

type RowKey = Record<string, string | number | null>

function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value) } catch { return String(value) }
}

function sqlLiteral(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${value.replace(/'/g, "''")}'`
}

function rowKey(row: Record<string, unknown>, primaryKey: readonly string[]): RowKey | null {
  const key: RowKey = {}
  for (const column of primaryKey) {
    const value = row[column]
    if (value === null) key[column] = null
    else if (typeof value === 'string' || typeof value === 'number') key[column] = value
    else return null
  }
  return key
}

function whereSql(key: RowKey, primaryKey: readonly string[]): string {
  return primaryKey.map((column) => `${quoteIdent(column)} = ${sqlLiteral(key[column] ?? null)}`).join(' AND ')
}

function draftFor(row: Record<string, unknown>, columns: readonly string[]): Record<string, string> {
  const draft: Record<string, string> = {}
  for (const column of columns) {
    const value = row[column]
    draft[column] = value === null || value === undefined ? '' : String(value)
  }
  return draft
}

function changedValues(
  row: Record<string, unknown>,
  draft: Record<string, string>,
  columns: readonly string[],
  primaryKey: readonly string[],
): { values: Record<string, string | number | null>; invalid: string | null } {
  const values: Record<string, string | number | null> = {}
  for (const column of columns) {
    if (primaryKey.includes(column)) continue
    const original = row[column]
    const text = draft[column] ?? ''
    if (String(original ?? '') === text) continue
    if (typeof original === 'number') {
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) return { values, invalid: `${column} must be a number` }
      values[column] = parsed
    } else {
      values[column] = text
    }
  }
  return { values, invalid: null }
}

export function D1RowsDialog({
  open,
  onClose,
  accountId,
  databaseId,
  tableName,
  readOnly,
}: {
  open: boolean
  onClose: () => void
  accountId: string
  databaseId: string
  tableName: string
  readOnly: boolean
}) {
  const tcf = useCfT()
  const toast = useUi((state) => state.toast)
  const [page, setPage] = useState(0)
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [data, setData] = useState<D1RowsPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [cell, setCell] = useState<{ column: string; value: string } | null>(null)
  const [allowWrite, setAllowWrite] = useState(false)
  const [editRow, setEditRow] = useState<Record<string, unknown> | null>(null)
  const [editDraft, setEditDraft] = useState<Record<string, string>>({})
  const [writeError, setWriteError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setPage(0)
    setSearch('')
    setSearchDraft('')
    setData(null)
    setAllowWrite(false)
    setEditRow(null)
    setWriteError(null)
  }, [open, accountId, databaseId, tableName])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void storageApi.listD1Rows(accountId, databaseId, tableName, {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      search,
    })
      .then((body) => { if (!cancelled) setData(body) })
      .catch((reason: unknown) => { if (!cancelled) setError(cfErrorText(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, accountId, databaseId, tableName, page, search, reload])

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const applySearch = (): void => {
    setSearch(searchDraft.trim())
    setPage(0)
  }

  function startEdit(row: Record<string, unknown>): void {
    setEditRow(row)
    setEditDraft(draftFor(row, data?.columns ?? []))
    setWriteError(null)
  }

  async function saveEdit(): Promise<void> {
    if (!data || !editRow) return
    const key = rowKey(editRow, data.primaryKey)
    if (!key) {
      setWriteError(tcf('cloudflare.storage.d1_rows_no_pk'))
      return
    }
    const { values, invalid } = changedValues(editRow, editDraft, data.columns, data.primaryKey)
    if (invalid) {
      setWriteError(invalid)
      return
    }
    if (Object.keys(values).length === 0) return
    setSaving(true)
    setWriteError(null)
    try {
      await storageApi.updateD1Row(accountId, databaseId, tableName, key, values)
      toast({ title: tcf('cloudflare.storage.d1_rows_updated'), tone: 'success' })
      setEditRow(null)
      setReload((value) => value + 1)
    } catch (reason) {
      setWriteError(cfErrorText(reason))
    } finally {
      setSaving(false)
    }
  }

  async function deleteRow(row: Record<string, unknown>): Promise<void> {
    if (!data) return
    const key = rowKey(row, data.primaryKey)
    if (!key) return
    const sql = `DELETE FROM ${quoteIdent(tableName)} WHERE ${whereSql(key, data.primaryKey)}`
    const ok = await confirm({
      title: tcf('cloudflare.storage.d1_rows_delete_confirm_title'),
      description: (
        <div className="space-y-2">
          <p>{tcf('cloudflare.storage.d1_rows_delete_confirm')}</p>
          <pre className="overflow-x-auto rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-11-5)] whitespace-pre-wrap break-all">
            {sql}
          </pre>
        </div>
      ),
      confirmLabel: tcf('cloudflare.storage.d1_rows_delete'),
      cancelLabel: uiT('common.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setSaving(true)
    try {
      await storageApi.deleteD1Row(accountId, databaseId, tableName, key)
      toast({ title: tcf('cloudflare.storage.d1_rows_deleted'), tone: 'success' })
      if (page > 0 && data.rows.length === 1) setPage((value) => value - 1)
      else setReload((value) => value + 1)
    } catch (reason) {
      toast({ title: cfErrorText(reason), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  const preview = (() => {
    if (!data || !editRow) return ''
    const key = rowKey(editRow, data.primaryKey)
    if (!key) return ''
    const { values } = changedValues(editRow, editDraft, data.columns, data.primaryKey)
    if (Object.keys(values).length === 0) return ''
    const assignments = Object.entries(values)
      .map(([column, value]) => `${quoteIdent(column)} = ${sqlLiteral(value)}`)
      .join(', ')
    return `UPDATE ${quoteIdent(tableName)} SET ${assignments} WHERE ${whereSql(key, data.primaryKey)}`
  })()

  const canEditRows = Boolean(data && data.primaryKey.length > 0 && !readOnly)
  const canAct = canEditRows && allowWrite && !saving

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tcf('cloudflare.storage.d1_rows_title', { table: tableName })}
      width={980}
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              value={searchDraft}
              onChange={setSearchDraft}
              onSubmit={applySearch}
              placeholder={tcf('cloudflare.storage.d1_rows_search')}
              label={tcf('cloudflare.storage.d1_rows_search')}
              className="w-56"
            />
            <Button size="sm" variant="secondary" onClick={applySearch}>
              {tcf('cloudflare.storage.d1_rows_query')}
            </Button>
            <Badge tone="neutral">{tcf('cloudflare.storage.d1_rows_readonly')}</Badge>
            {!readOnly && data?.primaryKey.length ? (
              <Checkbox
                checked={allowWrite}
                onChange={setAllowWrite}
                label={tcf('cloudflare.storage.d1_rows_write_enable')}
              />
            ) : null}
          </div>
          {data ? (
            <span className="text-[length:var(--text-11-5)] tabular-nums text-[var(--text-tertiary)]">
              {tcf('cloudflare.storage.d1_rows_total', { total: data.total })}
            </span>
          ) : null}
        </div>

        {data && data.primaryKey.length === 0 && !readOnly ? (
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {tcf('cloudflare.storage.d1_rows_no_pk')}
          </p>
        ) : null}

        {loading && !data ? <LoadingBlock /> : error && !data ? (
          <PanelError message={error} onRetry={() => setReload((value) => value + 1)} />
        ) : data ? (
          <>
            {error ? <PanelError message={error} onRetry={() => setReload((value) => value + 1)} /> : null}
            {data.rows.length === 0 ? (
              <p className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {tcf('cloudflare.storage.d1_rows_empty')}
              </p>
            ) : (
              <TableScroll label={tcf('cloudflare.storage.d1_rows_title', { table: tableName })}>
                <Table>
                  <THead><Tr>
                    {data.columns.map((column) => <Th key={column}>{column}</Th>)}
                    {canEditRows ? <Th>{tcf('cloudflare.storage.d1_rows_actions')}</Th> : null}
                  </Tr></THead>
                  <TBody>
                    {data.rows.map((row, index) => (
                      <Tr key={index}>
                        {data.columns.map((column) => {
                          const text = cellText(row[column])
                          return (
                            <Td key={column}>
                              <button
                                type="button"
                                onClick={() => setCell({ column, value: text })}
                                title={text}
                                className="block max-w-56 truncate rounded-[var(--r-xs)] text-left font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                              >
                                {text || '—'}
                              </button>
                            </Td>
                          )
                        })}
                        {canEditRows ? (
                          <Td>
                            <div className="flex items-center gap-1">
                              <IconButton
                                label={tcf('cloudflare.storage.d1_rows_edit')}
                                size="xs"
                                disabled={!canAct}
                                onClick={() => startEdit(row)}
                              >
                                <Pencil size={13} />
                              </IconButton>
                              <IconButton
                                label={tcf('cloudflare.storage.d1_rows_delete')}
                                size="xs"
                                disabled={!canAct}
                                onClick={() => { void deleteRow(row) }}
                              >
                                <Trash2 size={13} />
                              </IconButton>
                            </div>
                          </Td>
                        ) : null}
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableScroll>
            )}
            {canEditRows && !allowWrite ? (
              <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {tcf('cloudflare.storage.d1_rows_write_hint')}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <IconButton
                label={uiT('reading.previous_page')}
                size="sm"
                disabled={page <= 0 || loading}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </IconButton>
              <span aria-live="polite" className="min-w-14 text-center text-[length:var(--text-11-5)] tabular-nums text-[var(--text-tertiary)]">
                {page + 1} / {pages}
              </span>
              <IconButton
                label={uiT('reading.next_page')}
                size="sm"
                disabled={page + 1 >= pages || loading}
                onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}
              >
                <ChevronRight size={14} aria-hidden="true" />
              </IconButton>
            </div>
          </>
        ) : null}

        <Modal open={cell !== null} onClose={() => setCell(null)} title={cell?.column ?? ''} width={560}>
          <pre className="max-h-[60vh] overflow-auto rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-3 font-mono text-[length:var(--text-11-5)] whitespace-pre-wrap break-all text-[var(--text-secondary)]">
            {cell?.value ?? ''}
          </pre>
        </Modal>

        <Modal
          open={editRow !== null}
          onClose={() => setEditRow(null)}
          title={tcf('cloudflare.storage.d1_rows_edit_title', { table: tableName })}
          width={640}
          dismissible={!saving}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setEditRow(null)} disabled={saving}>{uiT('common.cancel')}</Button>
              <Button
                variant="primary"
                loading={saving}
                disabled={!preview}
                onClick={() => { void saveEdit() }}
              >
                {uiT('common.save')}
              </Button>
            </>
          )}
        >
          {data && editRow ? (
            <div className="space-y-3">
              {data.columns.map((column) => {
                const isKey = data.primaryKey.includes(column)
                return (
                  <Field key={column} label={column}>
                    <Input
                      value={editDraft[column] ?? ''}
                      disabled={isKey}
                      className="font-mono text-[length:var(--text-11-5)]"
                      onChange={(event) => setEditDraft((current) => ({ ...current, [column]: event.target.value }))}
                    />
                  </Field>
                )
              })}
              <div>
                <p className="mb-1 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
                  {tcf('cloudflare.storage.d1_rows_sql_preview')}
                </p>
                <pre className="max-h-40 overflow-auto rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-11-5)] whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                  {preview || tcf('cloudflare.storage.d1_rows_no_changes')}
                </pre>
              </div>
              {writeError ? <PanelError message={writeError} onRetry={() => setWriteError(null)} /> : null}
            </div>
          ) : null}
        </Modal>
      </div>
    </Modal>
  )
}
