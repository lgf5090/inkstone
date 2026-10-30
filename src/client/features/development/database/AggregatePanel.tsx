import { useMemo, useRef, useState } from 'react'
import { Calculator } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Segmented } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { ToolbarPanel } from './ToolbarPanel'

export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max'
type Scope = 'all' | 'selected'

export interface AggregatePanelProps {
  columns: string[]
  rows: unknown[][]
  selectedRows: Set<number>
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return null
}

export function AggregatePanel({ columns, rows, selectedRows }: AggregatePanelProps) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [column, setColumn] = useState(columns[0] ?? '')
  const [fn, setFn] = useState<AggregateFunction>('count')
  const [scope, setScope] = useState<Scope>('all')

  const result = useMemo(() => {
    const index = columns.indexOf(column)
    if (index < 0) return null
    const values = (scope === 'selected'
      ? [...selectedRows].sort((left, right) => left - right).map((row) => rows[row]?.[index])
      : rows.map((row) => row[index])
    ).filter((value) => value !== null && value !== undefined)
    if (fn === 'count') return { label: t('development.database.aggregate.non_null'), value: values.length }
    const numbers = values.map(toNumber).filter((value): value is number => value !== null)
    if (fn === 'sum') return { label: t('development.database.aggregate.sum_label'), value: numbers.reduce((sum, value) => sum + value, 0) }
    if (fn === 'avg') return { label: t('development.database.aggregate.avg_label'), value: numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : '—' }
    if (fn === 'min') return { label: t('development.database.aggregate.min_label'), value: numbers.length ? Math.min(...numbers) : '—' }
    return { label: t('development.database.aggregate.max_label'), value: numbers.length ? Math.max(...numbers) : '—' }
  }, [columns, column, fn, rows, scope, selectedRows])

  const format = (value: unknown): string => typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(4) : String(value ?? '—')
  const functions: Array<{ value: AggregateFunction; label: string }> = [
    { value: 'count', label: t('development.database.aggregate.count') },
    { value: 'sum', label: t('development.database.aggregate.sum') },
    { value: 'avg', label: t('development.database.aggregate.avg') },
    { value: 'min', label: t('development.database.aggregate.min') },
    { value: 'max', label: t('development.database.aggregate.max') },
  ]

  return (
    <>
      <Button ref={anchor} variant="secondary" size="sm" onClick={() => setOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={open}>
        <Calculator size={14} />
        {t('development.database.aggregate.button')}
      </Button>
      <ToolbarPanel open={open} onClose={() => setOpen(false)} anchor={anchor} label={t('development.database.aggregate.button')} width={300}>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.aggregate.column')}</div>
            <SelectMenu
              label={t('development.database.aggregate.column')}
              value={column}
              options={columns.map((name) => ({ value: name, label: name }))}
              onChange={setColumn}
            />
          </div>
          <div>
            <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.aggregate.function')}</div>
            <SelectMenu
              label={t('development.database.aggregate.function')}
              value={fn}
              options={functions}
              onChange={setFn}
            />
          </div>
          <div>
            <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.aggregate.scope')}</div>
            <Segmented
              value={scope}
              onChange={setScope}
              label={t('development.database.aggregate.scope')}
              options={[
                { value: 'all', label: t('development.database.aggregate.all_rows', { count: rows.length }) },
                { value: 'selected', label: t('development.database.aggregate.selected_rows', { count: selectedRows.size }) },
              ]}
            />
          </div>
          {result && (
            <div className="flex items-center justify-between rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2">
              <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{result.label}</span>
              <span className="font-mono text-[length:var(--text-14)] font-semibold tabular-nums text-[var(--text-primary)]">{format(result.value)}</span>
            </div>
          )}
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.database.aggregate.current_page_only')}</p>
        </div>
      </ToolbarPanel>
    </>
  )
}
