/**
 * The result and feature dialogs the accounts screen shares.
 *
 * A batch result is one shape whether it came from a test, a feature write or a delete, so one table
 * and one summary render all of them. The import dialog reuses the same table with the email as its
 * first column.
 */
import { useEffect, useState } from 'react'
import {
  CLOUDFLARE_FEATURES,
  type CloudflareAccount,
  type CloudflareFeature,
} from '@shared/cloudflare/model'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { Badge, Button } from '../../../../components/primitives'
import { Checkbox } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { Table, TableScroll, TBody, Td, THead, Th, Tr } from '../../components/Table'
import { accountsApi, type BatchItemResult, type BatchStatus, type BatchSummary } from '../../api/accounts'
import { cfErrorText } from '../../api/client'
import { cfT } from '../../i18n'
import { enabledFeatures, featureLabel, resultStatusLabel, resultStatusTone } from './labels'

export interface ResultRow {
  /** The email for an import, the account id for a batch operation. */
  key: string
  name: string
  status: BatchStatus
  message?: string
}

export function toResultRows(items: readonly BatchItemResult[]): ResultRow[] {
  return items.map((item) => ({
    key: item.id,
    name: item.name,
    status: item.status,
    ...(item.message ? { message: item.message } : {}),
  }))
}

export function SummaryCounts({ summary }: { summary: BatchSummary }) {
  return (
    <div className="flex flex-wrap gap-6">
      <p className="m-0 text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
        {cfT('cloudflare.accounts.table.total_items', { count: summary.total })}
      </p>
      <Count label={resultStatusLabel('success')} value={summary.success} tone="text-[var(--success)]" />
      <Count label={resultStatusLabel('skipped')} value={summary.skipped} tone="text-[var(--warning)]" />
      <Count label={resultStatusLabel('error')} value={summary.error} tone="text-[var(--danger)]" />
    </div>
  )
}

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div>
      <span className="block text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{label}</span>
      <p className={`m-0 text-[length:var(--text-15)] font-semibold ${tone}`}>{value}</p>
    </div>
  )
}

export function ResultTable({
  rows,
  firstColumn,
  label,
}: {
  rows: readonly ResultRow[]
  firstColumn: 'id' | 'email'
  label: string
}) {
  return (
    <TableScroll label={label}>
      <Table>
        <caption className="sr-only">{label}</caption>
        <THead>
          <Tr>
            <Th>{cfT(firstColumn === 'email' ? 'cloudflare.accounts.table.email' : 'cloudflare.accounts.table.id')}</Th>
            <Th>{cfT('cloudflare.accounts.table.name')}</Th>
            <Th>{cfT('cloudflare.accounts.table.status')}</Th>
            <Th>{t('email.a11y.message')}</Th>
          </Tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.key}>
              <Td className="max-w-52 truncate">{row.key}</Td>
              <Td>{row.name || '—'}</Td>
              <Td>
                <Badge tone={resultStatusTone(row.status)}>{resultStatusLabel(row.status)}</Badge>
              </Td>
              <Td className="max-w-56 truncate text-[var(--text-tertiary)]" title={row.message}>
                {row.message || '—'}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </TableScroll>
  )
}

export function BatchResultDialog({
  open,
  title,
  summary,
  rows,
  onClose,
}: {
  open: boolean
  title: string
  summary: BatchSummary
  rows: readonly ResultRow[]
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={720}
      footer={<Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="grid gap-3">
        <SummaryCounts summary={summary} />
        <ResultTable rows={rows} firstColumn="id" label={title} />
      </div>
    </Modal>
  )
}

export function BatchFeaturesDialog({
  open,
  count,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean
  count: number
  busy: boolean
  onClose: () => void
  onConfirm: (enabledFeatures: string) => void
}) {
  const [features, setFeatures] = useState<CloudflareFeature[]>([...CLOUDFLARE_FEATURES])

  useEffect(() => {
    if (open) setFeatures([...CLOUDFLARE_FEATURES])
  }, [open])

  function toggle(feature: CloudflareFeature, next: boolean): void {
    setFeatures((previous) => {
      if (next) return previous.includes(feature) ? previous : [...previous, feature]
      return previous.filter((item) => item !== feature)
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={cfT('cloudflare.accounts.batch_features_modal_title')}
      width={440}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button loading={busy} onClick={() => onConfirm(features.join(','))}>
            {cfT('cloudflare.accounts.confirm_set_accounts', { count })}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-1">
        {CLOUDFLARE_FEATURES.map((feature) => (
          <Checkbox
            key={feature}
            checked={features.includes(feature)}
            onChange={(next) => toggle(feature, next)}
            label={featureLabel(feature)}
          />
        ))}
      </div>
    </Modal>
  )
}

export function FeaturesDialog({
  open,
  account,
  onClose,
  onSaved,
}: {
  open: boolean
  account: CloudflareAccount | null
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useUi((state) => state.toast)
  const [features, setFeatures] = useState<CloudflareFeature[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !account) return
    setFeatures(enabledFeatures(account.enabled_features))
    setBusy(false)
    setError(null)
  }, [open, account])

  function toggle(feature: CloudflareFeature, next: boolean): void {
    setFeatures((previous) => {
      if (next) return previous.includes(feature) ? previous : [...previous, feature]
      return previous.filter((item) => item !== feature)
    })
  }

  async function save(): Promise<void> {
    if (!account) return
    setBusy(true)
    setError(null)
    try {
      await accountsApi.updateFeatures(account.id, features.join(','))
      toast({ title: cfT('cloudflare.accounts.msg.features_updated'), tone: 'success' })
      onSaved()
      onClose()
    } catch (caught) {
      const message = cfErrorText(caught)
      setError(message)
      toast({ title: t('common.action_failed'), description: message, tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={cfT('cloudflare.accounts.edit_features')}
      width={440}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button loading={busy} onClick={() => { void save() }}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-1">
        {CLOUDFLARE_FEATURES.map((feature) => (
          <Checkbox
            key={feature}
            checked={features.includes(feature)}
            onChange={(next) => toggle(feature, next)}
            label={featureLabel(feature)}
          />
        ))}
        {error && (
          <p role="alert" className="rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
