import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Code2,
  Columns3,
  FileJson,
  FileText,
  Filter,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Undo2,
  Upload,
  Wand2,
  X,
} from 'lucide-react'
import type { ParsedTable, QueryResult, TableSortRule } from '@shared/development/database/types'
import { MAX_QUERY_BYTES, MAX_QUERY_ROWS } from '@shared/development/database/types'
import { quoteIdent } from '@shared/development/database/sql-utils'
import { isImeComposing } from '../../../lib/ime'
import { t, type MessageKey } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Field, Input } from '../../../components/form'
import { Menu, Modal, confirm, prompt } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import { ResultGrid } from './ResultGrid'
import { RowDetailPanel } from './RowDetailPanel'
import { DistinctValuePanel } from './DistinctValuePanel'
import { CellTransformDialog } from './CellTransformDialog'
import { CsvImportDialog } from './CsvImportDialog'
import { DataGenerateDialog } from './DataGenerateDialog'
import { ExportPanel } from './ExportPanel'
import { AggregatePanel } from './AggregatePanel'
import { ToolbarPanel } from './ToolbarPanel'
import type { StudioDriver } from './drivers'
import { buildCountSql, buildTableDataSql, primaryKeyColumns } from './schema-utils'
import { buildWhere } from './filter-ops'
import { buildDelete, buildInsert, buildUpdate, fromTemporalInput, rowKeyOf, temporalKind, toTemporalInput } from './row-ops'
import { projectColumns, sqlLiteral } from './export-utils'
import type { FilterCondition, FilterOperator } from './types'

const PAGE_SIZES = [50, 100, 200] as const

const OPERATORS: Array<{ value: FilterOperator; labelKey: string }> = [
  { value: 'equals', labelKey: 'development.database.table.op_equals' },
  { value: 'notEquals', labelKey: 'development.database.table.op_not_equals' },
  { value: 'contains', labelKey: 'development.database.table.op_contains' },
  { value: 'startsWith', labelKey: 'development.database.table.op_starts_with' },
  { value: 'endsWith', labelKey: 'development.database.table.op_ends_with' },
  { value: 'gt', labelKey: 'development.database.table.op_gt' },
  { value: 'gte', labelKey: 'development.database.table.op_gte' },
  { value: 'lt', labelKey: 'development.database.table.op_lt' },
  { value: 'lte', labelKey: 'development.database.table.op_lte' },
  { value: 'isNull', labelKey: 'development.database.table.op_is_null' },
  { value: 'notNull', labelKey: 'development.database.table.op_not_null' },
]

export interface DataTableProps {
  ensureWritable?: () => Promise<boolean>
  onSchemaChanged?: () => void
  driver: StudioDriver
  table: ParsedTable
  onError: (message: string) => void
}

function isBlobValue(value: unknown): boolean {
  return value instanceof Uint8Array || (Boolean(value) && typeof value === 'object' && '__inkstone_blob__' in (value as object))
}

