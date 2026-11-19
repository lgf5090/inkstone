import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Save, Table2, Trash2, Undo2 } from 'lucide-react'
import type { ParsedTable, SchemaModel } from '@shared/development/database/types'
import { quoteIdent } from '@shared/development/database/sql-utils'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { useUi } from '../../../store/ui'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Input } from '../../../components/form'
import { Modal, confirm } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import {
  createDiagramTable,
  parsedTableToDiagramTable,
  schemaToDiagram,
  syncRelationships,
  tableContentSignature,
  type DiagramColumn,
  type DiagramDraft,
  type DiagramIndex,
  type DiagramTable,
} from './diagram'
import { makeDiagramId, type DiagramConstraint, type RefAction } from './constraints'
import { buildDiagramDdl, type DiagramDdlPlan } from './diagram-ddl'
import type { StudioDriver } from './drivers'
import { TableCreateDialog, COMMON_COLUMN_TYPES, type CreateTableColumn } from './TableCreateDialog'
import { IndexDialog } from './IndexDialog'
import { ConstraintDialog } from './ConstraintDialog'
import { RelationshipDialog, type RelationshipInput } from './RelationshipDialog'
import { DdlPreviewDialog } from './DdlPreviewDialog'

type EditorTab = 'fields' | 'indexes' | 'foreignKeys' | 'constraints'

const TABS: EditorTab[] = ['fields', 'indexes', 'foreignKeys', 'constraints']

export interface SchemaEditorProps {
  ensureWritable?: () => Promise<boolean>
  driver: StudioDriver
  table: ParsedTable | null
  schemaModel?: SchemaModel
  onSchemaChanged?: () => void
  onError: (message: string) => void
  onOpenSql?: (sql: string) => void
  onTableCreated?: (name: string) => void
}

function editorSignature(table: DiagramTable): string {
  return JSON.stringify([table.name, tableContentSignature(table)])
}

function indexesForSchema(schema: SchemaModel, tableName: string): DiagramIndex[] {
  return schema.indexes
    .filter((index) => index.table === tableName)
    .map((index) => ({
      id: makeDiagramId('index'),
      name: index.name,
      unique: index.unique,
      columns: [...index.columns],
      raw: index.sql,
    }))
}

function notify(message: string, tone: 'success' | 'danger' | 'warning'): void {
  useUi.getState().toast({ title: message, tone })
}

