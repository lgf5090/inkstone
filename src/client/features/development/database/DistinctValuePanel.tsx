import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import type { StudioDriver } from './drivers'
import { buildDistinctSql } from './distinct-ops'

export interface DistinctValuePanelProps {
  open: boolean
  table: string
  column: string
  knownColumns: string[]
  driver: StudioDriver
  onPick: (value: string | null, count: number) => void
  onClose: () => void
}

interface DistinctState {
  loading: boolean
  error?: string
  rows?: Array<{ value: unknown; count: number }>
}

export function DistinctValuePanel({ open, table, column, knownColumns, driver, onPick, onClose }: DistinctValuePanelProps) {
  const [state, setState] = useState<DistinctState>({ loading: false })

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const sql = buildDistinctSql(table, column, knownColumns)
    if (!sql) {
      setState({ loading: false, error: t('development.database.grid.distinct_unavailable') })
      return
    }
    setState({ loading: true })
    driver.query(sql)
      .then((result) => {
        if (cancelled) return
        setState({
          loading: false,
          rows: result.rows.map((row) => ({ value: row[0], count: Number(row[1] ?? 0) })),
        })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ loading: false, error: cause instanceof Error ? cause.message : String(cause) })
      })
    return () => { cancelled = true }
  }, [open, table, column, knownColumns, driver])

  const rows = state.rows ?? []

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.database.grid.distinct_title', { column })}
      description={t('development.database.grid.distinct_hint')}
      width={420}
      footer={<Button variant="ghost" size="sm" onClick={onClose}>{t('development.database.common.cancel')}</Button>}
    >
      {state.loading ? (
        <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-[var(--text-tertiary)]" /></div>
      ) : state.error ? (
        <p className="rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-2 text-[length:var(--text-11)] text-[var(--danger)]">{state.error}</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.database.grid.distinct_empty')}</p>
      ) : (
        <ul className="max-h-80 overflow-y-auto">
          {rows.map((row, index) => {
            const text = row.value === null || row.value === undefined ? t('development.database.grid.distinct_null') : String(row.value)
            return (
              <li key={`${index}-${text}`}>
                <button
                  type="button"
                  onClick={() => onPick(row.value === null || row.value === undefined ? null : String(row.value), row.count)}
                  className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-1.5 py-1.5 text-left hover:bg-[var(--bg-hover)]"
                >
                  <span className="truncate font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]" title={text}>{text}</span>
                  <span className="ml-auto shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{row.count}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
