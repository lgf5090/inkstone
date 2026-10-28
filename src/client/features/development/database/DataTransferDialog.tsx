import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRightLeft, Loader2 } from 'lucide-react'
import type { DatabaseConnectionView, SchemaModel } from '@shared/development/database/types'
import { quoteIdent } from '@shared/development/database/sql-utils'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Checkbox, Segmented } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import { useUi } from '../../../store/ui'
import { createDriver, type StudioDriver } from './drivers'
import { buildRowInsert } from './transfer-ops'
import { loadGuards } from './guards'

type Mode = 'both' | 'structure' | 'data'
type Status = { state: 'pending' | 'running' | 'done' | 'failed'; rows?: number; message?: string }

export interface DataTransferDialogProps {
  open: boolean
  sourceDriver: StudioDriver
  sourceLabel: string
  sourceConnectionId?: string
  schema: SchemaModel
  connections: DatabaseConnectionView[]
  onClose: () => void
  onError: (message: string) => void
}

const PAGE = 500
const ROW_CAP = 5000

export function DataTransferDialog({ open, sourceDriver, sourceLabel, sourceConnectionId, schema, connections, onClose, onError }: DataTransferDialogProps) {
  const targets = connections.filter((connection) => connection.id !== sourceConnectionId)
  const [targetId, setTargetId] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [mode, setMode] = useState<Mode>('both')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [progress, setProgress] = useState<{ index: number; total: number; table: string } | null>(null)
  const cancelRef = useRef(false)

  const tableNames = useMemo(() => schema.tables.map((table) => table.name), [schema.tables])

  useEffect(() => {
    if (!open) return
    setSelected(new Set(tableNames))
    setStatus({})
    setTargetId('')
  }, [open, tableNames])
  const chosen = tableNames.filter((name) => selected.has(name))

  const toggleAll = () => {
    setSelected((current) => current.size === tableNames.length ? new Set() : new Set(tableNames))
  }

  const run = async () => {
    const target = targets.find((connection) => connection.id === targetId)
    if (!target || chosen.length === 0 || running) return
    const guard = loadGuards()[`saved:${target.id}`]
    if (guard?.readOnly) {
      onError(t('development.database.transfer.readonly_target', { name: target.name }))
      return
    }
    cancelRef.current = false
    setRunning(true)
    const nextStatus: Record<string, Status> = {}
    for (const name of chosen) nextStatus[name] = { state: 'pending' }
    setStatus(nextStatus)
    let targetDriver: StudioDriver
    try {
      targetDriver = createDriver({ kind: 'remote', connectionId: target.id, type: target.type, label: target.name })
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
      setRunning(false)
      return
    }
    let done = 0
    let failed = 0
    try {
      for (let index = 0; index < chosen.length; index++) {
        const tableName = chosen[index]!
        if (cancelRef.current) break
        setProgress({ index, total: chosen.length, table: tableName })
        setStatus((current) => ({ ...current, [tableName]: { state: 'running' } }))
        const table = schema.tables.find((entry) => entry.name === tableName)
        let rows = 0
        try {
          if (mode !== 'data') {
            if (!table?.sql.trim()) throw new Error(t('development.database.transfer.no_definition'))
            await targetDriver.query(table.sql.trim().replace(/;+$/, ''))
          }
          if (mode !== 'structure') {
            let offset = 0
            for (;;) {
              if (cancelRef.current) break
              const page = await sourceDriver.query(`SELECT * FROM ${quoteIdent(tableName)} LIMIT ${PAGE} OFFSET ${offset}`)
              if (page.rows.length === 0) break
              for (const row of page.rows) {
                if (rows >= ROW_CAP) break
                await targetDriver.query(buildRowInsert(tableName, page.columns, row))
                rows += 1
              }
              if (rows >= ROW_CAP || page.rows.length < PAGE) break
              offset += PAGE
            }
          }
          done += 1
          setStatus((current) => ({ ...current, [tableName]: { state: 'done', rows } }))
        } catch (error) {
          failed += 1
          setStatus((current) => ({ ...current, [tableName]: { state: 'failed', message: error instanceof Error ? error.message : String(error) } }))
        }
      }
      useUi.getState().toast({
        title: t('development.database.transfer.done', { done }),
        ...(failed > 0 ? { description: t('development.database.transfer.failed_summary', { count: failed }), tone: 'warning' as const } : { tone: 'success' as const }),
      })
    } finally {
      targetDriver.close()
      setRunning(false)
      setProgress(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!running) onClose() }}
      title={t('development.database.transfer.title')}
      description={t('development.database.transfer.hint', { source: sourceLabel })}
      width={620}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={running}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" onClick={() => void run()} disabled={running || !targetId || chosen.length === 0}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <ArrowRightLeft size={13} />}
            {t('development.database.transfer.run')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {targets.length === 0 ? (
          <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.database.transfer.no_target')}</p>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.transfer.target')}</div>
                <SelectMenu
                  label={t('development.database.transfer.target')}
                  value={targetId}
                  options={targets.map((connection) => ({ value: connection.id, label: `${connection.name} · ${connection.type === 'd1' ? 'D1' : 'Turso'}` }))}
                  onChange={setTargetId}
                />
              </div>
              <Segmented
                value={mode}
                onChange={setMode}
                label={t('development.database.transfer.mode')}
                options={[
                  { value: 'both', label: t('development.database.transfer.mode_both') },
                  { value: 'structure', label: t('development.database.transfer.mode_structure') },
                  { value: 'data', label: t('development.database.transfer.mode_data') },
                ]}
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.transfer.objects', { count: chosen.length, total: tableNames.length })}</span>
                <Button variant="ghost" size="sm" onClick={toggleAll}>{t('development.database.transfer.select_all')}</Button>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] p-1">
                {tableNames.map((name) => {
                  const entry = status[name]
                  return (
                    <label key={name} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-[var(--bg-hover)]">
                      <Checkbox
                        checked={selected.has(name)}
                        onChange={(checked) => setSelected((current) => {
                          const next = new Set(current)
                          if (checked) next.add(name)
                          else next.delete(name)
                          return next
                        })}
                        ariaLabel={name}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">{name}</span>
                      {entry && (
                        <span className={entry.state === 'failed' ? 'text-[length:var(--text-10)] text-[var(--danger)]' : 'text-[length:var(--text-10)] text-[var(--text-tertiary)]'} title={entry.message}>
                          {entry.state === 'running' ? t('development.database.transfer.status_running')
                            : entry.state === 'done' ? t('development.database.transfer.status_done', { rows: entry.rows ?? 0 })
                              : entry.state === 'failed' ? t('development.database.transfer.status_failed')
                                : ''}
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            </div>

            <p className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.transfer.row_cap', { rows: ROW_CAP })}</p>
            {progress && (
              <div className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]" role="status">
                <Loader2 size={12} className="animate-spin" />
                {t('development.database.transfer.progress', { table: progress.table, index: progress.index + 1, total: progress.total })}
                <Button variant="ghost" size="sm" onClick={() => { cancelRef.current = true }}>{t('development.database.transfer.stop')}</Button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
