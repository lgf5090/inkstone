import { useEffect, useMemo, useState } from 'react'
import { Code2, Copy } from 'lucide-react'
import type { ParsedTable } from '@shared/development/database/types'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import { useUi } from '../../../store/ui'

export interface StructurePeekDialogProps {
  open: boolean
  tables: ParsedTable[]
  onClose: () => void
  onOpenSql?: (sql: string) => void
}

export function StructurePeekDialog({ open, tables, onClose, onOpenSql }: StructurePeekDialogProps) {
  const [selected, setSelected] = useState('')

  useEffect(() => {
    if (!open) return
    setSelected((current) => current && tables.some((table) => table.name === current) ? current : (tables[0]?.name ?? ''))
  }, [open, tables])

  const table = useMemo(() => tables.find((entry) => entry.name === selected) ?? null, [tables, selected])

  const copySql = async () => {
    if (!table?.sql) return
    const ok = await copyText(table.sql)
    useUi.getState().toast({ title: ok ? t('development.database.common.copied') : t('development.database.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.database.query.peek_title')}
      description={t('development.database.query.peek_hint')}
      width={620}
      footer={
        <>
          {table?.sql && onOpenSql && (
            <Button variant="ghost" size="sm" onClick={() => { onOpenSql(table.sql); onClose() }}>
              <Code2 size={13} />
              {t('development.database.query.peek_open_sql')}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => void copySql()} disabled={!table?.sql}>
            <Copy size={13} />
            {t('development.database.common.copy')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('development.database.common.cancel')}</Button>
        </>
      }
    >
      {tables.length === 0 ? (
        <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.database.app.no_objects')}</p>
      ) : (
        <div className="space-y-3">
          <SelectMenu
            label={t('development.database.query.peek_table')}
            value={selected}
            options={tables.map((entry) => ({ value: entry.name, label: entry.name }))}
            onChange={setSelected}
          />
          <div className="max-h-72 overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
            <table className="w-full border-collapse text-[length:var(--text-11)]">
              <thead className="sticky top-0 bg-[var(--bg-sunken)] text-left text-[var(--text-tertiary)]">
                <tr>
                  <th className="px-2 py-1 font-medium">{t('development.database.schema.name')}</th>
                  <th className="px-2 py-1 font-medium">{t('development.database.schema.type')}</th>
                  <th className="px-2 py-1 font-medium">{t('development.database.schema.pk')}</th>
                  <th className="px-2 py-1 font-medium">{t('development.database.schema.not_null')}</th>
                  <th className="px-2 py-1 font-medium">{t('development.database.schema.default')}</th>
                </tr>
              </thead>
              <tbody>
                {(table?.columns ?? []).map((column) => (
                  <tr key={column.name} className="border-t border-[var(--border-subtle)]">
                    <td className="px-2 py-1 font-mono text-[var(--text-primary)]">{column.name}</td>
                    <td className="px-2 py-1 font-mono text-[var(--text-secondary)]">{column.type || '—'}</td>
                    <td className="px-2 py-1 text-[var(--text-secondary)]">{column.pk ? 'PK' : ''}</td>
                    <td className="px-2 py-1 text-[var(--text-secondary)]">{column.notNull ? 'NOT NULL' : ''}</td>
                    <td className="max-w-40 truncate px-2 py-1 font-mono text-[var(--text-secondary)]" title={column.default ?? ''}>{column.default ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  )
}
