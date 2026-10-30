import { useEffect, useRef, useState } from 'react'
import { Copy, Download, GitCompare, Loader2 } from 'lucide-react'
import type { DatabaseConnectionView, SchemaModel } from '@shared/development/database/types'
import { MAX_QUERY_ROWS } from '@shared/development/database/types'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { Button } from '../../../components/primitives'
import { Segmented } from '../../../components/form'
import { Modal, confirm } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import { useUi } from '../../../store/ui'
import { createDriver, type StudioDriver } from './drivers'
import { loadSchema } from './schema-utils'
import { diffSchemas, objectDiffStatements, schemaStatements, type TableShape } from './schema-diff'
import { diffRows } from './data-diff'
import { quoteIdent } from '@shared/development/database/sql-utils'
import { downloadTextFile } from './export-utils'
import { loadGuards } from './guards'

type Mode = 'schema' | 'data'

function shapesOf(schema: SchemaModel): TableShape[] {
  return schema.tables.map((table) => ({
    name: table.name,
    sql: table.sql,
    columns: table.columns.map((column) => ({ name: column.name, type: column.type, notNull: column.notNull, pk: column.pk })),
  }))
}

export interface CompareDialogProps {
  open: boolean
  sourceDriver: StudioDriver
  sourceLabel: string
  sourceConnectionId?: string
  sourceSchema: SchemaModel
  connections: DatabaseConnectionView[]
  onClose: () => void
  onError: (message: string) => void
}

interface CompareResult {
  statements: string[]
  summary: string
  truncated?: boolean
  manual?: boolean
}

