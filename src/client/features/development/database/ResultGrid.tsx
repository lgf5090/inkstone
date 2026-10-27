import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronsUpDown, EyeOff, ListFilter, Pin, PinOff, X } from 'lucide-react'
import { INKSTONE_BLOB_KEY, type TableSortRule } from '@shared/development/database/types'
import { cn } from '../../../lib/cn'
import { isImeComposing } from '../../../lib/ime'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Button } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Menu } from '../../../components/overlay'
import { toMarkdown } from './export-utils'

const ROW_HEIGHT = 34
const OVERSCAN = 8
const DEFAULT_COLUMN_WIDTH = 150
const MIN_COLUMN_WIDTH = 60
const ROW_NUMBER_WIDTH = 46

export interface ResultGridProps {
  columns: string[]
  rows: unknown[][]
  sort?: TableSortRule[]
  onSort?: (column: string, additive: boolean) => void
  onSortDir?: (column: string, direction: 'ASC' | 'DESC') => void
  onDistinctColumn?: (column: string) => void
  hiddenColumns?: Set<number>
  onToggleColumn?: (columnIndex: number) => void
  selectedRows?: Set<number>
  onSelectionChange?: (rows: Set<number>) => void
  selectedRow?: number | null
  onRowClick?: (rowIndex: number) => void
  rowKeyHint?: string
  editable?: boolean
  editing?: { row: number; col: number } | null
  onEdit?: (row: number, col: number) => void
  editValue?: string
  onEditValueChange?: (value: string) => void
  onEditCommit?: () => void
  onEditCancel?: () => void
  onCellContextMenu?: (row: number, col: number, x: number, y: number) => void
  className?: string
}

interface BlobValue {
  [INKSTONE_BLOB_KEY]: string
}

function blobSize(value: BlobValue): number {
  try {
    return Math.floor((value[INKSTONE_BLOB_KEY].length * 3) / 4)
  } catch {
    return 0
  }
}

export function renderCellValue(value: unknown): { text: string; className?: string; title?: string } {
  if (value === null || value === undefined) return { text: 'NULL', className: 'italic text-[var(--text-quaternary)]' }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return { text: String(value), className: 'text-right tabular-nums' }
  }
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', className: 'text-right tabular-nums' }
  if (value instanceof Uint8Array) {
    return { text: `[BLOB ${value.byteLength} bytes]`, className: 'text-[var(--text-tertiary)]' }
  }
  if (value && typeof value === 'object' && INKSTONE_BLOB_KEY in value) {
    return { text: `[BLOB ${blobSize(value as BlobValue)} bytes]`, className: 'text-[var(--text-tertiary)]' }
  }
  if (typeof value === 'object') {
    const text = JSON.stringify(value)
    return { text: text.length > 200 ? `${text.slice(0, 200)}…` : text, title: text }
  }
  const text = String(value)
  return text.length > 200 ? { text: `${text.slice(0, 200)}…`, title: text } : { text, title: text }
}

