import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import type { SchemaModel } from '@shared/development/database/types'
import { quoteIdent } from '@shared/development/database/sql-utils'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Checkbox } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import type { StudioDriver } from './drivers'
import { downloadTextFile, toInsertSql } from './export-utils'
import { stableOrderBy } from './schema-utils'

const PAGE_SIZE = 500
const MAX_ROWS_PER_TABLE = 20_000

export interface DatabaseDumpDialogProps {
  open: boolean
  driver: StudioDriver
  schema: SchemaModel
  connectionName: string
  onClose: () => void
  onError: (message: string) => void
}

export function DatabaseDumpDialog({ open, driver, schema, connectionName, onClose, onError }: DatabaseDumpDialogProps) {
  const [includeStructure, setIncludeStructure] = useState(true)
  const [includeData, setIncludeData] = useState(true)
  const [includeObjects, setIncludeObjects] = useState(true)
  const [dropFirst, setDropFirst] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; table: string } | null>(null)

  const run = async () => {
    if (running) return
    setRunning(true)
    const parts: string[] = ['PRAGMA foreign_keys = OFF;']
    let truncated = 0
    try {
      for (let index = 0; index < schema.tables.length; index++) {
        const table = schema.tables[index]!
        setProgress({ done: index, total: schema.tables.length, table: table.name })
        if (includeStructure || includeData) parts.push(`-- ${table.name}`)
        if (dropFirst) parts.push(`DROP TABLE IF EXISTS ${quoteIdent(table.name)};`)
        if (includeStructure && table.sql.trim()) parts.push(`${table.sql.trim().replace(/;+$/, '')};`)
        if (includeData) {
          let offset = 0
          let written = 0
          const orderBy = stableOrderBy(table)
          for (;;) {
            const result = await driver.query(`SELECT * FROM ${quoteIdent(table.name)}${orderBy ? ` ${orderBy}` : ''} LIMIT ${PAGE_SIZE} OFFSET ${offset}`)
            if (result.rows.length === 0) break
            const remaining = MAX_ROWS_PER_TABLE - written
            const rows = result.rows.slice(0, Math.max(0, remaining))
            if (rows.length > 0) {
              const insert = toInsertSql(table.name, result.columns, rows)
              if (insert) parts.push(insert)
              written += rows.length
            }
            if (result.rows.length < PAGE_SIZE) break
            offset += PAGE_SIZE
            if (written >= MAX_ROWS_PER_TABLE) {
              truncated += 1
              break
            }
          }
        }
      }
      if (includeStructure) {
        for (const index of schema.indexes) {
          if (!index.sql) continue
          parts.push(`${index.sql.trim().replace(/;+$/, '')};`)
        }
      }
      if (includeObjects) {
        for (const view of schema.views) if (view.sql.trim()) parts.push(`${view.sql.trim().replace(/;+$/, '')};`)
        for (const trigger of schema.triggers) if (trigger.sql.trim()) parts.push(`${trigger.sql.trim().replace(/;+$/, '')};`)
      }
      parts.push('PRAGMA foreign_keys = ON;')
      const base = (connectionName || 'database').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-')
      downloadTextFile(`${base}.dump.sql`, `${parts.join('\n\n')}\n`, 'application/sql')
      useUi.getState().toast({
        title: t('development.database.dump.done'),
        ...(truncated > 0 ? { description: t('development.database.dump.truncated', { count: truncated }), tone: 'warning' as const } : { tone: 'success' as const }),
      })
      onClose()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!running) onClose() }}
      title={t('development.database.dump.title')}
      description={t('development.database.dump.hint', { tables: schema.tables.length })}
      width={480}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={running}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" onClick={() => void run()} disabled={running || (!includeStructure && !includeData && !includeObjects)}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {t('development.database.dump.run')}
          </Button>
        </>
      }
    >
      <div className="space-y-2.5">
        {([
          [includeStructure, setIncludeStructure, 'structure'],
          [includeData, setIncludeData, 'data'],
          [includeObjects, setIncludeObjects, 'objects'],
          [dropFirst, setDropFirst, 'drop'],
        ] as const).map(([checked, setChecked, key]) => (
          <label key={key} className="flex items-center gap-2">
            <Checkbox checked={checked} onChange={setChecked} ariaLabel={t(`development.database.dump.${key}`)} />
            <span className="text-[length:var(--text-12)] text-[var(--text-primary)]">{t(`development.database.dump.${key}`)}</span>
          </label>
        ))}
        <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('development.database.dump.warning', { rows: MAX_ROWS_PER_TABLE })}</p>
        {progress && (
          <div className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]" role="status">
            <Loader2 size={12} className="animate-spin" />
            {t('development.database.dump.progress', { done: progress.done, total: progress.total, table: progress.table })}
          </div>
        )}
      </div>
    </Modal>
  )
}
