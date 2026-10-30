import { useRef, useState } from 'react'
import { Loader2, Square, Table2 } from 'lucide-react'
import type { ParsedTable } from '@shared/development/database/types'
import { t } from '../../../lib/i18n'
import { isImeComposing } from '../../../lib/ime'
import { Button } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import type { StudioDriver } from './drivers'
import { DATA_SEARCH_LIMIT_MAX, buildDataSearchSql, searchableColumns } from './data-search'

export interface DatabaseSearchPanelProps {
  open: boolean
  tables: ParsedTable[]
  driver: StudioDriver
  onClose: () => void
  onOpenTable: (table: string) => void
  onError: (message: string) => void
}

interface TableHit {
  table: string
  rows: unknown[][]
  columns: string[]
}

export function DatabaseSearchPanel({ open, tables, driver, onClose, onOpenTable, onError }: DatabaseSearchPanelProps) {
  const [keyword, setKeyword] = useState('')
  const [limit, setLimit] = useState('20')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; table: string } | null>(null)
  const [hits, setHits] = useState<TableHit[]>([])
  const [failures, setFailures] = useState<Array<{ table: string; message: string }>>([])
  const [searched, setSearched] = useState(false)
  const cancelled = useRef(false)

  const reset = () => {
    setHits([])
    setFailures([])
    setProgress(null)
    setSearched(false)
  }

  const close = () => {
    cancelled.current = true
    onClose()
  }

  const run = async () => {
    const text = keyword.trim()
    if (!text || running) return
    reset()
    cancelled.current = false
    setRunning(true)
    const perTable = Math.max(1, Math.min(DATA_SEARCH_LIMIT_MAX, Math.trunc(Number(limit)) || 20))
    const found: TableHit[] = []
    const errors: Array<{ table: string; message: string }> = []
    try {
      for (let index = 0; index < tables.length; index++) {
        if (cancelled.current) break
        const table = tables[index]!
        setProgress({ done: index, total: tables.length, table: table.name })
        const columns = searchableColumns(table.columns)
        const built = buildDataSearchSql(table.name, columns, text, perTable)
        if (!built) continue
        try {
          const result = await driver.query(built.sql, built.params)
          if (result.rows.length > 0) found.push({ table: table.name, rows: result.rows, columns: result.columns })
        } catch (error) {
          errors.push({ table: table.name, message: error instanceof Error ? error.message : String(error) })
        }
        if (found.length > 0) setHits([...found])
      }
      setHits(found)
      setFailures(errors)
      setSearched(true)
      if (errors.length > 0) {
        onError(t('development.database.search.table_failed', { table: errors[0]!.table, message: errors[0]!.message }))
      }
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const stop = () => { cancelled.current = true }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('development.database.search.title')}
      description={t('development.database.search.hint', { tables: tables.length })}
      width={720}
      footer={<Button variant="ghost" size="sm" onClick={close}>{t('development.database.common.cancel')}</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.search.keyword')}</span>
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') void run() }}
              placeholder={t('development.database.search.placeholder')}
              className="h-8"
            />
          </label>
          <label className="w-28 shrink-0">
            <span className="mb-1 block text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.search.limit')}</span>
            <Input value={limit} onChange={(event) => setLimit(event.target.value)} className="h-8" inputMode="numeric" />
          </label>
          {running ? (
            <Button variant="secondary" size="sm" onClick={stop}>
              <Square size={12} />
              {t('development.database.search.stop')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => void run()} disabled={!keyword.trim()}>
              {t('development.database.search.run')}
            </Button>
          )}
        </div>

        {running && progress && (
          <div className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]" role="status">
            <Loader2 size={12} className="animate-spin" />
            {t('development.database.search.progress', { done: progress.done, total: progress.total, table: progress.table })}
          </div>
        )}

        <div className="max-h-80 space-y-2 overflow-y-auto">
          {failures.length > 0 && (
            <div role="alert" className="rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-2 text-[length:var(--text-11)] leading-relaxed text-[var(--danger)]">
              {failures.slice(0, 3).map((failure) => (
                <p key={failure.table}>{t('development.database.search.table_failed', { table: failure.table, message: failure.message })}</p>
              ))}
            </div>
          )}
          {hits.length === 0 && searched && !running && (
            <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.database.search.no_results')}</p>
          )}
          {hits.map((hit) => (
            <div key={hit.table} className="rounded-[var(--r-md)] border border-[var(--border-subtle)]">
              <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1">
                <Table2 size={12} className="text-[var(--text-tertiary)]" />
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11)] text-[var(--text-primary)]">{hit.table}</span>
                <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.search.row_count', { count: hit.rows.length })}</span>
                <Button variant="ghost" size="sm" onClick={() => { onOpenTable(hit.table); close() }}>{t('development.database.search.open_table')}</Button>
              </div>
              <ul className="divide-y divide-[var(--border-subtle)]">
                {hit.rows.slice(0, 5).map((row, index) => (
                  <li key={index} className="truncate px-2 py-1 font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]" title={row.map((value) => String(value ?? '')).join(' | ')}>
                    {row.map((value) => String(value ?? 'NULL')).join(' | ')}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
