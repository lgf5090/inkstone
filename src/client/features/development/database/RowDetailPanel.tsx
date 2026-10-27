import { useEffect, useMemo, useState } from 'react'
import { Loader2, Pencil, Save, X } from 'lucide-react'
import { INKSTONE_BLOB_KEY } from '@shared/development/database/types'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { RowJsonTree } from './RowJsonTree'

export interface RowDetailPanelProps {
  columns: string[]
  row: unknown[]
  title: string
  editable?: boolean
  readOnlyColumns?: Set<string>
  onSave?: (values: Record<string, string>) => Promise<void> | void
  onClose: () => void
}

function displayValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`
  if (value && typeof value === 'object' && INKSTONE_BLOB_KEY in value) return '[BLOB]'
  return value
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return value
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? parsed : value
  } catch {
    return value
  }
}

export function RowDetailPanel({
  columns,
  row,
  title,
  editable = false,
  readOnlyColumns,
  onSave,
  onClose,
}: RowDetailPanelProps) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setEditing(false)
    const next: Record<string, string> = {}
    columns.forEach((column, index) => {
      const value = row[index]
      next[column] = value === null || value === undefined ? '' : String(value)
    })
    setValues(next)
  }, [row, columns])

  const data = useMemo(() => {
    const object: Record<string, unknown> = {}
    columns.forEach((column, index) => {
      object[column] = displayValue(parseJsonString(row[index] ?? null))
    })
    return object
  }, [columns, row])

  const save = async () => {
    if (!onSave) return
    setSaving(true)
    try {
      await onSave(values)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-base)] shadow-[var(--shadow-pop)]">
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-2">
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{title}</span>
        {editable && !editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil size={12} />
            {t('development.database.detail.edit')}
          </Button>
        )}
        <IconButton label={t('development.database.detail.close')} size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>

      {editing ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          <div className="space-y-2">
            {columns.map((column) => {
              const readOnly = readOnlyColumns?.has(column)
              return (
                <label key={column} className="grid grid-cols-[minmax(80px,1fr)_2fr] items-center gap-2">
                  <span className="truncate text-[length:var(--text-11)] text-[var(--text-secondary)]" title={column}>
                    {column}
                  </span>
                  <Input
                    value={values[column] ?? ''}
                    disabled={readOnly}
                    placeholder={t('development.database.detail.null_placeholder')}
                    onChange={(event) => setValues((current) => ({ ...current, [column]: event.target.value }))}
                    className="h-8 text-[length:var(--text-12)]"
                  />
                </label>
              )
            })}
          </div>
          <div className="sticky bottom-0 mt-3 flex gap-1.5 bg-[var(--bg-base)] pt-1">
            <Button variant="secondary" size="sm" className="h-8 flex-1" onClick={() => setEditing(false)}>
              {t('development.database.detail.cancel')}
            </Button>
            <Button size="sm" className="h-8 flex-1" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {t('development.database.detail.save')}
            </Button>
          </div>
        </div>
      ) : (
        <RowJsonTree data={data} className="min-h-0 flex-1" />
      )}
    </div>
  )
}
