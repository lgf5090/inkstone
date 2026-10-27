import { useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { Button } from '../../../components/primitives'
import { Input, Segmented } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { SelectMenu } from '../../../components/select-menu'
import { transformValue, type TransformKind, type TransformOptions } from './transform-value'

const KINDS: TransformKind[] = ['upper', 'lower', 'trim', 'json', 'unixToDate', 'dateToUnix', 'baseConvert']

export interface CellTransformDialogProps {
  open: boolean
  column: string
  value: unknown
  onClose: () => void
}

export function CellTransformDialog({ open, column, value, onClose }: CellTransformDialogProps) {
  const [kind, setKind] = useState<TransformKind>('upper')
  const [unit, setUnit] = useState<'s' | 'ms'>('s')
  const [fromBase, setFromBase] = useState('10')
  const [toBase, setToBase] = useState('16')
  const [copied, setCopied] = useState(false)

  const source = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)

  const result = useMemo(() => {
    const options: TransformOptions = {
      kind,
      unit,
      ...(kind === 'baseConvert'
        ? { fromBase: Number(fromBase) || 0, toBase: Number(toBase) || 0 }
        : {}),
    }
    return transformValue(value, options)
  }, [kind, unit, fromBase, toBase, value])

  const copy = async () => {
    if (!result.ok) return
    const ok = await copyText(result.text)
    setCopied(ok)
    if (ok) setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.database.grid.transform_title', { column })}
      description={t('development.database.grid.transform_preview_hint')}
      width={520}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('development.database.common.cancel')}</Button>
          <Button size="sm" onClick={() => void copy()} disabled={!result.ok}>
            <Copy size={13} />
            {copied ? t('development.database.grid.transform_copied') : t('development.database.grid.transform_copy')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.grid.transform_source')}</div>
          <pre className="max-h-24 overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-11)] text-[var(--text-secondary)] whitespace-pre-wrap break-words">{source || t('development.database.grid.distinct_null')}</pre>
        </div>
        <div>
          <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.grid.transform_kind')}</div>
          <SelectMenu
            value={kind}
            onChange={(next) => setKind(next as TransformKind)}
            label={t('development.database.grid.transform_kind')}
            options={KINDS.map((entry) => ({ value: entry, label: t(`development.database.grid.transform_kind_${entry}`) }))}
          />
        </div>
        {(kind === 'unixToDate' || kind === 'dateToUnix') && (
          <Segmented
            value={unit}
            onChange={setUnit}
            label={t('development.database.grid.transform_unit')}
            options={[
              { value: 's', label: t('development.database.grid.transform_unit_s') },
              { value: 'ms', label: t('development.database.grid.transform_unit_ms') },
            ]}
          />
        )}
        {kind === 'baseConvert' && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-0.5 block text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.grid.transform_from_base')}</span>
              <Input value={fromBase} onChange={(event) => setFromBase(event.target.value)} className="h-8 font-mono" inputMode="numeric" />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.grid.transform_to_base')}</span>
              <Input value={toBase} onChange={(event) => setToBase(event.target.value)} className="h-8 font-mono" inputMode="numeric" />
            </label>
          </div>
        )}
        <div>
          <div className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.database.grid.transform_result')}</div>
          {result.ok ? (
            <pre className="max-h-48 overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 font-mono text-[length:var(--text-12)] text-[var(--text-primary)] whitespace-pre-wrap break-words">{result.text || '—'}</pre>
          ) : (
            <p role="alert" className="rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-2 text-[length:var(--text-11)] text-[var(--danger)]">
              {t(`development.database.grid.transform_error_${result.error}`)}
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}