export function ResultGrid({
  columns,
  rows,
  sort,
  onSort,
  onSortDir,
  onDistinctColumn,
  hiddenColumns,
  onToggleColumn,
  selectedRows,
  onSelectionChange,
  selectedRow,
  onRowClick,
  rowKeyHint,
  editable = false,
  editing,
  onEdit,
  editValue,
  onEditValueChange,
  onEditCommit,
  onEditCancel,
  onCellContextMenu,
  className,
}: ResultGridProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const editInput = useRef<HTMLInputElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const [pinned, setPinned] = useState<Set<number>>(new Set())
  const [widths, setWidths] = useState<Record<number, number>>({})
  const [menu, setMenu] = useState<{ col: number; x: number; y: number } | null>(null)

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setViewportHeight(element.clientHeight || 600)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (editing) editInput.current?.focus()
  }, [editing])

  const visibleColumns = useMemo(
    () => columns.map((_, index) => index).filter((index) => !hiddenColumns?.has(index)),
    [columns, hiddenColumns],
  )

  const pinnedLeft = useMemo(() => {
    const map = new Map<number, number>()
    let left = ROW_NUMBER_WIDTH
    for (const index of visibleColumns) {
      if (!pinned.has(index)) continue
      map.set(index, left)
      left += widths[index] ?? DEFAULT_COLUMN_WIDTH
    }
    return map
  }, [visibleColumns, pinned, widths])

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  const visibleRows = rows.slice(start, end)

  const toggleRow = (index: number, event: MouseEvent) => {
    if (!onSelectionChange) return
    const next = new Set(selectedRows ?? [])
    if (event.shiftKey && selectedRows && selectedRows.size > 0) {
      const anchor = Math.min(...selectedRows)
      for (let cursor = Math.min(anchor, index); cursor <= Math.max(anchor, index); cursor++) next.add(cursor)
    } else if (event.ctrlKey || event.metaKey) {
      if (next.has(index)) next.delete(index)
      else next.add(index)
    } else {
      next.clear()
      next.add(index)
    }
    onSelectionChange(next)
  }

  const selectedTsv = useMemo(() => {
    if (!selectedRows || selectedRows.size === 0) return ''
    return [...selectedRows]
      .sort((left, right) => left - right)
      .map((index) => columns.map((_, column) => {
        const value = rows[index]?.[column]
        return value === null || value === undefined ? '' : String(value)
      }).join('\t'))
      .join('\n')
  }, [selectedRows, columns, rows])

  const resize = (event: ReactPointerEvent, column: number) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = widths[column] ?? DEFAULT_COLUMN_WIDTH
    const move = (pointer: globalThis.PointerEvent) => {
      setWidths((current) => ({
        ...current,
        [column]: Math.max(MIN_COLUMN_WIDTH, startWidth + pointer.clientX - startX),
      }))
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const openMenu = (column: number, event: MouseEvent) => {
    event.preventDefault()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ col: column, x: rect.left, y: rect.bottom + 4 })
  }

  const copySelected = async () => {
    const ok = await copyText(selectedTsv)
    useUi.getState().toast({
      title: ok ? t('development.database.grid.copied_tsv') : t('development.database.common.copy_failed'),
      tone: ok ? 'success' : 'danger',
    })
  }

  const copySelectedMarkdown = async () => {
    const selected = [...(selectedRows ?? [])].sort((left, right) => left - right)
      .map((index) => rows[index])
      .filter((row): row is unknown[] => Boolean(row))
    if (selected.length === 0) return
    const ok = await copyText(toMarkdown(columns, selected))
    useUi.getState().toast({
      title: ok ? t('development.database.grid.copied_markdown') : t('development.database.common.copy_failed'),
      tone: ok ? 'success' : 'danger',
    })
  }

  const menuItems = menu ? [
    {
      id: 'pin',
      label: pinned.has(menu.col) ? t('development.database.grid.unpin') : t('development.database.grid.pin'),
      icon: pinned.has(menu.col) ? <PinOff size={13} /> : <Pin size={13} />,
      onSelect: () => {
        setPinned((current) => {
          const next = new Set(current)
          if (next.has(menu.col)) next.delete(menu.col)
          else next.add(menu.col)
          return next
        })
        setMenu(null)
      },
    },
    {
      id: 'asc',
      label: t('development.database.grid.sort_asc'),
      icon: <ArrowUp size={13} />,
      onSelect: () => {
        onSortDir?.(columns[menu.col]!, 'ASC')
        setMenu(null)
      },
    },
    {
      id: 'desc',
      label: t('development.database.grid.sort_desc'),
      icon: <ArrowDown size={13} />,
      onSelect: () => {
        onSortDir?.(columns[menu.col]!, 'DESC')
        setMenu(null)
      },
    },
    ...(onDistinctColumn ? [{
      id: 'distinct',
      label: t('development.database.grid.distinct_values'),
      icon: <ListFilter size={13} />,
      separatorBefore: true,
      onSelect: () => {
        onDistinctColumn(columns[menu.col]!)
        setMenu(null)
      },
    }] : []),
    ...(onToggleColumn ? [{
      id: 'hide',
      label: t('development.database.grid.hide_column'),
      icon: <EyeOff size={13} />,
      separatorBefore: true,
      onSelect: () => {
        onToggleColumn(menu.col)
        setMenu(null)
      },
    }] : []),
  ] : []

  const tableColumns = visibleColumns.length + 1

  return (
    <div className={cn('relative h-full min-h-0', className)}>
      <div
        ref={viewport}
        className="h-full overflow-auto overscroll-contain"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <table className="w-full table-fixed border-collapse text-[length:var(--text-12)]">
          <thead className="sticky top-0 z-20 bg-[var(--bg-sunken)]">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-30 border-b border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1 text-center text-[length:var(--text-10)] font-medium text-[var(--text-tertiary)]"
                style={{ width: ROW_NUMBER_WIDTH, minWidth: ROW_NUMBER_WIDTH, maxWidth: ROW_NUMBER_WIDTH }}
              >
                #
              </th>
              {visibleColumns.map((column) => {
                const name = columns[column]!
                const ruleIndex = sort?.findIndex((rule) => rule.column === name) ?? -1
                const rule = ruleIndex >= 0 ? sort?.[ruleIndex] : undefined
                const sorted = Boolean(rule)
                const icon = !rule ? <ArrowUpDown size={12} /> : rule.dir === 'ASC' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                const isPinned = pinned.has(column)
                const width = widths[column] ?? DEFAULT_COLUMN_WIDTH
                return (
                  <th
                    key={`${name}-${column}`}
                    scope="col"
                    aria-sort={ruleIndex === 0 ? (rule!.dir === 'ASC' ? 'ascending' : 'descending') : undefined}
                    className={cn('group relative border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-0 py-0 text-left', isPinned && 'sticky z-30')}
                    style={{
                      width,
                      minWidth: MIN_COLUMN_WIDTH,
                      maxWidth: width,
                      ...(isPinned ? { left: pinnedLeft.get(column) } : {}),
                    }}
                  >
                    <div className="flex w-full items-center gap-0.5 px-1.5 py-1.5">
                      <button
                        type="button"
                        onClick={(event) => onSort?.(name, event.shiftKey)}
                        title={sorted ? (rule!.dir === 'ASC' ? t('development.database.grid.sort_asc_cancel') : t('development.database.grid.sort_desc_cancel')) : t('development.database.grid.click_sort')}
                        className="flex min-w-0 flex-1 items-center gap-1 truncate text-left font-semibold text-[var(--text-primary)]"
                      >
                        <span className="truncate">{name}</span>
                        {onSort && <span className={cn('shrink-0', sorted ? 'text-[var(--accent)]' : 'opacity-30')}>{icon}</span>}
                        {sorted && (sort?.length ?? 0) > 1 && (
                          <span aria-hidden="true" className="shrink-0 rounded-full bg-[var(--accent-soft)] px-1 text-[length:var(--text-9)] font-medium text-[var(--accent)]">
                            {ruleIndex + 1}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => openMenu(column, event)}
                        aria-label={t('development.database.grid.column_actions')}
                        title={t('development.database.grid.column_actions')}
                        className="rounded p-0.5 text-[var(--text-quaternary)] opacity-0 transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <ChevronsUpDown size={12} />
                      </button>
                    </div>
                    <div
                      className="absolute right-0 top-0 z-30 h-full w-1.5 cursor-col-resize hover:bg-[var(--accent)]/40"
                      onPointerDown={(event) => resize(event, column)}
                      aria-hidden="true"
                    />
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            <tr aria-hidden="true" style={{ height: start * ROW_HEIGHT }}>
              <td colSpan={tableColumns} />
            </tr>
            {visibleRows.map((row, visibleIndex) => {
              const index = start + visibleIndex
              const selected = selectedRows?.has(index) ?? false
              const detail = selectedRow === index
              return (
                <tr
                  key={index}
                  onClick={(event) => {
                    if (event.shiftKey || event.ctrlKey || event.metaKey) {
                      toggleRow(index, event)
                      return
                    }
                    onRowClick?.(index)
                    onSelectionChange?.(new Set([index]))
                  }}
                  className={cn(
                    'border-b border-[var(--border-subtle)] transition-colors',
                    detail ? 'bg-[var(--bg-active)]' : selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                  )}
                  style={{ height: ROW_HEIGHT }}
                >
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1 text-center text-[length:var(--text-10)] font-normal text-[var(--text-quaternary)]"
                  >
                    {index + 1}
                  </th>
                  {visibleColumns.map((column) => {
                    const isPinned = pinned.has(column)
                    const cell = renderCellValue(row[column])
                    const isEditing = editable && editing?.row === index && editing.col === column
                    if (isEditing) {
                      return (
                        <td key={`${column}-${index}`} className={cn('p-0', isPinned && 'sticky z-[var(--z-sticky)]')}
                        style={isPinned ? { left: pinnedLeft.get(column), background: 'var(--bg-base)' } : undefined}>
                          <Input
                            ref={editInput}
                            value={editValue ?? ''}
                            onChange={(event) => onEditValueChange?.(event.target.value)}
                            onKeyDown={(event) => {
                              if (isImeComposing(event)) return
                              if (event.key === 'Enter') {
                                event.stopPropagation()
                                onEditCommit?.()
                              } else if (event.key === 'Escape') {
                                event.stopPropagation()
                                onEditCancel?.()
                              }
                            }}
                            onClick={(event) => event.stopPropagation()}
                            className="h-[32px] rounded-none border-2 border-[var(--accent)] px-1.5 text-[length:var(--text-12)]"
                          />
                        </td>
                      )
                    }
                    return (
                      <td
                        key={`${column}-${index}`}
                        className={cn('truncate px-1.5', cell.className, editable && 'cursor-cell', isPinned && 'sticky z-10 bg-[var(--bg-base)]')}
                        style={isPinned ? { left: pinnedLeft.get(column) } : undefined}
                        title={cell.title}
                        onDoubleClick={() => editable && onEdit?.(index, column)}
                        onContextMenu={(event) => {
                          if (!onCellContextMenu) return
                          event.preventDefault()
                          onCellContextMenu(index, column, event.clientX, event.clientY)
                        }}
                      >
                        {cell.text}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            <tr aria-hidden="true" style={{ height: Math.max(0, rows.length - end) * ROW_HEIGHT }}>
              <td colSpan={tableColumns} />
            </tr>
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-10 flex flex-col items-center gap-1 py-8 text-[var(--text-tertiary)]">
            <span className="text-[length:var(--text-13)]">{t('development.database.grid.no_data')}</span>
            {rowKeyHint && <span className="text-[length:var(--text-11)] opacity-70">{rowKeyHint}</span>}
          </div>
        )}
      </div>

      {selectedRows && selectedRows.size > 0 && onSelectionChange && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
          <div className="pointer-events-auto flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-1.5 text-[length:var(--text-12)] shadow-[var(--shadow-pop)]">
            <span>{t('development.database.grid.selected_rows', { count: selectedRows.size })}</span>
            <Button variant="secondary" size="sm" onClick={() => void copySelected()}>
              {t('development.database.grid.copy_tsv')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void copySelectedMarkdown()}>
              {t('development.database.grid.copy_markdown')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onSelectionChange(new Set())}>
              <X size={12} />
              {t('development.database.common.clear')}
            </Button>
          </div>
        </div>
      )}

      <Menu
        anchor={menu ? { x: menu.x, y: menu.y } : { x: 0, y: 0 }}
        open={menu !== null}
        onClose={() => setMenu(null)}
        label={t('development.database.grid.column_actions')}
        items={menuItems}
        width={190}
      />
    </div>
  )
}
