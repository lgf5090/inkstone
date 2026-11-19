import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Copy, GitBranch, KeyRound, Link2, Pencil, Table2, Trash2 } from 'lucide-react'
import type { ParsedTable, SchemaModel } from '@shared/development/database/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { isImeComposing } from '../../../lib/ime'
import { useUi } from '../../../store/ui'
import { Button } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { Menu, Modal, type MenuItem, confirm } from '../../../components/overlay'
import {
  ERD_NODE_HEADER_HEIGHT,
  ERD_NODE_ROW_HEIGHT,
  buildErdLayout,
  erdNodeHeight,
} from './flow-layout'
import {
  clampPosition,
  createDiagramTable,
  diagramSignature,
  diagramTablesToParsedTables,
  duplicateTable,
  findTable,
  nextTablePosition,
  relationshipLabel,
  renameTableInDraft,
  schemaToDiagram,
  syncRelationships,
  type DiagramDraft,
  type DiagramPositions,
  type DiagramTable,
} from './diagram'
import { makeDiagramId } from './constraints'
import {
  createDiagramHistory,
  type DiagramHistory,
} from './diagram-history'
import { loadDiagramPositions, saveDiagramPositions } from './diagram-layout'
import { downloadFlowPng, downloadFlowSvg } from './flow-export'
import { downloadTextFile } from './export-utils'
import { schemaToMarkdown, schemaToMermaid } from './export-doc'
import { documentLabels } from './export-doc-labels'
import { buildDiagramDdl, type DiagramDdlPlan } from './diagram-ddl'
import { validateDiagram, type DiagramIssue } from './diagram-issues'
import { SvgFlow, type FlowExportNode, type Viewport } from './SvgFlow'
import { ErdToolbar } from './ErdToolbar'
import { RelationshipDialog, type RelationshipInput } from './RelationshipDialog'
import { TableCreateDialog, type CreateTableColumn } from './TableCreateDialog'
import { DdlPreviewDialog } from './DdlPreviewDialog'

export interface ErdViewProps {
  tables: ParsedTable[]
  schema?: SchemaModel
  className?: string
  editable?: boolean
  connectionKey?: string
  ensureWritable?: () => Promise<boolean>
  onApplyDdl?: (statements: string[]) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  remote?: boolean
  onOpenData?: (table: string) => void
  onOpenSchema?: (table: string) => void
}

interface ErdMenuState {
  table: string
  x: number
  y: number
}

interface RelationDrag {
  sourceTable: string
  sourceColumn: string
  startClientX: number
  startClientY: number
  screenX: number
  screenY: number
  currentX: number
  currentY: number
  moved: boolean
}

const EMPTY_SCHEMA: SchemaModel = { tables: [], views: [], triggers: [], indexes: [] }

