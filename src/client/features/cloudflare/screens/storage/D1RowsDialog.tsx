/**
 * A read-only window onto one D1 table: pageable rows, a search across every column, and a cell
 * viewer for values a table cell truncates. Editing and deleting are deliberately absent; this
 * dialog never sends a write.
 */
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { LoadingBlock } from '../../../../components/feedback'
import { Modal } from '../../../../components/overlay'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { t as uiT } from '../../../../lib/i18n'
import { cfErrorText } from '../../api/client'
import { storageApi, type D1RowsPage } from '../../api/storage'
import { useCfT } from '../../i18n'
import { SearchField } from '../../components/SearchField'
import { TBody, Table, TableScroll, Td, THead, Th, Tr } from '../../components/Table'
import { PanelError } from '../dns/PanelError'

const PAGE_SIZE = 50

function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value) } catch { return String(value) }
}

export function D1RowsDialog({
  open,
  onClose,
  accountId,
  databaseId,
  tableName,
}: {
  open: boolean
  onClose: () => void
  accountId: string
  databaseId: string
  tableName: string
}) {
  const tcf = useCfT()
  const [page, setPage] = useState(0)
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [data, setData] = useState<D1RowsPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [cell, setCell] = useState<{ column: string; value: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setPage(0)
    setSearch('')
    setSearchDraft('')
    setData(null)
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
          </div>
          {data ? (
            <span className="text-[length:var(--text-11-5)] tabular-nums text-[var(--text-tertiary)]">
              {tcf('cloudflare.storage.d1_rows_total', { total: data.total })}
            </span>
          ) : null}
        </div>

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
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </TableScroll>
            )}
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
      </div>
    </Modal>
  )
}
