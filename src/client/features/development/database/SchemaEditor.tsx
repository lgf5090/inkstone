import { useEffect, useMemo, useState } from 'react'
import { Loader2, Play, Plus, Save, Table2, Trash2, Undo2 } from 'lucide-react'
import type { ParsedColumn, ParsedTable, SchemaModel, TableIndexInfo } from '@shared/development/database/types'
import { splitSqlStatements, quoteIdent } from '@shared/development/database/sql-utils'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUi } from '../../../store/ui'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Field, Input } from '../../../components/form'
import { Modal, confirm } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import type { StudioDriver } from './drivers'
import type { ColumnDraft } from './types'
import { buildCreateTableSql, buildRebuildSql, type DdlWarning, type RebuildObjects } from './ddl'

const COMMON_TYPES = ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'DATETIME', 'JSON', 'VARCHAR(255)', 'VARCHAR(64)', 'DOUBLE', 'BIGINT', 'TIMESTAMP']

export interface SchemaEditorProps {
  driver: StudioDriver
  table: ParsedTable | null
  schemaModel?: SchemaModel
  onSchemaChanged?: () => void
  onError: (message: string) => void
  onOpenSql?: (sql: string) => void
  onTableCreated?: (name: string) => void
}

function toDraft(column: ParsedColumn): ColumnDraft {
  return {
    id: `${column.name}-${Math.random().toString(36).slice(2, 7)}`,
    name: column.name,
    type: column.type,
    notNull: column.notNull,
    pk: column.pk,
    unique: column.unique,
    default: column.default ?? '',
    isNew: false,
    deleted: false,
    original: column,
  }
}

function emptyDraft(): ColumnDraft {
  return { id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, name: '', type: 'TEXT', notNull: false, pk: false, unique: false, default: '', isNew: true, deleted: false }
}

function warningText(warning: DdlWarning): string {
  switch (warning.code) {
    case 'constraint_references_removed_column':
      return t('development.database.schema.warning_constraint', { target: warning.target, columns: (warning.columns ?? []).join(', ') })
    case 'index_references_removed_column':
      return t('development.database.schema.warning_index', { target: warning.target, columns: (warning.columns ?? []).join(', ') })
    case 'trigger_references_removed_column':
      return t('development.database.schema.warning_trigger', { target: warning.target, columns: (warning.columns ?? []).join(', ') })
    case 'without_rowid_without_primary_key':
      return t('development.database.schema.warning_without_rowid')
    case 'missing_table_name':
      return t('development.database.schema.warning_table_name')
    case 'no_columns':
      return t('development.database.schema.warning_no_columns')
    default:
      return warning.code
  }
}