function uniqueTableName(draft: DiagramDraft, base: string): string {
  const taken = new Set(draft.tables.map((table) => table.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let index = 2
  while (taken.has(`${base}_${index}`.toLowerCase())) index += 1
  return `${base}_${index}`
}

function tableSignature(schema: SchemaModel): string {
  return JSON.stringify([
    schema.tables.map((table) => [table.name, table.sql, table.columns.length]),
    schema.indexes.map((index) => [index.name, index.sql, index.table]),
    schema.views.map((view) => view.sql),
    schema.triggers.map((trigger) => trigger.sql),
  ])
}

function notify(message: string, tone: 'success' | 'danger' | 'warning'): void {
  useUi.getState().toast({ title: message, tone })
}

export function ErdView({
  tables,
  schema,
  className,
  editable = false,
  connectionKey = 'default',
  ensureWritable,
  onApplyDdl,
  onDirtyChange,
  remote = false,
  onOpenData,
  onOpenSchema,
}: ErdViewProps) {
  const fullSchema = useMemo<SchemaModel>(() => schema ?? withTables(tables), [schema, tables])
  const canEdit = editable && Boolean(onApplyDdl)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [viewNodes, setViewNodes] = useState(() => buildErdLayout(fullSchema.tables).nodes)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const [menu, setMenu] = useState<ErdMenuState | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [rename, setRename] = useState<{ tableId: string; value: string } | null>(null)
  const [relationDialog, setRelationDialog] = useState<{ initial: Partial<RelationshipInput> } | null>(null)
  const [preview, setPreview] = useState<DiagramDdlPlan | null>(null)
  const [saving, setSaving] = useState(false)
  const [schemaChanged, setSchemaChanged] = useState(false)
  const [relationDrag, setRelationDrag] = useState<RelationDrag | null>(null)
  const historyRef = useRef<DiagramHistory<DiagramDraft> | null>(null)
  const [, setHistoryTick] = useState(0)
  const relationDragRef = useRef<RelationDrag | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const lastSchemaKey = useRef(tableSignature(fullSchema))
  const [baseline, setBaseline] = useState('')

  const bump = useCallback(() => setHistoryTick((tick) => tick + 1), [])
  const draft = mode === 'edit' ? historyRef.current?.present ?? null : null
  const dirty = Boolean(draft && baseline && diagramSignature(draft) !== baseline)
  const issues = useMemo<DiagramIssue[]>(() => (draft ? validateDiagram(draft) : []), [draft, mode, baseline])
  const positions = useMemo<DiagramPositions>(() => {
    if (!draft) return {}
    return Object.fromEntries(draft.tables.map((table) => [table.name, { x: table.x, y: table.y }]))
  }, [draft])

  useEffect(() => {
    relationDragRef.current = relationDrag
  }, [relationDrag])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  useEffect(() => {
    if (!draft) return
    const timer = window.setTimeout(() => saveDiagramPositions(connectionKey, positions), 300)
    return () => window.clearTimeout(timer)
  }, [connectionKey, positions, draft])

  useEffect(() => {
    if (!relationDrag) return
    const onMove = (event: PointerEvent) => {
      const current = relationDragRef.current
      const rect = wrapperRef.current?.getBoundingClientRect()
      if (!current || !rect) return
      const currentX = event.clientX - rect.left
      const currentY = event.clientY - rect.top
      setRelationDrag({
        ...current,
        currentX,
        currentY,
        moved: current.moved
          || Math.abs(event.clientX - current.startClientX) > 3
          || Math.abs(event.clientY - current.startClientY) > 3,
      })
    }
    const onUp = (event: PointerEvent) => {
      const current = relationDragRef.current
      setRelationDrag(null)
      if (!current) return
      if (!current.moved) {
        setRelationDialog({ initial: { startTableId: current.sourceTable, startColumns: [current.sourceColumn] } })
        return
      }
      if (typeof document.elementFromPoint !== 'function') return
      const target = document.elementFromPoint(event.clientX, event.clientY)
      const column = target instanceof Element ? target.closest('[data-erd-column]') : null
      if (!(column instanceof HTMLElement)) return
      const tableId = column.getAttribute('data-erd-table')
      const columnName = column.getAttribute('data-erd-column')
      if (!tableId || !columnName) return
      if (tableId === current.sourceTable && columnName === current.sourceColumn) return
      setRelationDialog({
        initial: {
          startTableId: current.sourceTable,
          startColumns: [current.sourceColumn],
          endTableId: tableId,
          endColumns: [columnName],
        },
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [relationDrag !== null])

  useEffect(() => {
    if (mode !== 'edit') return
    const nextKey = tableSignature(fullSchema)
    if (lastSchemaKey.current === nextKey) return
    lastSchemaKey.current = nextKey
    if (dirty) {
      setSchemaChanged(true)
      return
    }
    const next = schemaToDiagram(fullSchema, loadDiagramPositions(connectionKey))
    historyRef.current = createDiagramHistory(next)
    setBaseline(diagramSignature(next))
    setSchemaChanged(false)
  }, [connectionKey, dirty, fullSchema, mode, schema])

  const pushDraft = useCallback((next: DiagramDraft, coalesceKey?: string) => {
    const history = historyRef.current
    if (!history) return
    history.push(next, coalesceKey ? { coalesceKey } : undefined)
    bump()
  }, [bump])

  const enterEdit = () => {
    const next = schemaToDiagram(fullSchema, loadDiagramPositions(connectionKey))
    historyRef.current = createDiagramHistory(next)
    setBaseline(diagramSignature(next))
    setMode('edit')
    setSchemaChanged(false)
    setSelectedIds(new Set())
    setSelectedEdgeId(null)
    lastSchemaKey.current = tableSignature(fullSchema)
  }

  const exitEdit = async () => {
    if (dirty) {
      const ok = await confirm({
        title: t('development.database.diagram.discard_title'),
        description: t('development.database.diagram.discard_description'),
        confirmLabel: t('development.database.diagram.exit'),
        tone: 'danger',
      })
      if (!ok) return
    }
    setMode('view')
    setSelectedIds(new Set())
    setSelectedEdgeId(null)
    setPreview(null)
    setRelationDialog(null)
    setRelationDrag(null)
    setRename(null)
    setSchemaChanged(false)
  }

  const reloadFromSchema = () => {
    const next = schemaToDiagram(fullSchema, loadDiagramPositions(connectionKey))
    historyRef.current = createDiagramHistory(next)
    setBaseline(diagramSignature(next))
    setSchemaChanged(false)
    setSelectedIds(new Set())
    setSelectedEdgeId(null)
    lastSchemaKey.current = tableSignature(fullSchema)
  }

  const undo = () => {
    if (!historyRef.current?.undo()) return
    bump()
    setSelectedIds(new Set())
    setSelectedEdgeId(null)
  }

  const redo = () => {
    if (!historyRef.current?.redo()) return
    bump()
    setSelectedIds(new Set())
    setSelectedEdgeId(null)
  }

  const moveNode = useCallback((id: string, x: number, y: number) => {
    if (mode === 'edit' && historyRef.current) {
      const present = historyRef.current.present
      const next = {
        ...present,
        tables: present.tables.map((table) => (
          table.id === id ? { ...table, x: clampPosition(x), y: clampPosition(y) } : table
        )),
      }
      pushDraft(next, `drag:${id}`)
      return
    }
    setViewNodes((previous) => previous.map((node) => (
      node.id === id ? { ...node, x, y } : node
    )))
  }, [mode, pushDraft])

  const startRelationDrag = (tableId: string, columnName: string, event: ReactPointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const present = historyRef.current?.present
    const table = present ? findTable(present, tableId) : null
    if (!table) return
    const index = table.columns.findIndex((column) => column.name === columnName)
    if (index < 0) return
    const worldX = table.x + table.width
    const worldY = table.y + ERD_NODE_HEADER_HEIGHT + index * ERD_NODE_ROW_HEIGHT + ERD_NODE_ROW_HEIGHT / 2
    const screenX = worldX * viewport.zoom + viewport.x
    const screenY = worldY * viewport.zoom + viewport.y
    setRelationDrag({
      sourceTable: tableId,
      sourceColumn: columnName,
      startClientX: event.clientX,
      startClientY: event.clientY,
      screenX,
      screenY,
      currentX: screenX,
      currentY: screenY,
      moved: false,
    })
  }

  const deleteRelation = (constraintId?: string, startTableId?: string) => {
    const present = historyRef.current?.present
    if (!present) return
    let owner = startTableId
    let target = constraintId
    if (!target && selectedEdgeId) {
      const relationship = present.relationships.find((entry) => entry.id === selectedEdgeId)
      owner = relationship?.startTableId
      target = relationship?.constraintId
    }
    if (!owner || !target) return
    const tables = present.tables.map((table) => (
      table.id === owner
        ? { ...table, constraints: table.constraints.filter((constraint) => constraint.id !== target) }
        : table
    ))
    pushDraft(syncRelationships({ tables, renames: present.renames }))
    setSelectedEdgeId(null)
  }

  const deleteTables = async (ids: Set<string>) => {
    const present = historyRef.current?.present
    if (!present || ids.size === 0) return
    const names = [...ids]
      .map((id) => findTable(present, id)?.name ?? id)
      .join(', ')
    const ok = await confirm({
      title: t('development.database.diagram.delete_title', { table: names }),
      description: t('development.database.diagram.delete_description'),
      confirmLabel: t('development.database.diagram.delete_table'),
      tone: 'danger',
    })
    if (!ok) return
    const tables = present.tables
      .filter((table) => !ids.has(table.id))
      .map((table) => ({
        ...table,
        constraints: table.constraints.filter((constraint) => (
          !constraint.refTable || !ids.has(constraint.refTable)
        )),
      }))
    pushDraft(syncRelationships({ tables, renames: present.renames }))
    setSelectedIds(new Set())
    setSelectedEdgeId(null)
  }

  const deleteSelection = () => {
    if (selectedEdgeId) {
      deleteRelation()
      return
    }
    void deleteTables(selectedIds)
  }

  const applyRelationship = (input: RelationshipInput) => {
    const present = historyRef.current?.present
    if (!present) return
    const constraint = {
      id: input.constraintId ?? makeDiagramId('constraint'),
      kind: 'foreign-key' as const,
      ...(input.name ? { name: input.name } : {}),
      raw: '',
      columns: input.startColumns,
      refTable: input.endTableId,
      refColumns: input.endColumns,
      onUpdate: input.onUpdate,
      onDelete: input.onDelete,
    }
    const tables = present.tables.map((table) => {
      const remaining = table.constraints.filter((entry) => entry.id !== constraint.id)
      if (table.id === input.startTableId) {
        return { ...table, constraints: [...remaining, constraint] }
      }
      return { ...table, constraints: remaining }
    })
    const next = syncRelationships({ tables, renames: present.renames })
    pushDraft(next)
    const relationship = next.relationships.find((entry) => entry.constraintId === constraint.id)
    setSelectedEdgeId(relationship?.id ?? null)
    setRelationDialog(null)
  }

  const createTable = async (name: string, columns: CreateTableColumn[]): Promise<boolean> => {
    const present = historyRef.current?.present
    if (!present) return false
    const trimmed = name.trim()
    if (!trimmed) {
      notify(t('development.database.diagram.name_required'), 'warning')
      return false
    }
    if (present.tables.some((table) => table.name.toLowerCase() === trimmed.toLowerCase())) {
      notify(t('development.database.diagram.name_exists'), 'warning')
      return false
    }
    const position = nextTablePosition(present)
    const table: DiagramTable = createDiagramTable(trimmed, columns.map((column) => ({
      name: column.name,
      type: column.type,
      pk: column.pk,
      notNull: column.notNull,
      unique: column.unique,
      default: column.default,
    })), position)
    pushDraft(syncRelationships({ tables: [...present.tables, table], renames: present.renames }))
    setSelectedIds(new Set([trimmed]))
    return true
  }

  const confirmRename = () => {
    const present = historyRef.current?.present
    if (!rename || !present) return
    const value = rename.value.trim()
    if (!value) {
      notify(t('development.database.diagram.name_required'), 'warning')
      return
    }
    if (present.tables.some((table) => table.id !== rename.tableId && table.name.toLowerCase() === value.toLowerCase())) {
      notify(t('development.database.diagram.name_exists'), 'warning')
      return
    }
    pushDraft(renameTableInDraft(present, rename.tableId, value))
    setSelectedIds(new Set([value]))
    setSelectedEdgeId(null)
    setRename(null)
  }

  const duplicate = (tableId: string) => {
    const present = historyRef.current?.present
    const table = present ? findTable(present, tableId) : null
    if (!present || !table) return
    const name = uniqueTableName(present, `${table.name}_copy`)
    const copy = duplicateTable(table, name, nextTablePosition(present))
    pushDraft(syncRelationships({ tables: [...present.tables, copy], renames: present.renames }))
    setSelectedIds(new Set([name]))
  }

  const autoLayout = () => {
    const present = historyRef.current?.present
    if (!present) return
    const layout = buildErdLayout(diagramTablesToParsedTables(present))
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))
    const tables = present.tables.map((table) => {
      const node = byId.get(table.id)
      return node ? { ...table, x: node.x, y: node.y } : table
    })
    pushDraft({ ...present, tables })
  }

  const resetLayout = () => {
    saveDiagramPositions(connectionKey, {})
    autoLayout()
  }

  const save = () => {
    const present = historyRef.current?.present
    if (!present) return
    const plan = buildDiagramDdl(fullSchema, present, {
      views: fullSchema.views,
      triggers: fullSchema.triggers,
      indexes: fullSchema.indexes,
    })
    if (plan.statements.length === 0) {
      notify(t('development.database.diagram.no_changes'), 'warning')
      return
    }
    setPreview(plan)
  }

  const execute = async () => {
    if (!preview || !onApplyDdl) return
    if (ensureWritable && !(await ensureWritable())) return
    setSaving(true)
    try {
      await onApplyDdl(preview.statements)
      const present = historyRef.current?.present
      if (present) {
        historyRef.current?.reset(present)
        setBaseline(diagramSignature(present))
      }
      setPreview(null)
      notify(t('development.database.diagram.saved'), 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'danger')
    } finally {
      setSaving(false)
    }
  }

  const exportSchema = (): SchemaModel => {
    if (!draft) return fullSchema
    const indexes = draft.tables.flatMap((table) => table.indexes.map((index) => ({
      name: index.name,
      unique: index.unique,
      columns: [...index.columns],
      origin: 'c',
      sql: index.raw,
      table: table.name,
    })))
    return {
      tables: diagramTablesToParsedTables(draft),
      views: fullSchema.views,
      triggers: fullSchema.triggers,
      indexes,
    }
  }

  const handleExport = async (format: 'png' | 'svg' | 'mermaid' | 'markdown') => {
    try {
      if (format === 'png') {
        await downloadFlowPng(nodes, edges, exportNode, 'inkstone-erd')
        return
      }
      if (format === 'svg') {
        downloadFlowSvg(nodes, edges, exportNode, 'inkstone-erd')
        return
      }
      if (format === 'mermaid') {
        downloadTextFile(
          'inkstone-erd.md',
          `\`\`\`mermaid
${schemaToMermaid(exportSchema())}
\`\`\`
`,
          'text/markdown',
        )
        return
      }
      downloadTextFile(
        'inkstone-erd.md',
        schemaToMarkdown(exportSchema(), documentLabels(), { title: 'inkstone-erd' }),
        'text/markdown',
      )
    } catch (error) {
      notify(error instanceof Error ? error.message : t('development.database.flow.export_failed'), 'danger')
    }
  }

  const selectIssue = (issue: DiagramIssue) => {
    if (issue.relationshipId) {
      setSelectedEdgeId(issue.relationshipId)
    }
    if (!issue.tableId || !draft) return
    setSelectedIds(new Set([issue.tableId]))
    const table = findTable(draft, issue.tableId)
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!table || !rect) return
    const zoom = Math.min(Math.max(viewport.zoom, 0.6), 1.2)
    setViewport({
      zoom,
      x: rect.width / 2 - (table.x + table.width / 2) * zoom,
      y: rect.height / 2 - (table.y + erdNodeHeight(table.columns.length) / 2) * zoom,
    })
  }

  const activeDraft = draft
  const tableById = useMemo(
    () => new Map((activeDraft?.tables ?? []).map((table) => [table.id, table])),
    [activeDraft],
  )
  const fkColumns = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const relationship of activeDraft?.relationships ?? []) {
      const set = map.get(relationship.startTableId) ?? new Set<string>()
      for (const column of relationship.startColumns) set.add(column)
      map.set(relationship.startTableId, set)
    }
    return map
  }, [activeDraft])

  const viewLayout = useMemo(() => buildErdLayout(fullSchema.tables), [fullSchema])
  useEffect(() => {
    setViewNodes(viewLayout.nodes)
  }, [viewLayout])

  const nodes = mode === 'edit' && draft
    ? draft.tables.map((table) => ({
        id: table.id,
        x: table.x,
        y: table.y,
        width: table.width,
        height: erdNodeHeight(table.columns.length),
      }))
    : viewNodes
  const edges = mode === 'edit' && draft
    ? draft.relationships.map((relationship) => ({
        id: relationship.id,
        source: relationship.startTableId,
        target: relationship.endTableId,
        label: relationshipLabel(draft, relationship),
      }))
    : viewLayout.edges

  const exportNode = useCallback((id: string): FlowExportNode | null => {
    if (mode === 'edit' && draft) {
      const table = findTable(draft, id)
      if (!table) return null
      const foreign = fkColumns.get(id) ?? new Set<string>()
      const lines: string[] = []
      const highlightLines = new Set<number>()
      for (const column of table.columns) {
        lines.push(`${column.pk ? 'PK ' : ''}${column.name} ${column.type}`)
        if (foreign.has(column.name)) highlightLines.add(lines.length - 1)
      }
      if (lines.length === 0) lines.push(t('development.database.erd.no_columns'))
      return { title: table.name, lines, highlightLines }
    }
    const table = fullSchema.tables.find((entry) => entry.name === id)
    if (!table) return null
    const foreign = viewLayout.fkColumns.get(id) ?? new Set<string>()
    const lines: string[] = []
    const highlightLines = new Set<number>()
    for (const column of table.columns) {
      lines.push(`${column.pk ? 'PK ' : ''}${column.name} ${column.type}`)
      if (foreign.has(column.name)) highlightLines.add(lines.length - 1)
    }
    if (lines.length === 0) lines.push(t('development.database.erd.no_columns'))
    return { title: table.name, lines, highlightLines }
  }, [draft, fkColumns, fullSchema.tables, mode, viewLayout.fkColumns])

  const menuItems: MenuItem[] = []
  if (menu) {
    const table = menu.table
    if (onOpenData) {
      menuItems.push({
        id: 'view-data',
        label: t('development.database.erd.view_data'),
        icon: <Table2 size={13} aria-hidden="true" />,
        onSelect: () => {
          onOpenData(table)
          setMenu(null)
        },
      })
    }
    if (onOpenSchema) {
      menuItems.push({
        id: 'edit-schema',
        label: t('development.database.erd.edit_schema'),
        icon: <Pencil size={13} aria-hidden="true" />,
        onSelect: () => {
          onOpenSchema(table)
          setMenu(null)
        },
      })
    }
    if (mode === 'edit') {
      menuItems.push(
        {
          id: 'rename',
          label: t('development.database.diagram.rename'),
          icon: <Pencil size={13} aria-hidden="true" />,
          onSelect: () => {
            const current = findTable(activeDraft!, table)
            setRename({ tableId: table, value: current?.name ?? table })
            setMenu(null)
          },
        },
        {
          id: 'duplicate',
          label: t('development.database.diagram.duplicate'),
          icon: <Copy size={13} aria-hidden="true" />,
          onSelect: () => {
            duplicate(table)
            setMenu(null)
          },
        },
        {
          id: 'delete',
          label: t('development.database.diagram.delete_table'),
          icon: <Trash2 size={13} aria-hidden="true" />,
          tone: 'danger',
          onSelect: () => {
            void deleteTables(new Set([table]))
            setMenu(null)
          },
        },
      )
    }
  }

  const openContextMenu = useCallback((id: string, point: { x: number; y: number }) => {
    setSelectedIds(new Set([id]))
    setMenu({ table: id, x: point.x, y: point.y })
  }, [])

  return (
    <div className={cn('relative flex h-full min-h-0 w-full flex-col', className)}>
      {mode === 'edit' && draft && (
        <ErdToolbar
          dirty={dirty}
          canUndo={Boolean(historyRef.current?.canUndo)}
          canRedo={Boolean(historyRef.current?.canRedo)}
          issues={issues}
          selectedEdge={selectedEdgeId !== null}
          saving={saving}
          onExit={() => void exitEdit()}
          onNewTable={() => setCreateOpen(true)}
          onAddRelation={() => setRelationDialog({ initial: {} })}
          onEditRelation={() => {
            const relationship = draft.relationships.find((entry) => entry.id === selectedEdgeId)
            if (!relationship) return
            setRelationDialog({
              initial: {
                startTableId: relationship.startTableId,
                startColumns: relationship.startColumns,
                endTableId: relationship.endTableId,
                endColumns: relationship.endColumns,
                onUpdate: relationship.onUpdate,
                onDelete: relationship.onDelete,
                constraintId: relationship.constraintId,
                ...(relationship.name ? { name: relationship.name } : {}),
              },
            })
          }}
          onDeleteRelation={() => deleteRelation()}
          onUndo={undo}
          onRedo={redo}
          onAutoLayout={autoLayout}
          onResetLayout={resetLayout}
          onSave={save}
          onSelectIssue={selectIssue}
          onExport={(format) => void handleExport(format)}
        />
      )}

      {schemaChanged && mode === 'edit' && (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--warning)]/30 bg-[var(--warning-soft)] px-3 py-1.5 text-[length:var(--text-12)] text-[var(--warning)]">
          <span className="min-w-0 flex-1">{t('development.database.diagram.schema_changed')}</span>
          <Button variant="secondary" size="sm" onClick={reloadFromSchema}>
            {t('development.database.diagram.reload_schema')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSchemaChanged(false)}>
            {t('development.database.diagram.keep_editing')}
          </Button>
        </div>
      )}

      <div ref={wrapperRef} className="relative min-h-0 flex-1">
        {mode === 'view' && canEdit && (
          <div className="absolute top-3 left-3 z-10">
            <Button variant="secondary" size="sm" className="bg-[var(--bg-overlay)] shadow-[var(--shadow-sm)]" onClick={enterEdit}>
              <Pencil size={13} />
              {t('development.database.diagram.edit')}
            </Button>
          </div>
        )}

        <SvgFlow
          nodes={nodes}
          edges={edges}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          selectionMode={mode === 'edit' ? 'marquee' : 'pan'}
          snapGrid={mode === 'edit' ? 24 : undefined}
          onNodesChange={moveNode}
          onNodeContextMenu={openContextMenu}
          onDeleteSelection={mode === 'edit' ? deleteSelection : undefined}
          onNodeDoubleClick={onOpenSchema}
          selectedEdgeId={selectedEdgeId}
          onEdgeSelect={mode === 'edit' ? setSelectedEdgeId : undefined}
          viewport={viewport}
          onViewportChange={setViewport}
          nodeLabel={(id) => t('development.database.erd.node_label', { table: id })}
          exportNode={exportNode}
          exportName="inkstone-erd"
          onError={(message) => notify(message, 'danger')}
          renderOverlay={() => {
            if (!relationDrag) return null
            return (
              <svg className="absolute inset-0 size-full" aria-hidden="true">
                <line
                  x1={relationDrag.screenX}
                  y1={relationDrag.screenY}
                  x2={relationDrag.currentX}
                  y2={relationDrag.currentY}
                  stroke="var(--accent)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
              </svg>
            )
          }}
          renderNode={(id) => {
            const table = mode === 'edit' && draft
              ? tableById.get(id) ?? null
              : fullSchema.tables.find((entry) => entry.name === id) ?? null
            if (!table) return null
            const tableId = 'id' in table ? table.id : table.name
            const foreign = fkColumns.get(id) ?? viewLayout.fkColumns.get(id) ?? new Set<string>()
            return (
              <div className="flex h-full w-full flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-raised)] shadow-[var(--shadow-pop)]">
                <div
                  className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-hover)] px-2.5"
                  style={{ height: ERD_NODE_HEADER_HEIGHT }}
                >
                  <Table2 size={12} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11)] font-semibold text-[var(--text-primary)]">
                    {table.name}
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  {table.columns.map((column) => {
                    const isForeignKey = foreign.has(column.name)
                    return (
                      <div
                        key={'id' in column ? column.id : column.name}
                        data-erd-table={table.name}
                        data-erd-column={column.name}
                        data-fk={isForeignKey ? 'true' : undefined}
                        className={cn(
                          'group flex items-center gap-1.5 px-2.5 font-mono text-[length:var(--text-11)]',
                          isForeignKey && 'bg-[var(--accent-soft)]',
                        )}
                        style={{ height: ERD_NODE_ROW_HEIGHT }}
                      >
                        <span className="flex w-3 shrink-0 justify-center text-[var(--accent)]">
                          {column.pk && (
                            <KeyRound
                              size={10}
                              role="img"
                              aria-label={t('development.database.erd.primary_key')}
                            />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{column.name}</span>
                        <span className="max-w-[42%] shrink-0 truncate text-[length:var(--text-9-5)] text-[var(--text-tertiary)]">
                          {column.type}
                        </span>
                        {isForeignKey && (
                          <Link2
                            size={9}
                            role="img"
                            aria-label={t('development.database.erd.foreign_key')}
                            className="shrink-0 text-[var(--accent)]"
                          />
                        )}
                        {mode === 'edit' && (
                          <button
                            type="button"
                            aria-label={t('development.database.diagram.column_handle', { column: column.name })}
                            className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] opacity-0 hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--accent)] group-hover:opacity-100"
                            onPointerDown={(event) => startRelationDrag(tableId, column.name, event)}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return
                              event.preventDefault()
                              setRelationDialog({ initial: { startTableId: tableId, startColumns: [column.name] } })
                            }}
                          >
                            <Link2 size={9} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {table.columns.length === 0 && (
                    <div
                      className="flex items-center px-2.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]"
                      style={{ height: ERD_NODE_ROW_HEIGHT }}
                    >
                      {t('development.database.erd.no_columns')}
                    </div>
                  )}
                </div>
              </div>
            )
          }}
        />

        <div
          data-erd-stats="true"
          data-tables={mode === 'edit' && draft ? draft.tables.length : fullSchema.tables.length}
          data-foreign-keys={edges.length}
          className="pointer-events-none absolute top-3 left-1/2 z-[var(--z-sticky)] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)] shadow-[var(--shadow-sm)]"
        >
          <GitBranch size={12} aria-hidden="true" />
          {t('development.database.erd.stats', {
            tables: mode === 'edit' && draft ? draft.tables.length : fullSchema.tables.length,
            foreignKeys: edges.length,
          })}
        </div>

        {fullSchema.tables.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
            {t('development.database.erd.empty')}
          </div>
        )}
      </div>

      <Menu
        anchor={{ x: menu?.x ?? 0, y: menu?.y ?? 0 }}
        open={menu !== null}
        onClose={() => setMenu(null)}
        items={menuItems}
        label={t('development.database.erd.actions')}
        width={192}
      />

      <TableCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onConfirm={createTable}
      />

      <Modal
        open={rename !== null}
        onClose={() => setRename(null)}
        title={t('development.database.diagram.rename_title', { table: rename?.tableId ?? '' })}
        width={420}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRename(null)}>
              {t('development.database.common.cancel')}
            </Button>
            <Button size="sm" onClick={confirmRename}>
              {t('development.database.diagram.rename')}
            </Button>
          </>
        }
      >
        <Field label={t('development.database.schema.table_name')} required>
          <Input
            value={rename?.value ?? ''}
            onChange={(event) => setRename((current) => current ? { ...current, value: event.target.value } : current)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return
              if (event.key === 'Enter') {
                event.preventDefault()
                confirmRename()
              }
            }}
            aria-label={t('development.database.schema.table_name')}
          />
        </Field>
      </Modal>

      {relationDialog && (
        <RelationshipDialog
          draft={activeDraft ?? { tables: [], relationships: [] }}
          initial={relationDialog.initial}
          onClose={() => setRelationDialog(null)}
          onSubmit={applyRelationship}
          onDelete={(constraintId, startTableId) => {
            deleteRelation(constraintId, startTableId)
            setRelationDialog(null)
          }}
        />
      )}

      <DdlPreviewDialog
        plan={preview}
        remote={remote}
        executing={saving}
        onClose={() => setPreview(null)}
        onExecute={() => void execute()}
      />
    </div>
  )
}

function withTables(tables: ParsedTable[]): SchemaModel {
  return { tables, views: [], triggers: [], indexes: EMPTY_SCHEMA.indexes }
}