export function SchemaEditor({
  driver,
  table,
  schemaModel,
  onSchemaChanged,
  ensureWritable,
  onError,
  onOpenSql,
  onTableCreated,
}: SchemaEditorProps) {
  const [tableDraft, setTableDraft] = useState<DiagramTable | null>(null)
  const [baseline, setBaseline] = useState('')
  const [tab, setTab] = useState<EditorTab>('fields')
  const [createOpen, setCreateOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [indexDialog, setIndexDialog] = useState<{ initial: DiagramIndex | null } | null>(null)
  const [constraintDialog, setConstraintDialog] = useState<{ kind: 'unique' | 'check'; initial: DiagramConstraint | null } | null>(null)
  const [relationDialog, setRelationDialog] = useState<{ initial: Partial<RelationshipInput> } | null>(null)
  const [preview, setPreview] = useState<DiagramDdlPlan | null>(null)
  const [pendingCreate, setPendingCreate] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const fullSchema = useMemo<SchemaModel>(
    () => schemaModel ?? { tables: table ? [table] : [], views: [], triggers: [], indexes: [] },
    [schemaModel, table],
  )

  useEffect(() => {
    if (!table) {
      setTableDraft(null)
      setBaseline('')
      return
    }
    const next = parsedTableToDiagramTable(table, indexesForSchema(fullSchema, table.name))
    setTableDraft(next)
    setBaseline(editorSignature(next))
    setTab('fields')
  }, [fullSchema, table])

  const dirty = Boolean(tableDraft && baseline && editorSignature(tableDraft) !== baseline)
  const remote = driver.type !== 'sqlite'

  const updateColumn = (id: string, patch: Partial<DiagramColumn>) => {
    setTableDraft((current) => (current ? {
      ...current,
      columns: current.columns.map((column) => (column.id === id ? { ...column, ...patch } : column)),
    } : current))
  }

  const addColumn = () => {
    setTableDraft((current) => (current ? {
      ...current,
      columns: [...current.columns, {
        id: makeDiagramId('column'),
        name: '',
        type: 'TEXT',
        notNull: false,
        pk: false,
        pkPosition: 0,
        default: null,
        unique: false,
        check: null,
        collate: null,
        generated: null,
        autoIncrement: false,
      }],
    } : current))
  }

  const removeColumn = (id: string) => {
    setTableDraft((current) => (current ? {
      ...current,
      columns: current.columns.filter((column) => column.id !== id),
    } : current))
  }

  const moveColumn = (index: number, direction: -1 | 1) => {
    setTableDraft((current) => {
      if (!current) return current
      const target = index + direction
      if (target < 0 || target >= current.columns.length) return current
      const columns = [...current.columns]
      const [column] = columns.splice(index, 1)
      columns.splice(target, 0, column!)
      return { ...current, columns }
    })
  }

  const replaceIndex = (index: DiagramIndex) => {
    setTableDraft((current) => (current ? {
      ...current,
      indexes: current.indexes.some((entry) => entry.id === index.id)
        ? current.indexes.map((entry) => (entry.id === index.id ? index : entry))
        : [...current.indexes, index],
    } : current))
    setIndexDialog(null)
  }

  const removeIndex = (id: string) => {
    setTableDraft((current) => (current ? { ...current, indexes: current.indexes.filter((entry) => entry.id !== id) } : current))
  }

  const replaceConstraint = (constraint: DiagramConstraint) => {
    setTableDraft((current) => (current ? {
      ...current,
      constraints: current.constraints.some((entry) => entry.id === constraint.id)
        ? current.constraints.map((entry) => (entry.id === constraint.id ? constraint : entry))
        : [...current.constraints, constraint],
    } : current))
    setConstraintDialog(null)
  }

  const removeConstraint = (id: string) => {
    setTableDraft((current) => (current ? {
      ...current,
      constraints: current.constraints.filter((entry) => entry.id !== id),
    } : current))
  }

  const applyRelationship = (input: RelationshipInput) => {
    if (!tableDraft) return
    const constraint: DiagramConstraint = {
      id: input.constraintId ?? makeDiagramId('constraint'),
      kind: 'foreign-key',
      ...(input.name ? { name: input.name } : {}),
      raw: '',
      columns: input.startColumns,
      refTable: input.endTableId,
      refColumns: input.endColumns,
      onUpdate: input.onUpdate,
      onDelete: input.onDelete,
    }
    replaceConstraint(constraint)
    setRelationDialog(null)
  }

  const fullDraftFor = (current: DiagramTable): DiagramDraft => {
    const originalName = table?.name ?? current.name
    const renamed = current.name !== originalName
    const base = schemaToDiagram(fullSchema)
    const tables = base.tables.map((entry) => {
      if (entry.id === originalName) return { ...current, x: entry.x, y: entry.y }
      if (!renamed) return entry
      return {
        ...entry,
        constraints: entry.constraints.map((constraint) => (
          constraint.refTable === originalName ? { ...constraint, refTable: current.name } : constraint
        )),
      }
    })
    return syncRelationships({
      tables,
      ...(renamed ? { renames: [{ from: originalName, to: current.name }] } : {}),
    })
  }

  const planFor = (current: DiagramTable): DiagramDdlPlan => buildDiagramDdl(
    fullSchema,
    fullDraftFor(current),
    { views: fullSchema.views, triggers: fullSchema.triggers, indexes: fullSchema.indexes },
  )

  const save = () => {
    if (!tableDraft) return
    const plan = planFor(tableDraft)
    if (plan.statements.length === 0) {
      notify(t('development.database.diagram.no_changes'), 'warning')
      return
    }
    setPendingCreate(null)
    setPreview(plan)
  }

  const execute = async () => {
    if (!preview) return
    if (ensureWritable && !(await ensureWritable())) return
    setSaving(true)
    try {
      const runnable = preview.statements.filter((statement) => (
        !/^(?:begin|commit|rollback|pragma\s+foreign_keys)\b/i.test(statement.trim())
      ))
      await driver.transaction(
        runnable.map((sql) => ({ sql })),
        { confirmProduction: true, foreignKeysOff: true },
      )
      setPreview(null)
      onOpenSql?.(runnable.join('\n'))
      onSchemaChanged?.()
      if (pendingCreate) {
        onTableCreated?.(pendingCreate)
        setPendingCreate(null)
      }
      notify(t('development.database.diagram.saved'), 'success')
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const createTable = async (name: string, columns: CreateTableColumn[]): Promise<boolean> => {
    const trimmed = name.trim()
    if (!trimmed) {
      notify(t('development.database.diagram.name_required'), 'warning')
      return false
    }
    if (fullSchema.tables.some((entry) => entry.name.toLowerCase() === trimmed.toLowerCase())) {
      notify(t('development.database.diagram.name_exists'), 'warning')
      return false
    }
    const base = tableDraft ? fullDraftFor(tableDraft) : schemaToDiagram(fullSchema)
    const nextTable = createDiagramTable(trimmed, columns.map((column) => ({
      name: column.name,
      type: column.type,
      pk: column.pk,
      notNull: column.notNull,
      unique: column.unique,
      default: column.default,
    })))
    const draft = syncRelationships({ tables: [...base.tables, nextTable] })
    const plan = buildDiagramDdl(fullSchema, draft, {
      views: fullSchema.views,
      triggers: fullSchema.triggers,
      indexes: fullSchema.indexes,
    })
    setPendingCreate(trimmed)
    setPreview(plan)
    return true
  }

  const resetDraft = () => {
    if (!table) return
    const next = parsedTableToDiagramTable(table, indexesForSchema(fullSchema, table.name))
    setTableDraft(next)
    setBaseline(editorSignature(next))
  }

  const confirmRename = () => {
    if (!tableDraft) return
    const value = renameValue.trim()
    if (!value) {
      notify(t('development.database.diagram.name_required'), 'warning')
      return
    }
    if (fullSchema.tables.some((entry) => entry.name !== tableDraft.name && entry.name.toLowerCase() === value.toLowerCase())) {
      notify(t('development.database.diagram.name_exists'), 'warning')
      return
    }
    setTableDraft({ ...tableDraft, id: value, name: value })
    setRenameOpen(false)
  }

  const dropTable = async () => {
    if (!table) return
    if (ensureWritable && !(await ensureWritable())) return
    const ok = await confirm({
      title: t('development.database.schema.drop_title', { table: table.name }),
      description: t('development.database.schema.drop_description'),
      confirmLabel: t('development.database.schema.drop_table'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await driver.query(`DROP TABLE ${quoteIdent(table.name)};`, undefined, { confirmProduction: true })
      onSchemaChanged?.()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  const dialogs = (
    <>
      <TableCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onConfirm={createTable}
      />
      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={t('development.database.diagram.rename_title', { table: table?.name ?? '' })}
        width={420}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRenameOpen(false)}>
              {t('development.database.common.cancel')}
            </Button>
            <Button size="sm" onClick={confirmRename}>{t('development.database.diagram.rename')}</Button>
          </>
        }
      >
        <Input
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              confirmRename()
            }
          }}
          aria-label={t('development.database.schema.table_name')}
        />
      </Modal>
      {indexDialog && tableDraft && (
        <IndexDialog
          table={tableDraft}
          initial={indexDialog.initial}
          onClose={() => setIndexDialog(null)}
          onSubmit={replaceIndex}
        />
      )}
      {constraintDialog && tableDraft && (
        <ConstraintDialog
          kind={constraintDialog.kind}
          table={tableDraft}
          initial={constraintDialog.initial}
          onClose={() => setConstraintDialog(null)}
          onSubmit={replaceConstraint}
        />
      )}
      {relationDialog && tableDraft && (
        <RelationshipDialog
          draft={fullDraftFor(tableDraft)}
          initial={relationDialog.initial}
          lockSource
          onClose={() => setRelationDialog(null)}
          onSubmit={applyRelationship}
        />
      )}
      <DdlPreviewDialog
        plan={preview}
        remote={remote}
        executing={saving}
        onClose={() => {
          setPreview(null)
          setPendingCreate(null)
        }}
        onExecute={() => void execute()}
      />
    </>
  )

  if (!tableDraft) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <Table2 size={30} className="opacity-40" aria-hidden="true" />
        <p className="text-[length:var(--text-13)]">{t('development.database.schema.select_table')}</p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={14} />
          {t('development.database.schema.create_table')}
        </Button>
        {dialogs}
      </div>
    )
  }

  const foreignKeys = tableDraft.constraints.filter((constraint) => constraint.kind === 'foreign-key')
  const uniques = tableDraft.constraints.filter((constraint) => constraint.kind === 'unique')
  const checks = tableDraft.constraints.filter((constraint) => constraint.kind === 'check')
  const unknown = tableDraft.constraints.filter((constraint) => constraint.kind === 'unknown')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
        <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{tableDraft.name}</span>
        <IconButton
          label={t('development.database.editor.rename_table')}
          size="xs"
          onClick={() => {
            setRenameValue(tableDraft.name)
            setRenameOpen(true)
          }}
        >
          <Pencil size={12} />
        </IconButton>
        {dirty && (
          <span className="flex items-center gap-1 text-[length:var(--text-11)] text-[var(--warning)]" role="status">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--warning)]" />
            {t('development.database.diagram.dirty')}
          </span>
        )}
        <div className="flex-1" />
        {tab === 'fields' && (
          <Button variant="secondary" size="sm" onClick={addColumn}>
            <Plus size={14} />
            {t('development.database.schema.add_column')}
          </Button>
        )}
        {tab === 'indexes' && (
          <Button variant="secondary" size="sm" onClick={() => setIndexDialog({ initial: null })}>
            <Plus size={14} />
            {t('development.database.editor.add_index')}
          </Button>
        )}
        {tab === 'foreignKeys' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRelationDialog({ initial: { startTableId: tableDraft.name } })}
          >
            <Plus size={14} />
            {t('development.database.editor.add_foreign_key')}
          </Button>
        )}
        {tab === 'constraints' && (
          <>
            <Button variant="secondary" size="sm" onClick={() => setConstraintDialog({ kind: 'unique', initial: null })}>
              <Plus size={14} />
              {t('development.database.editor.add_unique')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setConstraintDialog({ kind: 'check', initial: null })}>
              <Plus size={14} />
              {t('development.database.editor.add_check')}
            </Button>
          </>
        )}
        <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={14} />
          {t('development.database.schema.create_table')}
        </Button>
        <Button variant="ghost" size="sm" onClick={resetDraft} disabled={!dirty}>
          <Undo2 size={14} />
          {t('development.database.schema.reset')}
        </Button>
        <Button size="sm" onClick={save} disabled={saving || !dirty}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {t('development.database.schema.save_changes')}
        </Button>
        <Button variant="secondary" size="sm" className="text-[var(--danger)]" onClick={() => void dropTable()}>
          <Trash2 size={14} />
          {t('development.database.schema.drop_table')}
        </Button>
      </div>

      <div role="tablist" aria-label={t('development.database.editor.tabs')} className="flex shrink-0 items-center gap-0.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2">
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            onClick={() => setTab(entry)}
            className={cn(
              'relative px-2 py-1.5 text-[length:var(--text-12)]',
              tab === entry
                ? 'font-medium text-[var(--accent)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
            )}
          >
            {entry === 'fields'
              ? t('development.database.editor.tab_fields')
              : entry === 'indexes'
                ? t('development.database.editor.tab_indexes')
                : entry === 'foreignKeys'
                  ? t('development.database.editor.tab_foreign_keys')
                  : t('development.database.editor.tab_constraints')}
            {tab === entry && <span aria-hidden="true" className="absolute inset-x-1 bottom-0 h-0.5 rounded bg-[var(--accent)]" />}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'fields' && (
          <table className="w-full border-collapse text-[length:var(--text-12)]">
            <thead className="sticky top-0 z-10 bg-[var(--bg-sunken)]">
              <tr className="text-left text-[var(--text-tertiary)]">
                <th className="w-16 border-b border-[var(--border-subtle)] px-2 py-1.5 font-medium">{t('development.database.editor.order')}</th>
                <th className="w-10 border-b border-[var(--border-subtle)] px-2 py-1.5 font-medium" aria-label={t('development.database.editor.delete')} />
                <th className="border-b border-[var(--border-subtle)] px-2 py-1.5 font-medium">{t('development.database.schema.name')}</th>
                <th className="border-b border-[var(--border-subtle)] px-2 py-1.5 font-medium">{t('development.database.schema.type')}</th>
                <th className="w-14 border-b border-[var(--border-subtle)] px-2 py-1.5 text-center font-medium">{t('development.database.schema.pk')}</th>
                <th className="w-20 border-b border-[var(--border-subtle)] px-2 py-1.5 text-center font-medium">{t('development.database.schema.not_null')}</th>
                <th className="w-16 border-b border-[var(--border-subtle)] px-2 py-1.5 text-center font-medium">{t('development.database.schema.unique')}</th>
                <th className="border-b border-[var(--border-subtle)] px-2 py-1.5 font-medium">{t('development.database.schema.default')}</th>
              </tr>
            </thead>
            <tbody>
              {tableDraft.columns.map((column, index) => {
                const label = column.name.trim() || String(index + 1)
                const customType = !(COMMON_COLUMN_TYPES as readonly string[]).includes(column.type.toUpperCase())
                return (
                  <tr key={column.id}>
                    <td className="border-b border-[var(--border-subtle)] px-1 py-1">
                      <div className="flex items-center gap-0.5">
                        <IconButton
                          label={`${t('development.database.editor.move_up')} ${label}`}
                          size="xs"
                          disabled={index === 0}
                          onClick={() => moveColumn(index, -1)}
                        >
                          <ArrowUp size={11} />
                        </IconButton>
                        <IconButton
                          label={`${t('development.database.editor.move_down')} ${label}`}
                          size="xs"
                          disabled={index === tableDraft.columns.length - 1}
                          onClick={() => moveColumn(index, 1)}
                        >
                          <ArrowDown size={11} />
                        </IconButton>
                      </div>
                    </td>
                    <td className="border-b border-[var(--border-subtle)] px-1 py-1">
                      <IconButton
                        label={`${t('development.database.schema.delete_column')} ${label}`}
                        size="xs"
                        onClick={() => removeColumn(column.id)}
                      >
                        <Trash2 size={12} />
                      </IconButton>
                    </td>
                    <td className="border-b border-[var(--border-subtle)] px-2 py-1">
                      <Input
                        value={column.name}
                        onChange={(event) => updateColumn(column.id, { name: event.target.value })}
                        placeholder={t('development.database.schema.name')}
                        aria-label={`${t('development.database.schema.name')} ${label}`}
                        className="h-7"
                      />
                    </td>
                    <td className="border-b border-[var(--border-subtle)] px-2 py-1">
                      <SelectMenu
                        label={`${t('development.database.schema.type')} ${label}`}
                        value={customType ? 'CUSTOM' : column.type.toUpperCase()}
                        options={[
                          ...COMMON_COLUMN_TYPES.map((type) => ({ value: type, label: type })),
                          { value: 'CUSTOM', label: column.type || t('development.database.schema.custom') },
                        ]}
                        onChange={(value) => updateColumn(column.id, { type: value === 'CUSTOM' ? column.type : value })}
                        size="sm"
                      />
                    </td>
                    <td className="border-b border-[var(--border-subtle)] px-2 py-1 text-center">
                      <Checkbox
                        checked={column.pk}
                        ariaLabel={`${t('development.database.schema.pk')} ${label}`}
                        onChange={(next) => updateColumn(column.id, { pk: next, ...(next ? {} : { autoIncrement: false }) })}
                      />
                    </td>
                    <td className="border-b border-[var(--border-subtle)] px-2 py-1 text-center">
                      <Checkbox
                        checked={column.notNull}
                        ariaLabel={`${t('development.database.schema.not_null')} ${label}`}
                        onChange={(next) => updateColumn(column.id, { notNull: next })}
                      />
                    </td>
                    <td className="border-b border-[var(--border-subtle)] px-2 py-1 text-center">
                      <Checkbox
                        checked={column.unique}
                        ariaLabel={`${t('development.database.schema.unique')} ${label}`}
                        onChange={(next) => updateColumn(column.id, { unique: next })}
                      />
                    </td>
                    <td className="border-b border-[var(--border-subtle)] px-2 py-1">
                      <Input
                        value={column.default ?? ''}
                        onChange={(event) => updateColumn(column.id, { default: event.target.value === '' ? null : event.target.value })}
                        placeholder="NULL"
                        aria-label={`${t('development.database.schema.default')} ${label}`}
                        className="h-7"
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {tab === 'fields' && tableDraft.columns.length === 0 && (
          <div className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('development.database.schema.no_columns')}
          </div>
        )}

        {tab === 'indexes' && (
          <div className="space-y-1 p-2">
            {tableDraft.indexes.length === 0 && (
              <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {t('development.database.editor.no_indexes')}
              </p>
            )}
            {tableDraft.indexes.map((index) => (
              <div key={index.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-12)]">{index.name}</span>
                {index.unique && <span className="rounded bg-[var(--accent-soft)] px-1 text-[length:var(--text-10)] text-[var(--accent-on-soft)]">{t('development.database.index.unique')}</span>}
                <span className="min-w-0 max-w-[50%] truncate font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {index.columns.length > 0 ? index.columns.join(', ') : t('development.database.editor.expression_index')}
                </span>
                <IconButton
                  label={t('development.database.editor.edit')}
                  size="xs"
                  disabled={index.columns.length === 0}
                  onClick={() => setIndexDialog({ initial: index })}
                >
                  <Pencil size={11} />
                </IconButton>
                <IconButton label={t('development.database.editor.delete')} size="xs" onClick={() => removeIndex(index.id)}>
                  <Trash2 size={11} />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        {tab === 'foreignKeys' && (
          <div className="space-y-1 p-2">
            {foreignKeys.length === 0 && (
              <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {t('development.database.editor.no_foreign_keys')}
              </p>
            )}
            {foreignKeys.map((constraint) => (
              <div key={constraint.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-12)]">
                  ({constraint.columns?.join(', ')}) → {constraint.refTable} ({constraint.refColumns?.join(', ')})
                </span>
                <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                  {describeActions(constraint.onUpdate, constraint.onDelete)}
                </span>
                <IconButton
                  label={t('development.database.editor.edit')}
                  size="xs"
                  onClick={() => setRelationDialog({
                    initial: {
                      startTableId: tableDraft.name,
                      startColumns: constraint.columns ?? [],
                      endTableId: constraint.refTable ?? '',
                      endColumns: constraint.refColumns ?? [],
                      onUpdate: constraint.onUpdate ?? 'NO ACTION',
                      onDelete: constraint.onDelete ?? 'NO ACTION',
                      constraintId: constraint.id,
                      ...(constraint.name ? { name: constraint.name } : {}),
                    },
                  })}
                >
                  <Pencil size={11} />
                </IconButton>
                <IconButton
                  label={t('development.database.editor.delete')}
                  size="xs"
                  onClick={() => removeConstraint(constraint.id)}
                >
                  <Trash2 size={11} />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        {tab === 'constraints' && (
          <div className="space-y-1 p-2">
            {uniques.length + checks.length + unknown.length === 0 && (
              <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {t('development.database.editor.no_constraints')}
              </p>
            )}
            {uniques.map((constraint) => (
              <div key={constraint.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5">
                <span className="rounded bg-[var(--bg-hover)] px-1 text-[length:var(--text-10)] text-[var(--text-secondary)]">{t('development.database.constraint.unique_badge')}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-12)]">
                  {constraint.name ? `${constraint.name} ` : ''}({constraint.uniqueColumns?.join(', ')})
                </span>
                <IconButton
                  label={t('development.database.editor.edit')}
                  size="xs"
                  onClick={() => setConstraintDialog({ kind: 'unique', initial: constraint })}
                >
                  <Pencil size={11} />
                </IconButton>
                <IconButton label={t('development.database.editor.delete')} size="xs" onClick={() => removeConstraint(constraint.id)}>
                  <Trash2 size={11} />
                </IconButton>
              </div>
            ))}
            {checks.map((constraint) => (
              <div key={constraint.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5">
                <span className="rounded bg-[var(--bg-hover)] px-1 text-[length:var(--text-10)] text-[var(--text-secondary)]">{t('development.database.constraint.check_badge')}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-12)]">
                  {constraint.name ? `${constraint.name} ` : ''}{constraint.expression}
                </span>
                <IconButton
                  label={t('development.database.editor.edit')}
                  size="xs"
                  onClick={() => setConstraintDialog({ kind: 'check', initial: constraint })}
                >
                  <Pencil size={11} />
                </IconButton>
                <IconButton label={t('development.database.editor.delete')} size="xs" onClick={() => removeConstraint(constraint.id)}>
                  <Trash2 size={11} />
                </IconButton>
              </div>
            ))}
            {unknown.map((constraint) => (
              <div key={constraint.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] px-2 py-1.5">
                <span className="rounded bg-[var(--bg-hover)] px-1 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                  {t('development.database.editor.unknown_constraint')}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {constraint.raw}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {dialogs}
    </div>
  )
}

function describeActions(onUpdate: RefAction | undefined, onDelete: RefAction | undefined): string {
  const parts = [
    onUpdate && onUpdate !== 'NO ACTION' ? `ON UPDATE ${onUpdate}` : '',
    onDelete && onDelete !== 'NO ACTION' ? `ON DELETE ${onDelete}` : '',
  ].filter(Boolean)
  return parts.join(' · ')
}