export function DataTable({ driver, table, ensureWritable, onSchemaChanged, onError }: DataTableProps) {
  const pkColumns = useMemo(() => primaryKeyColumns(table), [table])
  const useRowid = pkColumns.length === 0 && !table.withoutRowid
  const editable = pkColumns.length > 0 || useRowid
  const [columns, setColumns] = useState<string[]>(table.columns.map((column) => column.name))
  const [rows, setRows] = useState<unknown[][]>([])
  const [rowids, setRowids] = useState<unknown[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<number>(50)
  const [sort, setSort] = useState<TableSortRule[]>([])
  const [filters, setFilters] = useState<FilterCondition[]>([])
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const columnsAnchor = useRef<HTMLButtonElement>(null)
  const [hiddenColumns, setHiddenColumns] = useState<Set<number>>(new Set())
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [detailRow, setDetailRow] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [dirty, setDirty] = useState<Map<number, Map<number, unknown>>>(new Map())
  const [insertOpen, setInsertOpen] = useState(false)
  const [insertValues, setInsertValues] = useState<Record<string, string>>({})
  const [insertNulls, setInsertNulls] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<{ row: number; col: number; x: number; y: number } | null>(null)
  const [cellEditor, setCellEditor] = useState<{ row: number; col: number; value: string; format: 'text' | 'json' } | null>(null)
  const [distinctColumn, setDistinctColumn] = useState<string | null>(null)
  const [transformCell, setTransformCell] = useState<{ row: number; col: number } | null>(null)
  const [sqlOpen, setSqlOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [insertCount, setInsertCount] = useState('1')
  const [refreshSeconds, setRefreshSeconds] = useState(0)
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null)
  const [currentSql, setCurrentSql] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const searchColumns = useMemo(() => table.columns.map((column) => column.name), [table.columns])
  const where = useMemo(() => buildWhere(filters, debouncedSearch, searchColumns), [filters, debouncedSearch, searchColumns])
  const readOnlyColumns = useMemo(
    () => new Set(table.columns.filter((column) => /blob/i.test(column.type) || Boolean(column.generated)).map((column) => column.name)),
    [table.columns],
  )
  const visible = useMemo(() => projectColumns(columns, rows, hiddenColumns), [columns, rows, hiddenColumns])
  const visibleColumns = visible.columns

  const load = useCallback(async (
    targetPage: number,
    targetPageSize: number,
    targetSort: TableSortRule[],
    targetWhere?: { sql: string; params: unknown[] } | null,
    skipCount = false,
  ) => {
    setLoading(true)
    try {
      const whereValue = targetWhere === undefined ? where : targetWhere
      const data = buildTableDataSql(table.name, {
        limit: targetPageSize,
        offset: targetPage * targetPageSize,
        ...(targetSort.length > 0 ? { sort: targetSort } : {}),
        ...(whereValue ? { whereSql: whereValue.sql, whereParams: whereValue.params } : {}),
      }, table.columns.map((column) => column.name))
      setCurrentSql(data.sql)
      setLastRefreshAt(new Date())

      let result: QueryResult
      let rowid = -1
      if (useRowid) {
        const withRowid = data.sql.replace(/^SELECT \*/i, 'SELECT rowid AS "__inkstone_rowid__", *')
        try {
          result = await driver.query(withRowid, data.params)
          if (result.columns[0] === '__inkstone_rowid__') rowid = 0
        } catch (cause) {
          const message = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase()
          if (!message.includes('rowid')) throw cause
          result = await driver.query(data.sql, data.params)
        }
      } else {
        result = await driver.query(data.sql, data.params)
      }

      const nextColumns = result.columns.length > 0
        ? result.columns.filter((column) => column !== '__inkstone_rowid__')
        : table.columns.map((column) => column.name)
      setColumns(nextColumns)
      setRowids(result.rows.map((row) => (rowid >= 0 ? row[0] : null)))
      setRows(result.rows.map((row) => (rowid >= 0 ? row.slice(1) : row)))
      setPage(targetPage)
      setPageSize(targetPageSize)
      setTruncated(Boolean(result.truncated))
      setDirty(new Map())
      setEditing(null)
      setSelectedRows(new Set())
      setDetailRow(null)

      if (!skipCount) {
        try {
          const count = buildCountSql(table.name, whereValue?.sql, whereValue?.params)
          const countResult = await driver.query(count.sql, count.params)
          const value = countResult.rows[0]?.[0]
          setTotal(typeof value === 'number' ? value : Number(value ?? 0))
        } catch {
          setTotal(null)
        }
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [driver, onError, table, useRowid, where])

  useEffect(() => {
    setSort([])
    void load(0, pageSize, [], where)
  }, [driver, table.name])

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      const next = buildWhere(filters, search, searchColumns)
      setDebouncedSearch(search)
      void load(0, pageSize, sort, next)
    }, 300)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [search])

  const totalPages = total === null ? 0 : Math.max(1, Math.ceil(total / pageSize))
  const goPage = (next: number) => {
    const clamped = Math.max(0, Math.min(next, totalPages - 1))
    if (clamped !== page) void load(clamped, pageSize, sort, where, true)
  }

  const applySort = (next: TableSortRule[]) => {
    setSort(next)
    void load(0, pageSize, next, where)
  }

  const sortBy = (column: string, additive: boolean) => {
    const index = sort.findIndex((rule) => rule.column === column)
    const current = index >= 0 ? sort[index] : undefined
    if (!additive) {
      if (!current) applySort([{ column, dir: 'ASC' }])
      else if (current.dir === 'ASC') applySort([{ column, dir: 'DESC' }])
      else applySort([])
      return
    }
    if (!current) {
      applySort([...sort, { column, dir: 'ASC' }])
      return
    }
    if (current.dir === 'ASC') {
      applySort(sort.map((rule) => rule.column === column ? { column, dir: 'DESC' } : rule))
      return
    }
    applySort(sort.filter((rule) => rule.column !== column))
  }

  const sortOne = (column: string, dir: 'ASC' | 'DESC') => {
    applySort([{ column, dir }])
  }

  const keyFor = (rowIndex: number) => rowKeyOf(
    rows[rowIndex] ?? [],
    columns,
    pkColumns,
    rowids[rowIndex],
  )

  const setCellDirty = (row: number, column: number, value: unknown) => {
    setDirty((current) => {
      const next = new Map(current)
      const cells = new Map(next.get(row) ?? [])
      cells.set(column, value === '' ? null : value)
      next.set(row, cells)
      return next
    })
  }

  const setCellDirtyRaw = (row: number, column: number, value: unknown) => {
    setDirty((current) => {
      const next = new Map(current)
      const cells = new Map(next.get(row) ?? [])
      cells.set(column, value)
      next.set(row, cells)
      return next
    })
  }

  const clearCellDirty = (row: number, column: number) => {
    setDirty((current) => {
      const next = new Map(current)
      const cells = next.get(row)
      if (!cells) return current
      const copy = new Map(cells)
      copy.delete(column)
      if (copy.size === 0) next.delete(row)
      else next.set(row, copy)
      return next
    })
  }

  const typeByName = useMemo(() => new Map(table.columns.map((column) => [column.name, column.type])), [table.columns])
  const kindAt = (column: number) => temporalKind(typeByName.get(columns[column] ?? ''))
  const editInputType = (column: number) => {
    const kind = kindAt(column)
    return kind === 'datetime' ? 'datetime-local' as const : kind ?? undefined
  }

  const startEdit = (row: number, column: number) => {
    if (!editable) return
    const key = keyFor(row)
    if (key.kind === 'none') return
    const value = rows[row]?.[column]
    if (isBlobValue(value)) return
    const kind = kindAt(column)
    const text = value === null || value === undefined ? '' : String(value)
    setEditing({ row, col: column })
    setEditValue(kind ? toTemporalInput(text, kind) : text)
  }

  const commitEdit = () => {
    if (!editing) return
    const kind = kindAt(editing.col)
    setCellDirty(editing.row, editing.col, kind ? fromTemporalInput(editValue, kind) : editValue)
    setEditing(null)
  }

  const dirtyCount = useMemo(() => {
    let count = 0
    for (const cells of dirty.values()) count += cells.size
    return count
  }, [dirty])

  const commitChanges = async () => {
    if (!(await allowed())) return
    if (dirtyCount === 0) return
    let done = 0
    for (const [rowIndex, cells] of dirty) {
      const key = keyFor(rowIndex)
      if (key.kind === 'none') continue
      const changes = [...cells].map(([column, value]) => [columns[column] ?? '', value] as const).filter(([column]) => column)
      const statement = buildUpdate(table.name, key, changes)
      if (!statement) continue
      try {
        await driver.query(statement.sql, statement.params)
        done++
      } catch (cause) {
        onError(t('development.database.table.update_failed', {
          n: done + 1,
          message: cause instanceof Error ? cause.message : String(cause),
        }))
        break
      }
    }
    if (done > 0) void load(page, pageSize, sort, where)
  }

  const deleteRows = async (targets: Set<number>) => {
    if (targets.size === 0) return
    if (!(await allowed())) return
    const okToDelete = await confirm({
      title: t('development.database.table.delete_title', { count: targets.size }),
      description: t('development.database.table.delete_description'),
      confirmLabel: t('development.database.table.delete'),
      tone: 'danger',
    })
    if (!okToDelete) return
    let done = 0
    for (const rowIndex of [...targets].sort((left, right) => right - left)) {
      const statement = buildDelete(table.name, keyFor(rowIndex))
      if (!statement) continue
      try {
        await driver.query(statement.sql, statement.params)
        done++
      } catch (cause) {
        onError(t('development.database.table.delete_failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        break
      }
    }
    if (done > 0) void load(page, pageSize, sort, where)
  }

  const deleteSelected = async () => {
    await deleteRows(selectedRows)
  }

  const openInsert = (prefill?: Record<string, unknown>) => {
    const values: Record<string, string> = {}
    const nulls = new Set<string>()
    if (prefill) {
      for (const column of table.columns) {
        if (!(column.name in prefill)) continue
        const value = prefill[column.name]
        values[column.name] = value === null || value === undefined ? '' : String(value)
        if (value === null) nulls.add(column.name)
      }
    }
    setInsertValues(values)
    setInsertNulls(nulls)
    setInsertOpen(true)
  }

  const duplicateRow = (rowIndex: number, withKeys: boolean) => {
    const prefill: Record<string, unknown> = {}
    columns.forEach((column, index) => {
      if (!withKeys && pkColumns.includes(column)) return
      prefill[column] = rows[rowIndex]?.[index] ?? null
    })
    openInsert(prefill)
  }

  const allowed = async () => (ensureWritable ? await ensureWritable() : true)

  const submitInsert = async () => {
    if (!(await allowed())) return
    const entries = table.columns
      .filter((column) => insertNulls.has(column.name) || column.name in insertValues)
      .map((column) => [
        column.name,
        insertNulls.has(column.name) || insertValues[column.name] === '' ? null : insertValues[column.name],
      ] as const)
    const statement = buildInsert(table.name, entries)
    if (!statement) return
    const count = Math.max(1, Math.min(100, Math.trunc(Number(insertCount)) || 1))
    try {
      for (let index = 0; index < count; index++) {
        await driver.query(statement.sql, statement.params)
      }
      setInsertOpen(false)
      setInsertCount('1')
      void load(page, pageSize, sort, where)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const bulkSet = async (column: string) => {
    if (!(await allowed())) return
    const targets = [...selectedRows].filter((index) => rows[index])
    if (targets.length === 0 || !column) return
    const current = rows[targets[0]!]?.[columns.indexOf(column)]
    const value = await prompt({
      title: t('development.database.table.bulk_title', { column, count: targets.length }),
      description: t('development.database.table.bulk_hint', { count: targets.length }),
      ...(current === null || current === undefined ? {} : { defaultValue: String(current) }),
    })
    if (value === null) return
    let done = 0
    for (const rowIndex of targets) {
      const key = keyFor(rowIndex)
      if (key.kind === 'none') continue
      const statement = buildUpdate(table.name, key, [[column, value === '' ? null : value]])
      if (!statement) continue
      try {
        await driver.query(statement.sql, statement.params)
        done += 1
      } catch (cause) {
        onError(t('development.database.table.bulk_partial', { done, total: targets.length }) + ' — ' + (cause instanceof Error ? cause.message : String(cause)))
        void load(page, pageSize, sort, where)
        return
      }
    }
    useUi.getState().toast({ title: t('development.database.table.bulk_done', { count: done }), tone: 'success' })
    setSelectedRows(new Set())
    void load(page, pageSize, sort, where)
  }

  const refreshRef = useRef<() => void>(() => {})
  refreshRef.current = () => {
    if (!loading) void load(page, pageSize, sort, where)
  }
  useEffect(() => {
    if (refreshSeconds <= 0) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshRef.current()
    }, refreshSeconds * 1000)
    return () => clearInterval(timer)
  }, [refreshSeconds])

  const saveDetail = async (values: Record<string, string>) => {
    if (!(await allowed())) return
    if (detailRow === null) return
    const key = keyFor(detailRow)
    if (key.kind === 'none') {
      onError(t('development.database.table.row_readonly'))
      return
    }
    const changes = columns
      .filter((column) => !readOnlyColumns.has(column))
      .map((column) => [column, values[column] === '' ? null : values[column]] as const)
    const statement = buildUpdate(table.name, key, changes)
    if (!statement) return
    try {
      await driver.query(statement.sql, statement.params)
      void load(page, pageSize, sort, where)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const copy = async (text: string) => {
    const ok = await copyText(text)
    useUi.getState().toast({
      title: ok ? t('development.database.common.copied') : t('development.database.common.copy_failed'),
      tone: ok ? 'success' : 'danger',
    })
  }

  const addQuickFilter = (column: string, op: FilterOperator, value: string) => {
    if (!column) return
    const next = [...filters, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      column,
      op,
      value: op === 'isNull' || op === 'notNull' ? '' : value,
    }]
    setFilters(next)
    void load(0, pageSize, sort, buildWhere(next, debouncedSearch, searchColumns))
  }

  const pickDistinct = (value: string | null) => {
    if (!distinctColumn) return
    const next = [...filters, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      column: distinctColumn,
      op: (value === null ? 'isNull' : 'equals') as FilterOperator,
      value: value ?? '',
    }]
    setFilters(next)
    void load(0, pageSize, sort, buildWhere(next, debouncedSearch, searchColumns))
    setDistinctColumn(null)
  }

  const contextItems = contextMenu ? [
    {
      id: 'null',
      label: t('development.database.table.set_null'),
      onSelect: () => { setCellDirty(contextMenu.row, contextMenu.col, null); setContextMenu(null) },
    },
    {
      id: 'empty',
      label: t('development.database.table.set_empty_string'),
      onSelect: () => { setCellDirtyRaw(contextMenu.row, contextMenu.col, ''); setContextMenu(null) },
    },
    {
      id: 'default',
      label: t('development.database.table.restore_default'),
      onSelect: () => { clearCellDirty(contextMenu.row, contextMenu.col); setContextMenu(null) },
    },
    {
      id: 'timestamp',
      label: t('development.database.table.unix_timestamp'),
      onSelect: () => { setCellDirty(contextMenu.row, contextMenu.col, Math.floor(Date.now() / 1000).toString()); setContextMenu(null) },
    },
    {
      id: 'uuid',
      label: 'UUID',
      onSelect: () => { setCellDirty(contextMenu.row, contextMenu.col, crypto.randomUUID()); setContextMenu(null) },
    },
    {
      id: 'text',
      label: t('development.database.table.text_editor'),
      icon: <FileText size={13} />,
      separatorBefore: true,
      onSelect: () => {
        setCellEditor({ row: contextMenu.row, col: contextMenu.col, value: String(rows[contextMenu.row]?.[contextMenu.col] ?? ''), format: 'text' })
        setContextMenu(null)
      },
    },
    {
      id: 'json',
      label: t('development.database.table.json_editor'),
      icon: <FileJson size={13} />,
      onSelect: () => {
        setCellEditor({ row: contextMenu.row, col: contextMenu.col, value: String(rows[contextMenu.row]?.[contextMenu.col] ?? ''), format: 'json' })
        setContextMenu(null)
      },
    },
    {
      id: 'transform',
      label: t('development.database.grid.transform_open'),
      icon: <Wand2 size={13} />,
      onSelect: () => {
        setTransformCell({ row: contextMenu.row, col: contextMenu.col })
        setContextMenu(null)
      },
    },
    {
      id: 'copy-cell',
      label: t('development.database.table.copy_cell'),
      onSelect: () => {
        const value = rows[contextMenu.row]?.[contextMenu.col]
        void copy(value === null || value === undefined ? '' : String(value))
        setContextMenu(null)
      },
    },
    {
      id: 'copy-columns',
      label: t('development.database.table.copy_columns'),
      onSelect: () => {
        void copy(columns.join(', '))
        setContextMenu(null)
      },
    },
    {
      id: 'paste',
      label: t('development.database.table.paste'),
      onSelect: () => {
        void (async () => {
          try {
            const text = await navigator.clipboard.readText()
            const lines = text.split(/\r?\n/)
            setDirty((current) => {
              const next = new Map(current)
              for (let rowOffset = 0; rowOffset < lines.length; rowOffset++) {
                const targetRow = contextMenu.row + rowOffset
                if (targetRow >= rows.length) break
                const cells = lines[rowOffset]!.split('\t')
                const map = new Map(next.get(targetRow) ?? [])
                for (let columnOffset = 0; columnOffset < cells.length; columnOffset++) {
                  const targetColumn = contextMenu.col + columnOffset
                  if (targetColumn >= columns.length) break
                  const value = cells[columnOffset]!
                  map.set(targetColumn, value === '' || value.toLowerCase() === 'null' ? null : value)
                }
                next.set(targetRow, map)
              }
              return next
            })
          } catch (cause) {
            onError(cause instanceof Error ? cause.message : String(cause))
          }
          setContextMenu(null)
        })()
      },
    },
    {
      id: 'filter-equals',
      label: t('development.database.table.filter_equals'),
      icon: <Filter size={13} />,
      separatorBefore: true,
      onSelect: () => {
        const value = rows[contextMenu.row]?.[contextMenu.col]
        addQuickFilter(columns[contextMenu.col] ?? '', 'equals', value === null || value === undefined ? '' : String(value))
        setContextMenu(null)
      },
    },
    {
      id: 'filter-contains',
      label: t('development.database.table.filter_contains'),
      onSelect: () => {
        const value = rows[contextMenu.row]?.[contextMenu.col]
        addQuickFilter(columns[contextMenu.col] ?? '', 'contains', value === null || value === undefined ? '' : String(value))
        setContextMenu(null)
      },
    },
    {
      id: 'filter-null',
      label: t('development.database.table.filter_is_null'),
      onSelect: () => { addQuickFilter(columns[contextMenu.col] ?? '', 'isNull', ''); setContextMenu(null) },
    },
    {
      id: 'copy-row-tsv',
      label: t('development.database.table.copy_row_tsv'),
      separatorBefore: true,
      onSelect: () => {
        const row = rows[contextMenu.row] ?? []
        void copy(`${columns.join('\t')}\n${columns.map((_, index) => String(row[index] ?? '')).join('\t')}`)
        setContextMenu(null)
      },
    },
    {
      id: 'copy-row-json',
      label: t('development.database.table.copy_row_json'),
      onSelect: () => {
        const row = rows[contextMenu.row] ?? []
        void copy(JSON.stringify(Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null])), null, 2))
        setContextMenu(null)
      },
    },
    {
      id: 'copy-row-sql',
      label: t('development.database.table.copy_row_sql'),
      onSelect: () => {
        const row = rows[contextMenu.row] ?? []
        void copy(`INSERT INTO ${quoteIdent(table.name)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map((_, index) => sqlLiteral(row[index])).join(', ')});`)
        setContextMenu(null)
      },
    },
    {
      id: 'insert',
      label: t('development.database.table.insert_row'),
      icon: <Plus size={13} />,
      separatorBefore: true,
      onSelect: () => { openInsert(); setContextMenu(null) },
    },
    {
      id: 'duplicate',
      label: t('development.database.table.duplicate_no_pk'),
      onSelect: () => { duplicateRow(contextMenu.row, false); setContextMenu(null) },
    },
    {
      id: 'duplicate-pk',
      label: t('development.database.table.duplicate_with_pk'),
      onSelect: () => { duplicateRow(contextMenu.row, true); setContextMenu(null) },
    },
    ...(selectedRows.size > 1 ? [{
      id: 'bulk-set',
      label: t('development.database.table.bulk_set', { count: selectedRows.size }),
      separatorBefore: true,
      onSelect: () => {
        const column = columns[contextMenu.col]
        setContextMenu(null)
        if (column) void bulkSet(column)
      },
    }] : []),
    {
      id: 'delete',
      label: t('development.database.table.delete_selected'),
      tone: 'danger' as const,
      separatorBefore: true,
      onSelect: () => {
        const targets = selectedRows.size > 0 ? selectedRows : new Set([contextMenu.row])
        setContextMenu(null)
        void deleteRows(targets)
      },
    },
  ] : []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
        <TooltipIcon label={t('development.database.table.refresh')} onClick={() => void load(page, pageSize, sort, where)}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
        </TooltipIcon>
        <Button variant="secondary" size="sm" onClick={() => setFilterOpen(true)}>
          <Filter size={14} className={filters.length > 0 ? 'text-[var(--accent)]' : undefined} />
          {t('development.database.table.filter')}
          {filters.length > 0 && <span className="rounded bg-[var(--accent-soft)] px-1 text-[length:var(--text-10)] text-[var(--accent)]">{filters.length}</span>}
        </Button>
        {editable && (
          <>
            <Button size="sm" onClick={() => openInsert()}><Plus size={14} />{t('development.database.table.insert_row')}</Button>
            <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
              <Upload size={14} />
              {t('development.database.import.button')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setGenerateOpen(true)}>
              <Wand2 size={14} />
              {t('development.database.generate.button')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void deleteSelected()} disabled={selectedRows.size === 0}>
              <Trash2 size={14} />
              {t('development.database.table.delete')}
              {selectedRows.size > 0 ? ` ${selectedRows.size}` : ''}
            </Button>
            {dirtyCount > 0 && (
              <>
                <Button size="sm" onClick={() => void commitChanges()}>
                  <Save size={14} />
                  {t('development.database.table.commit', { count: dirtyCount })}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setDirty(new Map()); setEditing(null) }}>
                  <Undo2 size={14} />
                  {t('development.database.table.discard')}
                </Button>
              </>
            )}
          </>
        )}
        <ExportPanel columns={visibleColumns} rows={visible.rows} tableName={table.name} selectedRows={selectedRows} truncated={truncated} />
        <AggregatePanel columns={visibleColumns} rows={visible.rows} selectedRows={selectedRows} />
        <Button variant="secondary" size="sm" onClick={() => setSqlOpen((value) => !value)} aria-pressed={sqlOpen}>
          <Code2 size={14} />
          {t('development.database.grid.show_sql')}
        </Button>
        <Button ref={columnsAnchor} variant="secondary" size="sm" onClick={() => setColumnsOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={columnsOpen}>
          <Columns3 size={14} />
          {t('development.database.table.columns')}
          {hiddenColumns.size > 0 && <span className="rounded bg-[var(--accent-soft)] px-1 text-[length:var(--text-10)] text-[var(--accent)]">{hiddenColumns.size}</span>}
        </Button>
        {refreshSeconds > 0 && lastRefreshAt && (
          <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
            {t('development.database.table.refreshed_at', { time: lastRefreshAt.toLocaleTimeString(undefined, { hour12: false }) })}
          </span>
        )}
        <SelectMenu
          label={t('development.database.table.auto_refresh')}
          value={String(refreshSeconds)}
          options={[0, 5, 15, 30, 60].map((seconds) => ({ value: String(seconds), label: seconds === 0 ? t('development.database.table.auto_refresh_off') : t('development.database.table.refresh_every', { seconds }) }))}
          onChange={(value) => setRefreshSeconds(Number(value))}
          className="w-28"
          size="sm"
        />
        <div className="flex-1" />
        <div className="flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {truncated && (
            <span className="shrink-0 rounded bg-[var(--warning-soft)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--warning)]">
              {t('development.database.query.truncated', { rows: MAX_QUERY_ROWS, size: MAX_QUERY_BYTES / (1024 * 1024) })}
            </span>
          )}
          <span className="hidden sm:inline">{total === null ? t('development.database.table.total_unknown') : t('development.database.table.total_rows', { count: total })}</span>
          <SelectMenu
            label={t('development.database.table.page_size')}
            value={String(pageSize)}
            options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size}/${t('development.database.table.page')}` }))}
            onChange={(value) => void load(0, Number(value), sort, where)}
            className="w-24"
            size="sm"
          />
          <IconButton label={t('development.database.table.prev_page')} size="sm" disabled={page <= 0 || loading} onClick={() => goPage(page - 1)}>
            <ChevronLeft size={14} />
          </IconButton>
          <span className="tabular-nums">{totalPages > 0 ? `${page + 1}/${totalPages}` : '0/0'}</span>
          <IconButton label={t('development.database.table.next_page')} size="sm" disabled={page >= totalPages - 1 || loading} onClick={() => goPage(page + 1)}>
            <ChevronRight size={14} />
          </IconButton>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return
              if (event.key === 'Enter') {
                if (searchTimer.current) clearTimeout(searchTimer.current)
                setDebouncedSearch(search)
                void load(0, pageSize, sort, buildWhere(filters, search, searchColumns))
              }
              if (event.key === 'Escape') setSearch('')
            }}
            placeholder={t('development.database.table.search_placeholder', { table: table.name })}
            className="h-8 pl-8 pr-8 text-[length:var(--text-11)]"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label={t('development.database.common.clear')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-tertiary)]">
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {filters.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1">
          {filters.map((filter) => (
            <span key={filter.id} className="flex items-center gap-1 rounded bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)]">
              <span className="font-medium">{filter.column}</span>
              <span className="opacity-70">{t(OPERATORS.find((entry) => entry.value === filter.op)?.labelKey as MessageKey)}</span>
              <span className="text-[var(--text-tertiary)]">{filter.op === 'isNull' || filter.op === 'notNull' ? '' : filter.value}</span>
              <button type="button" onClick={() => {
                const next = filters.filter((entry) => entry.id !== filter.id)
                setFilters(next)
                void load(0, pageSize, sort, buildWhere(next, debouncedSearch, searchColumns))
              }} aria-label={t('development.database.table.remove_filter')} className="rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--danger)]">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {editable ? (
          <ResultGrid
            columns={columns}
            rows={rows}
            sort={sort}
            onSort={sortBy}
            onSortDir={sortOne}
            onDistinctColumn={setDistinctColumn}
            hiddenColumns={hiddenColumns}
            onToggleColumn={(index) => setHiddenColumns((current) => {
              const next = new Set(current)
              if (next.has(index)) next.delete(index)
              else next.add(index)
              return next
            })}
            selectedRows={selectedRows}
            onSelectionChange={setSelectedRows}
            selectedRow={detailRow}
            onRowClick={(index) => setDetailRow(index)}
            rowKeyHint={t('development.database.table.double_click_edit')}
            editInputType={editInputType}
            editable
            editing={editing}
            onEdit={startEdit}
            editValue={editValue}
            onEditValueChange={setEditValue}
            onEditCommit={commitEdit}
            onEditCancel={() => setEditing(null)}
            onCellContextMenu={(row, col, x, y) => setContextMenu({ row, col, x, y })}
          />
        ) : (
          <ResultGrid
            columns={columns}
            rows={rows}
            sort={sort}
            onSort={sortBy}
            onDistinctColumn={setDistinctColumn}
            hiddenColumns={hiddenColumns}
            onToggleColumn={(index) => setHiddenColumns((current) => {
              const next = new Set(current)
              if (next.has(index)) next.delete(index)
              else next.add(index)
              return next
            })}
            selectedRows={selectedRows}
            onSelectionChange={setSelectedRows}
            selectedRow={detailRow}
            onRowClick={(index) => setDetailRow(index)}
            rowKeyHint={t('development.database.table.readonly_hint')}
          />
        )}
        {detailRow !== null && rows[detailRow] && (
          <div className="absolute inset-y-0 right-0 z-20 w-[85vw] max-w-sm">
            <RowDetailPanel
              columns={columns}
              row={rows[detailRow]!}
              title={t('development.database.table.row_detail', { table: table.name, row: detailRow + 1 })}
              editable={editable}
              readOnlyColumns={readOnlyColumns}
              onSave={(values) => saveDetail(values)}
              onClose={() => setDetailRow(null)}
            />
          </div>
        )}
      </div>

      <ToolbarPanel open={columnsOpen} onClose={() => setColumnsOpen(false)} anchor={columnsAnchor} label={t('development.database.table.columns')} width={260}>
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('development.database.table.visible_columns', { shown: columns.length - hiddenColumns.size, total: columns.length })}</span>
          {hiddenColumns.size > 0 && <Button variant="ghost" size="sm" onClick={() => setHiddenColumns(new Set())}>{t('development.database.table.show_all')}</Button>}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {columns.map((column, index) => (
            <label key={`${column}-${index}`} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[length:var(--text-12)] hover:bg-[var(--bg-hover)]">
              <Checkbox
                checked={!hiddenColumns.has(index)}
                ariaLabel={column}
                onChange={() => setHiddenColumns((current) => {
                  const next = new Set(current)
                  if (next.has(index)) next.delete(index)
                  else next.add(index)
                  return next
                })}
              />
              <span className="truncate">{column}</span>
            </label>
          ))}
        </div>
      </ToolbarPanel>

      <Menu
        anchor={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : { x: 0, y: 0 }}
        open={contextMenu !== null}
        onClose={() => setContextMenu(null)}
        label={t('development.database.table.cell_actions')}
        items={contextItems}
        width={230}
      />

      <Modal
        open={cellEditor !== null}
        onClose={() => setCellEditor(null)}
        title={cellEditor?.format === 'json' ? t('development.database.table.json_editor') : t('development.database.table.text_editor')}
        width={640}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCellEditor(null)}>{t('development.database.common.cancel')}</Button>
            <Button size="sm" onClick={() => { if (cellEditor) { setCellDirty(cellEditor.row, cellEditor.col, cellEditor.value); setCellEditor(null) } }}>{t('development.database.table.save_to_cell')}</Button>
          </>
        }
      >
        <textarea
          value={cellEditor?.value ?? ''}
          onChange={(event) => setCellEditor((current) => current ? { ...current, value: event.target.value } : current)}
          spellCheck={false}
          className="h-[50vh] w-full resize-none rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] p-3 font-mono text-[length:var(--text-12)] text-[var(--text-primary)] outline-none"
        />
      </Modal>

      <Modal
        open={insertOpen}
        onClose={() => setInsertOpen(false)}
        title={t('development.database.table.insert_title', { table: table.name })}
        width={520}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setInsertOpen(false)}>{t('development.database.common.cancel')}</Button>
            <Button size="sm" onClick={() => void submitInsert()}>{t('development.database.table.insert')}</Button>
          </>
        }
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('development.database.table.insert_count')}</span>
          <Input value={insertCount} onChange={(event) => setInsertCount(event.target.value)} className="h-8 w-20 text-[length:var(--text-12)]" inputMode="numeric" aria-label={t('development.database.table.insert_count')} />
          <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.table.insert_count_hint')}</span>
        </div>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {table.columns.map((column) => (
            <div key={column.name} className="grid grid-cols-[120px_1fr_auto] items-center gap-2">
              <span className="truncate text-[length:var(--text-11)] text-[var(--text-secondary)]" title={column.name}>
                {column.name}{column.pk ? ' *' : ''}
              </span>
              <Input
                value={insertNulls.has(column.name) ? '' : (insertValues[column.name] ?? '')}
                disabled={insertNulls.has(column.name)}
                aria-label={column.name}
                placeholder={column.default ? t('development.database.table.default_prefix', { value: column.default }) : column.type}
                onChange={(event) => setInsertValues((current) => ({ ...current, [column.name]: event.target.value }))}
                className="h-8 text-[length:var(--text-12)]"
              />
              <Checkbox
                checked={insertNulls.has(column.name)}
                ariaLabel={t('development.database.table.null_for', { column: column.name })}
                onChange={(next) => setInsertNulls((current) => {
                  const set = new Set(current)
                  if (next) set.add(column.name)
                  else set.delete(column.name)
                  return set
                })}
                label={t('development.database.table.null')}
              />
            </div>
          ))}
        </div>
      </Modal>

      {sqlOpen && (
        <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
          <pre className="max-h-32 overflow-auto font-mono text-[length:var(--text-11)] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-all">{currentSql || '—'}</pre>
        </div>
      )}

      <DataGenerateDialog
        open={generateOpen}
        table={table}
        driver={driver}
        {...(ensureWritable ? { ensureWritable } : {})}
        onClose={() => setGenerateOpen(false)}
        onGenerated={() => void load(page, pageSize, sort, where)}
        onError={onError}
      />

      <CsvImportDialog
        open={importOpen}
        table={table}
        driver={driver}
        {...(ensureWritable ? { ensureWritable } : {})}
        onClose={() => setImportOpen(false)}
        onImported={() => void load(page, pageSize, sort, where)}
        {...(onSchemaChanged ? { onSchemaChanged } : {})}
        onError={onError}
      />

      <CellTransformDialog
        open={transformCell !== null}
        column={transformCell ? columns[transformCell.col] ?? '' : ''}
        value={transformCell ? rows[transformCell.row]?.[transformCell.col] : null}
        onClose={() => setTransformCell(null)}
      />

      <DistinctValuePanel
        open={distinctColumn !== null}
        table={table.name}
        column={distinctColumn ?? columns[0] ?? ''}
        knownColumns={table.columns.map((column) => column.name)}
        driver={driver}
        onPick={(value) => pickDistinct(value)}
        onClose={() => setDistinctColumn(null)}
      />

      <FilterDialog
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        columns={table.columns.map((column) => column.name)}
        filters={filters}
        onChange={(next) => {
          setFilters(next)
          void load(0, pageSize, sort, buildWhere(next, debouncedSearch, searchColumns))
        }}
      />
    </div>
  )
}

function TooltipIcon({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <IconButton label={label} size="sm" onClick={onClick}>
      {children}
    </IconButton>
  )
}

function FilterDialog({
  open,
  onClose,
  columns,
  filters,
  onChange,
}: {
  open: boolean
  onClose: () => void
  columns: string[]
  filters: FilterCondition[]
  onChange: (filters: FilterCondition[]) => void
}) {
  const [column, setColumn] = useState(columns[0] ?? '')
  const [op, setOp] = useState<FilterOperator>('contains')
  const [value, setValue] = useState('')

  useEffect(() => {
    if (open) {
      setColumn(columns[0] ?? '')
      setOp('contains')
      setValue('')
    }
  }, [open, columns])

  const add = () => {
    if (!column) return
    onChange([...filters, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      column,
      op,
      value: op === 'isNull' || op === 'notNull' ? '' : value,
    }])
    setValue('')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.database.table.filter_conditions')}
      width={460}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" onClick={add} disabled={!column}>{t('development.database.table.add_condition')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('development.database.table.column')}>
            <SelectMenu label={t('development.database.table.column')} value={column} options={columns.map((name) => ({ value: name, label: name }))} onChange={setColumn} />
          </Field>
          <Field label={t('development.database.table.condition')}>
            <SelectMenu label={t('development.database.table.condition')} value={op} options={OPERATORS.map((entry) => ({ value: entry.value, label: t(entry.labelKey as MessageKey) }))} onChange={setOp} />
          </Field>
        </div>
        {op !== 'isNull' && op !== 'notNull' && (
          <Field label={t('development.database.table.value')}>
            <Input value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') add() }} />
          </Field>
        )}
        {filters.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {filters.map((filter) => (
              <span key={filter.id} className="flex items-center gap-1 rounded bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)]">
                {filter.column} {t(OPERATORS.find((entry) => entry.value === filter.op)?.labelKey as MessageKey)} {filter.value}
                <button type="button" onClick={() => onChange(filters.filter((entry) => entry.id !== filter.id))} aria-label={t('development.database.table.remove_filter')}>
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
