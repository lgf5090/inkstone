import { useMemo, useState } from 'react'
import { Loader2, Wand2 } from 'lucide-react'
import type { ParsedColumn, ParsedTable } from '@shared/development/database/types'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import { useUi } from '../../../store/ui'
import type { StudioDriver } from './drivers'
import { generateRows, type GenConfig, type GenKind } from './data-generate'
import { insertRowsInChunks } from './transfer-ops'

const KINDS: GenKind[] = ['skip', 'sequence', 'integer', 'real', 'text', 'uuid', 'email', 'ip', 'date', 'bool', 'enum']

function defaultsFor(column: ParsedColumn, ordinal: number): GenConfig {
  if (column.pk && column.autoIncrement) return { kind: 'skip' }
  if (column.pk) return { kind: 'sequence', start: ordinal * 1_000_000 + 1 }
  const type = column.type.toUpperCase()
  if (/INT/.test(type)) return { kind: 'integer', min: 1, max: 1000 }
  if (/REAL|FLOA|DOUB|NUM/.test(type)) return { kind: 'real', min: 0, max: 1000, decimals: 2 }
  if (/DATE/.test(type)) return { kind: 'date' }
  if (/BOOL/.test(type)) return { kind: 'bool' }
  return { kind: 'text', length: 8 }
}

export interface DataGenerateDialogProps {
  open: boolean
  table: ParsedTable
  driver: StudioDriver
  ensureWritable?: () => Promise<boolean>
  onClose: () => void
  onGenerated: () => void
  onError: (message: string) => void
}

export function DataGenerateDialog({ open, table, driver, ensureWritable, onClose, onGenerated, onError }: DataGenerateDialogProps) {
  const [count, setCount] = useState('10')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [configs, setConfigs] = useState<Record<string, GenConfig>>(() => {
    const initial: Record<string, GenConfig> = {}
    table.columns.forEach((column, index) => { initial[column.name] = defaultsFor(column, index) })
    return initial
  })

  const active = useMemo(() => table.columns.filter((column) => (configs[column.name]?.kind ?? 'skip') !== 'skip'), [configs, table.columns])

  const setConfig = (name: string, patch: Partial<GenConfig>) => {
    setConfigs((current) => ({ ...current, [name]: { ...current[name]!, ...patch } }))
  }

  const run = async () => {
    const total = Math.max(1, Math.min(1000, Math.trunc(Number(count)) || 1))
    if (active.length === 0 || running) return
    if (ensureWritable && !(await ensureWritable())) return
    setRunning(true)
    const columns = active.map((column) => column.name)
    const rows = generateRows(active.map((column) => ({ name: column.name, config: configs[column.name]! })), total)
    try {
      const outcome = await insertRowsInChunks(driver, table.name, columns, rows, (done) => {
        setProgress({ done, total })
      })
      if (outcome.failed > 0) {
        onGenerated()
        onError(t('development.database.generate.partial', {
          done: outcome.inserted,
          total,
          message: outcome.errors[0] ?? '',
        }))
        return
      }
      useUi.getState().toast({ title: t('development.database.generate.done', { count: total }), tone: 'success' })
      onGenerated()
      onClose()
    } catch (error) {
      onError(t('development.database.generate.partial', {
        done: 0,
        total,
        message: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!running) onClose() }}
      title={t('development.database.generate.title', { table: table.name })}
      description={t('development.database.generate.hint')}
      width={640}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={running}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" onClick={() => void run()} disabled={running || active.length === 0}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
            {t('development.database.generate.run')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="flex items-center gap-2">
          <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('development.database.generate.rows')}</span>
          <Input value={count} onChange={(event) => setCount(event.target.value)} className="h-8 w-24" inputMode="numeric" aria-label={t('development.database.generate.rows')} />
          <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.generate.rows_hint')}</span>
        </label>
        <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
          {table.columns.map((column) => {
            const config = configs[column.name] ?? { kind: 'skip' }
            return (
              <div key={column.name} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11)] text-[var(--text-primary)]" title={column.name}>{column.name}</span>
                  <span className="shrink-0 font-mono text-[length:var(--text-10)] text-[var(--text-tertiary)]">{column.type || 'TEXT'}</span>
                  <SelectMenu
                    label={`${column.name} ${t('development.database.generate.kind')}`}
                    value={config.kind}
                    options={KINDS.map((kind) => ({ value: kind, label: t(`development.database.generate.kind_${kind}`) }))}
                    onChange={(kind) => setConfig(column.name, { kind })}
                    width={180}
                    size="sm"
                  />
                </div>
                {config.kind === 'sequence' && (
                  <div className="mt-1.5 flex gap-2">
                    <Input value={String(config.start ?? 1)} onChange={(event) => setConfig(column.name, { start: Number(event.target.value) || 0 })} className="h-7 w-20" aria-label={`${column.name} start`} />
                    <Input value={String(config.step ?? 1)} onChange={(event) => setConfig(column.name, { step: Number(event.target.value) || 0 })} className="h-7 w-20" aria-label={`${column.name} step`} />
                  </div>
                )}
                {(config.kind === 'integer' || config.kind === 'real') && (
                  <div className="mt-1.5 flex gap-2">
                    <Input value={String(config.min ?? 0)} onChange={(event) => setConfig(column.name, { min: Number(event.target.value) || 0 })} className="h-7 w-20" aria-label={`${column.name} min`} />
                    <Input value={String(config.max ?? 1000)} onChange={(event) => setConfig(column.name, { max: Number(event.target.value) || 0 })} className="h-7 w-20" aria-label={`${column.name} max`} />
                    {config.kind === 'real' && (
                      <Input value={String(config.decimals ?? 2)} onChange={(event) => setConfig(column.name, { decimals: Number(event.target.value) || 0 })} className="h-7 w-16" aria-label={`${column.name} decimals`} />
                    )}
                  </div>
                )}
                {config.kind === 'text' && (
                  <Input value={String(config.length ?? 8)} onChange={(event) => setConfig(column.name, { length: Number(event.target.value) || 1 })} className="mt-1.5 h-7 w-20" aria-label={`${column.name} length`} />
                )}
                {config.kind === 'enum' && (
                  <Input value={(config.values ?? []).join(',')} onChange={(event) => setConfig(column.name, { values: event.target.value.split(',') })} placeholder={t('development.database.generate.enum_placeholder')} className="mt-1.5 h-7" aria-label={`${column.name} values`} />
                )}
              </div>
            )
          })}
        </div>
        {progress && (
          <div className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]" role="status">
            <Loader2 size={12} className="animate-spin" />
            {t('development.database.generate.progress', { done: progress.done, total: progress.total })}
          </div>
        )}
      </div>
    </Modal>
  )
}
