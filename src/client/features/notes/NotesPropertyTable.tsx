import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownUp, Table2 } from 'lucide-react'
import { setFrontMatterValue, type FrontMatterListItem, type FrontMatterValue } from '@shared/markdown-utils'
import type { NotePropertyTableRow } from '@shared/types'
import { Button } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { FilterInput } from '../../components/FilterInput'
import { Modal } from '../../components/overlay'
import { api } from '../../lib/api'
import { compileQuery } from '../../lib/query-match'
import { useDebounced } from '../../lib/hooks'
import { isEnterKey, isImeComposing } from '../../lib/ime'
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+)?$/

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '')).join(', ')
  return value === null || value === undefined ? '' : String(value)
}

function frontMatterValue(value: unknown): FrontMatterValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item): FrontMatterListItem =>
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      ? item
      : JSON.stringify(item) ?? '')
  return JSON.stringify(value) ?? ''
}

function PropertyEditor({ label, value, disabled, onCommit }: {
  label: string
  value: unknown
  disabled: boolean
  onCommit: (value: unknown) => void
}) {
  const text = displayValue(value)
  const [draft, setDraft] = useState(text)
  const [committed, setCommitted] = useState(text)
  if (text !== committed) {
    setCommitted(text)
    setDraft(text)
  }
  const commit = () => {
    if (draft === committed) return
    setCommitted(draft)
    if (Array.isArray(value)) onCommit(draft.split(',').map((item) => item.trim()).filter(Boolean))
    else if (typeof value === 'number') onCommit(draft.trim() === '' ? '' : Number(draft))
    else onCommit(draft)
  }
  if (typeof value === 'boolean') {
    return <Checkbox checked={value} disabled={disabled} ariaLabel={label} onChange={onCommit}/>
  }
  if (typeof value === 'string' && DATE_VALUE.test(value)) {
    return <DatePicker label={label} value={value.slice(0, 10)} withTime={value.includes('T')} onChange={onCommit}/>
  }
  return (
    <Input
      type={typeof value === 'number' ? 'number' : 'text'}
      value={draft}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (isImeComposing(event)) return
        if (isEnterKey(event)) {
          event.preventDefault()
          commit()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          setDraft(committed)
          event.currentTarget.blur()
        }
      }}
      className="h-8 min-w-40 border-transparent bg-transparent px-1.5 hover:border-[var(--border-subtle)]"
    />
  )
}

export function NotesPropertyTable({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<NotePropertyTableRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query.trim(), 250)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null)
  const editRemoteContent = useNotes((state) => state.editRemoteContent)
  const openNote = useNotes((state) => state.openNote)
  const toast = useUi((state) => state.toast)

  const load = useCallback(async (afterId?: string) => {
    if (afterId) setLoadingMore(true)
    else setLoading(true)
    setError(null)
    try {
      const page = await api.notes.propertyTable({ cursor: afterId, q: debouncedQuery })
      setRows((current) => afterId ? [...current, ...page.rows] : page.rows)
      setCursor(page.nextCursor)
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [debouncedQuery])

  useEffect(() => { void load() }, [load])

  const columns = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of rows) {
      for (const key of Object.keys(row.properties)) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([key]) => key)
  }, [rows])

  const visibleRows = useMemo(() => {
    if (!sort) return rows
    const direction = sort.direction === 'asc' ? 1 : -1
    return [...rows].sort((left, right) => {
      const a = sort.key === 'title' ? left.note.title : left.properties[sort.key]
      const b = sort.key === 'title' ? right.note.title : right.properties[sort.key]
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction
      return displayValue(a).localeCompare(displayValue(b), undefined, { numeric: true }) * direction
    })
  }, [rows, sort])

  const updateProperty = async (row: NotePropertyTableRow, key: string, value: unknown) => {
    const requestKey = `${row.note.id}:${key}`
    setSaving(requestKey)
    try {
      const outcome = await editRemoteContent(row.note.id, (content) => setFrontMatterValue(content, key, frontMatterValue(value)))
      if (outcome !== 'written') {
        toast({ title: t('notes.table_conflict'), tone: 'warning' })
        return
      }
      setRows((current) => current.map((entry) => entry.note.id === row.note.id
        ? { ...entry, properties: { ...entry.properties, [key]: value } }
        : entry))
    }
    catch (cause) {
      toast({ title: t('notes.table_failed'), description: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    }
    finally {
      setSaving(null)
    }
  }

  const toggleSort = (key: string) => setSort((current) => current?.key === key
    ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: 'asc' })

  return (
    <Modal
      open
      onClose={onClose}
      title={t('notes.table_title')}
      description={t('notes.table_desc')}
      variant="fullscreen"
      bodyClassName="min-h-0 flex-1 overflow-hidden p-0"
      footer={<div className="flex items-center justify-between gap-3">
        <span role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {loading ? t('notes.table_loading') : t('notes.table_count', { value0: rows.length })}
        </span>
        {cursor && <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void load(cursor)}>
          {loadingMore ? t('notes.table_loading') : t('notes.table_load_more')}
        </Button>}
      </div>}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-[var(--border-subtle)] p-3">
          <FilterInput value={query} onChange={setQuery} query={compileQuery(query)} label={t('notes.table_filter')} placeholder={t('notes.table_filter')} size="sidebar"/>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? <div role="alert" className="m-3 rounded-[var(--r-md)] border border-[var(--danger)] p-3 text-[var(--text-secondary)]">
            <p>{error}</p>
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => void load()}>{t('common.retry')}</Button>
          </div> : !loading && !rows.length ? <div className="flex h-full items-center justify-center gap-2 text-[var(--text-tertiary)]">
            <Table2 size={18}/>{t('notes.table_empty')}
          </div> : <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-[var(--z-sticky)] bg-[var(--bg-overlay)]">
              <tr>
                <th scope="col" aria-sort={sort?.key === 'title' ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} className="min-w-56 border-b border-[var(--border-default)] p-2">
                  <button type="button" onClick={() => toggleSort('title')} className="inline-flex items-center gap-1 font-semibold text-[var(--text-secondary)]">
                    {t('notes.table_title_column')}<ArrowDownUp size={12}/>
                  </button>
                </th>
                {columns.map((key) => <th key={key} scope="col" aria-sort={sort?.key === key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} className="min-w-48 border-b border-[var(--border-default)] p-2">
                  <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 font-semibold text-[var(--text-secondary)]">
                    {key}<ArrowDownUp size={12}/>
                  </button>
                </th>)}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => <tr key={row.note.id} className="border-b border-[var(--border-subtle)]">
                <td className="p-2 align-top">
                  <button type="button" onClick={() => { onClose(); void openNote(row.note.id) }} className="max-w-56 truncate text-left font-medium text-[var(--accent)] hover:underline">
                    {row.note.title || t('common.untitled_note')}
                  </button>
                </td>
                {columns.map((key) => <td key={key} className="p-2 align-top">
                  <PropertyEditor
                    label={`${row.note.title}: ${key}`}
                    value={row.properties[key]}
                    disabled={saving === `${row.note.id}:${key}`}
                    onCommit={(value) => void updateProperty(row, key, value)}
                  />
                </td>)}
              </tr>)}
            </tbody>
          </table>}
        </div>
      </div>
    </Modal>
  )
}