function tableObjects(table: ParsedTable, schema: SchemaModel | undefined): RebuildObjects {
  if (!schema) return {}
  const match = (sql: string | null): boolean => {
    if (!sql) return false
    return new RegExp(`\\b${table.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sql)
  }
  return {
    indexes: schema.indexes.filter((index: TableIndexInfo) => match(index.sql)),
    triggers: schema.triggers.filter((trigger) => match(trigger.sql)),
    views: schema.views.filter((view) => match(view.sql)),
  }
}

export function SchemaEditor({ driver, table, schemaModel, onSchemaChanged, onError, onOpenSql, onTableCreated }: SchemaEditorProps) {
  const [drafts, setDrafts] = useState<ColumnDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<{ sql: string; warnings: DdlWarning[]; create?: boolean } | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => {
    setDrafts(table ? table.columns.map(toDraft) : [])
  }, [table])

  const rebuild = useMemo(() => table ? buildRebuildSql(table, drafts, tableObjects(table, schemaModel)) : { sql: '', warnings: [] }, [drafts, table, schemaModel])

  if (!table) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <Table2 size={30} className="opacity-40" />
        <p className="text-[length:var(--text-13)]">{t('development.database.schema.select_table')}</p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={14} />
          {t('development.database.schema.create_table')}
        </Button>
        <CreateTableDialog open={createOpen} onClose={() => setCreateOpen(false)} onConfirm={async (name, columns) => {
          const built = buildCreateTableSql(name, columns)
          try {
            await driver.query(built.sql)
            onSchemaChanged?.()
            onTableCreated?.(name.trim())
            setCreateOpen(false)
          } catch (cause) {
            onError(cause instanceof Error ? cause.message : String(cause))
          }
        }} />
      </div>
    )
  }

  const update = (id: string, patch: Partial<ColumnDraft>) => {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...patch } : draft))
  }

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      const changed = drafts.some((draft) => draft.isNew || draft.deleted || draft.name !== draft.original?.name || draft.type.toUpperCase() !== draft.original?.type.toUpperCase() || draft.notNull !== draft.original?.notNull || draft.pk !== draft.original?.pk || draft.unique !== draft.original?.unique || (draft.default ?? '') !== (draft.original?.default ?? ''))
      if (!changed) return
      const simple: string[] = []
      let needsRebuild = false
      for (const draft of drafts) {
        if (draft.deleted && draft.original && !draft.isNew) {
          simple.push(`ALTER TABLE ${quoteIdent(table.name)} DROP COLUMN ${quoteIdent(draft.original.name)};`)
          continue
        }
        if (draft.isNew && draft.name.trim()) {
          if (draft.pk || draft.unique) needsRebuild = true
          else simple.push(`ALTER TABLE ${quoteIdent(table.name)} ADD COLUMN ${columnDefinition(draft)};`)
          continue
        }
        if (draft.original && !draft.deleted) {
          if (draft.name !== draft.original.name) {
            simple.push(`ALTER TABLE ${quoteIdent(table.name)} RENAME COLUMN ${quoteIdent(draft.original.name)} TO ${quoteIdent(draft.name.trim())};`)
          }
          if (
            draft.type.toUpperCase() !== draft.original.type.toUpperCase()
            || draft.notNull !== draft.original.notNull
            || draft.pk !== draft.original.pk
            || draft.unique !== draft.original.unique
            || (draft.default ?? '') !== (draft.original.default ?? '')
          ) needsRebuild = true
        }
      }
      if (needsRebuild) {
        setPreview({ sql: rebuild.sql, warnings: rebuild.warnings })
      } else if (simple.length > 0) {
        for (const statement of simple) await driver.query(statement)
        onSchemaChanged?.()
        onOpenSql?.(simple.join('\n'))
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const executePreview = async () => {
    if (!preview) return
    try {
      for (const statement of splitSqlStatements(preview.sql)) await driver.query(statement)
      setPreview(null)
      onSchemaChanged?.()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const dropTable = async () => {
    const ok = await confirm({
      title: t('development.database.schema.drop_title', { table: table.name }),
      description: t('development.database.schema.drop_description'),
      confirmLabel: t('development.database.schema.drop_table'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await driver.query(`DROP TABLE ${quoteIdent(table.name)};`)
      onSchemaChanged?.()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
        <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{table.name}</span>
        <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">
          {t('development.database.schema.column_count', { count: table.columns.length })}
          {table.withoutRowid ? ' · WITHOUT ROWID' : ''}
          {table.strict ? ' · STRICT' : ''}
        </span>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />{t('development.database.schema.create_table')}</Button>
        <Button variant="secondary" size="sm" onClick={() => setDrafts((current) => [...current, emptyDraft()])}><Plus size={14} />{t('development.database.schema.add_column')}</Button>
        <Button variant="secondary" size="sm" onClick={() => setPreview({ sql: rebuild.sql, warnings: rebuild.warnings })}><Play size={14} />{t('development.database.schema.sql_preview')}</Button>
        <Button variant="ghost" size="sm" onClick={() => setDrafts(table.columns.map(toDraft))}><Undo2 size={14} />{t('development.database.schema.reset')}</Button>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {t('development.database.schema.save_changes')}
        </Button>
        <Button variant="secondary" size="sm" className="text-[var(--danger)]" onClick={() => void dropTable()}><Trash2 size={14} />{t('development.database.schema.drop_table')}</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[length:var(--text-12)]">
          <thead className="sticky top-0 z-10 bg-[var(--bg-sunken)]">
            <tr className="text-left text-[var(--text-tertiary)]">
              <th className="w-12 border-b border-[var(--border-subtle)] px-2 py-1.5 font-medium">{t('development.database.schema.action')}</th>
              <th className="border-b border-[var(--border-subtle)] px-2 py-1.5 font-medium">{t('development.database.schema.name')}</th>
              <th className="border-b border-[var(--border-subtle)] px-2 py-1.5 font-medium">{t('development.database.schema.type')}</th>
              <th className="w-14 border-b border-[var(--border-subtle)] px-2 py-1.5 text-center font-medium">{t('development.database.schema.pk')}</th>
              <th className="w-20 border-b border-[var(--border-subtle)] px-2 py-1.5 text-center font-medium">{t('development.database.schema.not_null')}</th>
              <th className="w-16 border-b border-[var(--border-subtle)] px-2 py-1.5 text-center font-medium">{t('development.database.schema.unique')}</th>
              <th className="border-b border-[var(--border-subtle)] px-2 py-1.5 font-medium">{t('development.database.schema.default')}</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((draft) => (
              <tr key={draft.id} className={draft.deleted ? 'opacity-40 line-through' : undefined}>
                <td className="border-b border-[var(--border-subtle)] px-2 py-1">
                  <IconButton label={draft.deleted ? t('development.database.schema.undo_delete') : t('development.database.schema.delete_column')} size="xs" onClick={() => update(draft.id, { deleted: !draft.deleted })}>
                    <Trash2 size={12} />
                  </IconButton>
                </td>
                <td className="border-b border-[var(--border-subtle)] px-2 py-1">
                  <Input value={draft.name} onChange={(event) => update(draft.id, { name: event.target.value })} placeholder={t('development.database.schema.name')} className="h-7" />
                </td>
                <td className="border-b border-[var(--border-subtle)] px-2 py-1">
                  <SelectMenu
                    label={t('development.database.schema.type')}
                    value={COMMON_TYPES.includes(draft.type.toUpperCase()) ? draft.type.toUpperCase() : 'CUSTOM'}
                    options={[...COMMON_TYPES.map((type) => ({ value: type, label: type })), { value: 'CUSTOM', label: draft.type || t('development.database.schema.custom') }]}
                    onChange={(value) => update(draft.id, { type: value === 'CUSTOM' ? draft.type : value })}
                    size="sm"
                  />
                </td>
                <td className="border-b border-[var(--border-subtle)] px-2 py-1 text-center">
                  <Checkbox checked={draft.pk} ariaLabel={t('development.database.schema.pk')} onChange={(next) => update(draft.id, { pk: next })} />
                </td>
                <td className="border-b border-[var(--border-subtle)] px-2 py-1 text-center">
                  <Checkbox checked={draft.notNull} ariaLabel={t('development.database.schema.not_null')} onChange={(next) => update(draft.id, { notNull: next })} />
                </td>
                <td className="border-b border-[var(--border-subtle)] px-2 py-1 text-center">
                  <Checkbox checked={draft.unique} ariaLabel={t('development.database.schema.unique')} onChange={(next) => update(draft.id, { unique: next })} />
                </td>
                <td className="border-b border-[var(--border-subtle)] px-2 py-1">
                  <Input value={draft.default} onChange={(event) => update(draft.id, { default: event.target.value })} placeholder="NULL" className="h-7" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {drafts.length === 0 && <div className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.database.schema.no_columns')}</div>}
      </div>

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.create ? t('development.database.schema.create_table') : t('development.database.schema.rebuild_title')}
        width={760}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { if (preview) void copyText(preview.sql).then((ok) => useUi.getState().toast({ title: ok ? t('development.database.common.copied') : t('development.database.common.copy_failed'), tone: ok ? 'success' : 'danger' })) }}>{t('development.database.common.copy')}</Button>
            <Button size="sm" onClick={() => void executePreview()} disabled={!preview?.sql}>{t('development.database.schema.execute')}</Button>
          </>
        }
      >
        {preview && preview.warnings.length > 0 && (
          <ul className="mb-2 space-y-1 rounded-[var(--r-md)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-2 text-[length:var(--text-11)] text-[var(--warning)]">
            {preview.warnings.map((warning, index) => <li key={index}>{warningText(warning)}</li>)}
          </ul>
        )}
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 font-mono text-[length:var(--text-11)] leading-relaxed">
          {preview?.sql || t('development.database.schema.no_changes')}
        </pre>
      </Modal>

      <CreateTableDialog open={createOpen} onClose={() => setCreateOpen(false)} onConfirm={async (name, columns) => {
        const built = buildCreateTableSql(name, columns)
        try {
          await driver.query(built.sql)
          onSchemaChanged?.()
          onTableCreated?.(name.trim())
          setCreateOpen(false)
        } catch (cause) {
          onError(cause instanceof Error ? cause.message : String(cause))
        }
      }} />
    </div>
  )
}

function columnDefinition(draft: ColumnDraft): string {
  const parts = [quoteIdent(draft.name.trim()), draft.type.trim() || 'TEXT']
  if (draft.pk) parts.push('PRIMARY KEY')
  if (draft.notNull) parts.push('NOT NULL')
  if (draft.unique) parts.push('UNIQUE')
  if (draft.default !== '') parts.push(`DEFAULT ${draft.default}`)
  return parts.join(' ')
}

function CreateTableDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  onConfirm: (name: string, columns: ColumnDraft[]) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [columns, setColumns] = useState<ColumnDraft[]>([
    { id: 'c1', name: 'id', type: 'INTEGER', notNull: false, pk: true, unique: false, default: '', isNew: true, deleted: false },
    { id: 'c2', name: 'name', type: 'TEXT', notNull: false, pk: false, unique: false, default: '', isNew: true, deleted: false },
  ])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName('')
    setColumns([
      { id: 'c1', name: 'id', type: 'INTEGER', notNull: false, pk: true, unique: false, default: '', isNew: true, deleted: false },
      { id: 'c2', name: 'name', type: 'TEXT', notNull: false, pk: false, unique: false, default: '', isNew: true, deleted: false },
    ])
  }, [open])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.database.schema.create_table')}
      width={520}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" disabled={!name.trim() || busy} onClick={() => {
            setBusy(true)
            void onConfirm(name, columns).finally(() => setBusy(false))
          }}>{busy ? <Loader2 size={13} className="animate-spin" /> : null}{t('development.database.schema.create')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('development.database.schema.table_name')} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('development.database.schema.table_name_placeholder')} />
        </Field>
        <div className="space-y-1.5">
          {columns.map((column) => (
            <div key={column.id} className="grid grid-cols-[1fr_1.2fr_auto_auto] items-center gap-1.5">
              <Input value={column.name} onChange={(event) => setColumns((current) => current.map((entry) => entry.id === column.id ? { ...entry, name: event.target.value } : entry))} placeholder={t('development.database.schema.name')} className="h-7" />
              <SelectMenu label={t('development.database.schema.type')} value={column.type} options={COMMON_TYPES.map((type) => ({ value: type, label: type }))} onChange={(value) => setColumns((current) => current.map((entry) => entry.id === column.id ? { ...entry, type: value } : entry))} size="sm" />
                <Checkbox checked={column.pk} onChange={(next) => setColumns((current) => current.map((entry) => entry.id === column.id ? { ...entry, pk: next } : entry))} label={t('development.database.schema.primary_key')} />
              <IconButton label={t('development.database.schema.delete_column')} size="xs" onClick={() => setColumns((current) => current.filter((entry) => entry.id !== column.id))}><Trash2 size={12} /></IconButton>
            </div>
          ))}
          <Button variant="secondary" size="sm" className="w-full" onClick={() => setColumns((current) => [...current, { ...emptyDraft(), id: `c${Date.now()}` }])}><Plus size={13} />{t('development.database.schema.add_column')}</Button>
        </div>
      </div>
    </Modal>
  )
}
