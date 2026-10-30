import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Table2, Trash2, XCircle } from 'lucide-react'
import type { ParsedTable } from '@shared/development/database/types'
import { quoteIdent } from '@shared/development/database/sql-utils'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Checkbox, Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import type { StudioDriver } from './drivers'

type Operation = 'drop' | 'empty'
type Status = 'idle' | 'running' | 'done' | 'failed'

export interface MassDropPanelProps {
  driver: StudioDriver
  tables: ParsedTable[]
  onSchemaChanged: () => void
  ensureWritable?: () => Promise<boolean>
  onError: (message: string) => void
}

export function MassDropPanel({ driver, tables, onSchemaChanged, ensureWritable, onError }: MassDropPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [operation, setOperation] = useState<Operation | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [running, setRunning] = useState(false)

  useEffect(() => {
    setSelected(new Set())
    setStatus({})
  }, [tables])

  const allSelected = tables.length > 0 && selected.size === tables.length
  const perform = async () => {
    if (!operation || running || confirmText !== 'confirm') return
    if (ensureWritable && !(await ensureWritable())) return
    setRunning(true)
    const names = [...selected]
    for (const name of names) {
      setStatus((current) => ({ ...current, [name]: 'running' }))
      try {
        await driver.query(operation === 'drop' ? `DROP TABLE ${quoteIdent(name)}` : `DELETE FROM ${quoteIdent(name)}`)
        setStatus((current) => ({ ...current, [name]: 'done' }))
      } catch (cause) {
        setStatus((current) => ({ ...current, [name]: 'failed' }))
        onError(t('development.database.mass.failed_row', { table: name, message: cause instanceof Error ? cause.message : String(cause) }))
      }
    }
    setRunning(false)
    setOperation(null)
    setConfirmText('')
    if (operation === 'drop') onSchemaChanged()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
        <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('development.database.mass.title')}</h3>
        <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.mass.description')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
        <Button variant="secondary" size="sm" className="text-[var(--danger)]" disabled={selected.size === 0 || running} onClick={() => { setOperation('drop'); setConfirmText('') }}>
          <Trash2 size={14} />
          {t('development.database.mass.drop_selected', { count: selected.size })}
        </Button>
        <Button variant="secondary" size="sm" disabled={selected.size === 0 || running} onClick={() => { setOperation('empty'); setConfirmText('') }}>
          <Table2 size={14} />
          {t('development.database.mass.empty_selected', { count: selected.size })}
        </Button>
        <div className="flex-1" />
        {selected.size > 0 && !running && (
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>{t('development.database.common.clear')}</Button>
        )}
        {running && <Loader2 size={14} className="animate-spin text-[var(--text-tertiary)]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {tables.length === 0 ? (
          <div className="flex h-full items-center justify-center py-16 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.database.mass.no_tables')}</div>
        ) : (
          <table className="w-full text-[length:var(--text-12)]">
            <thead className="sticky top-0 z-10 bg-[var(--bg-sunken)]">
              <tr className="border-b border-[var(--border-subtle)] text-left text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                <th className="w-10 px-2 py-1.5">
                  <Checkbox
                    checked={allSelected}
                    ariaLabel={t('development.database.mass.select_all')}
                    onChange={(next) => setSelected(next ? new Set(tables.map((table) => table.name)) : new Set())}
                  />
                </th>
                <th className="px-2 py-1.5">{t('development.database.mass.table')}</th>
                <th className="px-2 py-1.5">{t('development.database.mass.columns')}</th>
                <th className="px-2 py-1.5">{t('development.database.mass.status')}</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((table) => {
                const state = status[table.name] ?? 'idle'
                return (
                  <tr key={table.name} className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]">
                    <td className="px-2 py-1.5">
                      <Checkbox
                        checked={selected.has(table.name)}
                        ariaLabel={table.name}
                        onChange={(next) => setSelected((current) => {
                          const set = new Set(current)
                          if (next) set.add(table.name)
                          else set.delete(table.name)
                          return set
                        })}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="flex items-center gap-1.5"><Table2 size={13} className="text-[var(--text-tertiary)]" /><span className="truncate font-mono">{table.name}</span></span>
                    </td>
                    <td className="px-2 py-1.5 text-[var(--text-tertiary)]">{table.columns.length}</td>
                    <td className="px-2 py-1.5">
                      {state === 'idle' && <span className="text-[var(--text-quaternary)]">—</span>}
                      {state === 'running' && <span className="flex items-center gap-1 text-[var(--warning)]"><Loader2 size={12} className="animate-spin" />{t('development.database.mass.running')}</span>}
                      {state === 'done' && <span className="flex items-center gap-1 text-[var(--success)]"><CheckCircle2 size={12} />{t('development.database.mass.done')}</span>}
                      {state === 'failed' && <span className="flex items-center gap-1 text-[var(--danger)]"><XCircle size={12} />{t('development.database.mass.failed')}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={operation !== null}
        onClose={() => { if (!running) setOperation(null) }}
        title={operation === 'drop' ? t('development.database.mass.confirm_drop_title', { count: selected.size }) : t('development.database.mass.confirm_empty_title', { count: selected.size })}
        width={460}
        dismissible={!running}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOperation(null)} disabled={running}>{t('development.database.common.cancel')}</Button>
            <Button variant="danger" size="sm" onClick={() => void perform()} disabled={confirmText !== 'confirm' || running}>
              {running && <Loader2 size={13} className="animate-spin" />}
              {operation === 'drop' ? t('development.database.mass.drop') : t('development.database.mass.empty')}
            </Button>
          </>
        }
      >
        <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">
          {operation === 'drop' ? t('development.database.mass.confirm_drop_description') : t('development.database.mass.confirm_empty_description')}
        </p>
        <div className="my-2 flex flex-wrap gap-1">
          {[...selected].map((name) => <span key={name} className="rounded bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[length:var(--text-11)]">{name}</span>)}
        </div>
        <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.mass.type_confirm')}</p>
        <Input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} placeholder={t('development.database.mass.confirm_placeholder')} autoFocus />
      </Modal>
    </div>
  )
}