export function CompareDialog({ open, sourceDriver, sourceLabel, sourceConnectionId, sourceSchema, connections, onClose, onError }: CompareDialogProps) {
  const targets = connections.filter((connection) => connection.id !== sourceConnectionId)
  const [mode, setMode] = useState<Mode>('schema')
  const [targetId, setTargetId] = useState('')
  const [tableName, setTableName] = useState('')
  const [keys, setKeys] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<CompareResult | null>(null)
  const [localTarget, setLocalTarget] = useState<{ name: string; file: File } | null>(null)
  const localDriverRef = useRef<StudioDriver | null>(null)
  const localInput = useRef<HTMLInputElement>(null)

  const table = sourceSchema.tables.find((entry) => entry.name === tableName) ?? sourceSchema.tables[0] ?? null
  const keyCandidates = table?.columns.map((column) => column.name) ?? []

  useEffect(() => {
    if (mode !== 'data') return
    const primary = table?.columns.filter((column) => column.pk).map((column) => column.name) ?? []
    setKeys(primary)
    setResult(null)
  }, [mode, table?.name])

  useEffect(() => {
    if (open) return
    localDriverRef.current?.close()
    localDriverRef.current = null
  }, [open])

  const makeTargetDriver = (): StudioDriver | null => {
    if (localTarget) {
      if (!localDriverRef.current) localDriverRef.current = createDriver({ kind: 'local', label: localTarget.name, file: localTarget.file })
      return localDriverRef.current
    }
    const target = targets.find((connection) => connection.id === targetId)
    if (!target) return null
    return createDriver({ kind: 'remote', connectionId: target.id, type: target.type, label: target.name })
  }

  const compare = async () => {
    if (running) return
    setRunning(true)
    setResult(null)
    let targetDriver: StudioDriver | null = null
    let closeAfter = false
    try {
      targetDriver = makeTargetDriver()
      if (!targetDriver) return
      closeAfter = !localTarget
      if (mode === 'schema') {
        const targetSchema = await loadSchema(targetDriver)
        const diffs = diffSchemas(shapesOf(sourceSchema), shapesOf(targetSchema))
        const statements = schemaStatements(diffs, shapesOf(sourceSchema))
        statements.push(...objectDiffStatements(sourceSchema, targetSchema))
        const missing = diffs.filter((diff) => diff.missingInTarget).length
        const added = diffs.reduce((total, diff) => total + diff.addedColumns.length, 0)
        const changed = diffs.filter((diff) => diff.typeChanges.length > 0 || diff.removedColumns.length > 0 || diff.constraintChanges.length > 0).length
        const manual = changed > 0
        setResult({
          statements,
          summary: t('development.database.compare.schema_summary', { missing, added, changed }),
          ...(manual ? { manual: true } : {}),
        })
      } else {
        if (!table) return
        const keysToUse = keys.length > 0 ? keys : table.columns.filter((column) => column.pk).map((column) => column.name)
        if (keysToUse.length === 0) {
          onError(t('development.database.compare.need_key'))
          return
        }
        const orderBy = keysToUse.map(quoteIdent).join(', ')
        const rowSql = `SELECT * FROM ${quoteIdent(table.name)} ORDER BY ${orderBy} LIMIT ${MAX_QUERY_ROWS}`
        const sourceRows = await sourceDriver.query(rowSql)
        const targetRows = await targetDriver.query(rowSql)
        const truncated = Boolean(sourceRows.truncated || targetRows.truncated)
        const diff = diffRows({
          table: table.name,
          keyColumns: keysToUse,
          sourceColumns: sourceRows.columns,
          sourceRows: sourceRows.rows,
          targetColumns: targetRows.columns,
          targetRows: targetRows.rows,
        }, { allowDeletes: !truncated })
        setResult({
          statements: [...diff.inserts, ...diff.updates, ...diff.deletes],
          summary: t('development.database.compare.data_summary', { inserts: diff.inserts.length, updates: diff.updates.length, deletes: diff.deletes.length }),
          ...(truncated ? { truncated: true } : {}),
        })
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      if (closeAfter) targetDriver?.close()
      setRunning(false)
    }
  }

  const apply = async () => {
    const target = targets.find((connection) => connection.id === targetId)
    if ((!localTarget && !target) || !result || result.statements.length === 0 || applying) return
    if (target && !localTarget) {
      const guard = loadGuards()[`saved:${target.id}`]
      if (guard?.readOnly) {
        onError(t('development.database.transfer.readonly_target', { name: target.name }))
        return
      }
      if (guard?.production) {
        const proceed = await confirm({
          title: t('development.database.guard.prod_title', { name: target.name }),
          description: t('development.database.guard.prod_description'),
          confirmLabel: t('development.database.guard.prod_confirm'),
          tone: 'danger',
        })
        if (!proceed) return
      }
    }
    const ok = await confirm({
      title: t('development.database.compare.apply_title', { count: result.statements.length }),
      description: t('development.database.compare.apply_description'),
      confirmLabel: t('development.database.compare.apply'),
      tone: 'danger',
    })
    if (!ok) return
    setApplying(true)
    let targetDriver: StudioDriver | null = null
    let closeAfter = false
    let done = 0
    try {
      targetDriver = makeTargetDriver()
      if (!targetDriver) return
      closeAfter = !localTarget
      for (const statement of result.statements) {
        await targetDriver.query(statement)
        done += 1
      }
      useUi.getState().toast({ title: t('development.database.compare.applied', { count: done }), tone: 'success' })
      setResult(null)
    } catch (error) {
      onError(t('development.database.compare.apply_failed', { done, total: result.statements.length, message: error instanceof Error ? error.message : String(error) }))
    } finally {
      if (closeAfter) targetDriver?.close()
      setApplying(false)
    }
  }

  const copyAll = async () => {
    if (!result) return
    const ok = await copyText(result.statements.join('\n'))
    useUi.getState().toast({ title: ok ? t('development.database.common.copied') : t('development.database.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!running && !applying) onClose() }}
      title={t('development.database.compare.title')}
      description={t('development.database.compare.hint', { source: sourceLabel })}
      width={680}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={running || applying}>{t('development.database.common.cancel')}</Button>
          {result && (
            <>
              <Button variant="ghost" size="sm" onClick={() => void copyAll()}>
                <Copy size={13} />
                {t('development.database.common.copy')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => downloadTextFile('compare.sql', `${result.statements.join('\n')}\n`, 'application/sql')} disabled={result.statements.length === 0}>
                <Download size={13} />
                {t('development.database.compare.download')}
              </Button>
              <Button size="sm" onClick={() => void apply()} disabled={applying || result.statements.length === 0}>
                {applying ? <Loader2 size={13} className="animate-spin" /> : <GitCompare size={13} />}
                {t('development.database.compare.apply')}
              </Button>
            </>
          )}
          {!result && (
            <Button size="sm" onClick={() => void compare()} disabled={running || (!targetId && !localTarget)}>
              {running ? <Loader2 size={13} className="animate-spin" /> : <GitCompare size={13} />}
              {t('development.database.compare.run')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.compare.target')}</div>
            <SelectMenu
              label={t('development.database.compare.target')}
              value={targetId}
              options={targets.map((connection) => ({ value: connection.id, label: `${connection.name} · ${connection.type === 'd1' ? 'D1' : 'Turso'}` }))}
              onChange={(value) => { setTargetId(value); setResult(null) }}
            />
          </div>
          <div className="flex flex-col items-start gap-1">
            <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.compare.or_local')}</span>
            <Button variant="secondary" size="sm" onClick={() => localInput.current?.click()}>
              {localTarget ? localTarget.name : t('development.database.compare.local_file')}
            </Button>
            <input ref={localInput} type="file" accept=".db,.sqlite,.sqlite3,.db3" className="hidden" onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              localDriverRef.current?.close()
              localDriverRef.current = null
              setLocalTarget({ name: file.name, file })
              setTargetId('')
              setResult(null)
            }} />
          </div>
          <Segmented
            value={mode}
            onChange={(value) => { setMode(value); setResult(null) }}
            label={t('development.database.compare.mode')}
            options={[
              { value: 'schema', label: t('development.database.compare.mode_schema') },
              { value: 'data', label: t('development.database.compare.mode_data') },
            ]}
          />
        </div>

        {mode === 'data' && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1">
              <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.compare.table')}</div>
              <SelectMenu
                label={t('development.database.compare.table')}
                value={table?.name ?? ''}
                options={sourceSchema.tables.map((entry) => ({ value: entry.name, label: entry.name }))}
                onChange={(value) => { setTableName(value); setKeys([]); setResult(null) }}
              />
            </div>
            <div className="min-w-48 flex-1">
              <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.compare.keys', { count: keys.length })}</div>
              <div className="flex flex-wrap gap-1">
                {keyCandidates.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={keys.includes(candidate)}
                    onClick={() => { setKeys((current) => current.includes(candidate) ? current.filter((item) => item !== candidate) : [...current, candidate]); setResult(null) }}
                    className={keys.includes(candidate) ? 'rounded bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[length:var(--text-10)] text-[var(--accent)]' : 'rounded bg-[var(--bg-sunken)] px-1.5 py-0.5 font-mono text-[length:var(--text-10)] text-[var(--text-tertiary)]'}
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {targets.length === 0 && (
          <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.database.transfer.no_target')}</p>
        )}

        {result && (
          <div className="space-y-2">
            <p className="text-[length:var(--text-12)] text-[var(--text-primary)]">{result.summary}</p>
            {result.truncated && (
              <p role="status" className="rounded-[var(--r-md)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-2 text-[length:var(--text-11)] leading-relaxed text-[var(--warning)]">
                {t('development.database.compare.truncated_note', { rows: MAX_QUERY_ROWS })}
              </p>
            )}
            {result.manual && (
              <p role="status" className="rounded-[var(--r-md)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-2 text-[length:var(--text-11)] leading-relaxed text-[var(--warning)]">
                {t('development.database.compare.manual_rebuild_note')}
              </p>
            )}
            <pre className="max-h-64 overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-10)] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-all">{result.statements.join('\n') || t('development.database.compare.no_changes')}</pre>
            <p className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.compare.apply_hint')}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
