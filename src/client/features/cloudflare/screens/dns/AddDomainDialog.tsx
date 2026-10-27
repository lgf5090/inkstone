/**
 * Adding zones and reading back what Cloudflare answered.
 *
 * The form dialog is mounted only while it is open, so its fields start from a fresh draft every
 * time; the result dialog is separate because the form has already closed by the time it appears.
 */
import { useState } from 'react'
import { Copy } from 'lucide-react'
import { Field, Segmented, Textarea } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { copyText } from '../../../../lib/clipboard'
import { t as uiT } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { cfErrorText } from '../../api/client'
import { dnsApi, type DnsAccountOption, type DomainBatchResult } from '../../api/dns'
import { useCfT } from '../../i18n'

export function AddDomainDialog({
  accounts,
  onClose,
  onCreated,
}: {
  accounts: DnsAccountOption[]
  onClose: () => void
  onCreated: (result: DomainBatchResult) => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const firstReady = accounts.find((account) => account.canCreateZone)?.id ?? ''
  const [accountId, setAccountId] = useState(firstReady)
  const [type, setType] = useState<'full' | 'partial'>('full')
  const [names, setNames] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const accountOptions = accounts
    .filter((account) => account.canCreateZone)
    .map((account) => ({ value: account.id, label: account.name }))

  async function submit(): Promise<void> {
    const list = [...new Set(names.split('\n').map((line) => line.trim()).filter(Boolean))]
    if (!accountId) {
      toast({ title: t('cloudflare.dns.msg.account_required'), tone: 'warning' })
      return
    }
    if (list.length === 0) {
      toast({ title: t('cloudflare.dns.msg.domain_required'), tone: 'warning' })
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await dnsApi.createDomains({ names: list, account_id: accountId, type })
      onCreated(result)
    } catch (reason) {
      const message = cfErrorText(reason)
      setError(message)
      toast({ title: t('cloudflare.dns.msg.create_failed'), description: message, tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('cloudflare.dns.add_domain_modal_title')}
      width={560}
      dismissible={!busy}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{uiT('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t('cloudflare.dns.add_domain_btn')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={t('cloudflare.dns.target_account')} required>
          <div>
            <SelectMenu
              label={t('cloudflare.dns.target_account')}
              value={accountId}
              options={accountOptions}
              onChange={setAccountId}
              placeholder={t('cloudflare.dns.select_account')}
              width={320}
            />
          </div>
        </Field>
        <Field label={t('cloudflare.dns.zone_type')}>
          <div>
            <Segmented
              value={type}
              options={[
                { value: 'full', label: t('cloudflare.dns.zone_type_full') },
                { value: 'partial', label: t('cloudflare.dns.zone_type_partial') },
              ]}
              onChange={setType}
              label={t('cloudflare.dns.zone_type')}
            />
          </div>
        </Field>
        <Field label={t('cloudflare.dns.domain_list_label')} required>
          <Textarea
            value={names}
            onChange={(event) => setNames(event.target.value)}
            placeholder={t('cloudflare.dns.domain_list_placeholder')}
            rows={6}
          />
        </Field>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}

export function DomainResultDialog({
  result,
  onClose,
}: {
  result: DomainBatchResult
  onClose: () => void
}) {
  const t = useCfT()
  const toast = useUi((state) => state.toast)

  async function copyNameServers(nameServers: string[]): Promise<void> {
    const copied = await copyText(nameServers.join('\n'))
    toast({
      title: copied ? t('cloudflare.dns.msg.ns_copied') : t('cloudflare.dns.msg.copy_failed'),
      tone: copied ? 'success' : 'danger',
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('cloudflare.dns.result_modal_title')}
      width={560}
      footer={<Button variant="primary" onClick={onClose}>{uiT('common.close')}</Button>}
    >
      <div className="space-y-2">
        <ul className="space-y-2">
          {result.results.map((item) => {
            const nameServers = item.name_servers ?? []
            return (
              <li key={item.name} className="rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-2.5">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className={item.success ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                    {item.success ? '✓' : '✗'}
                  </span>
                  <span className="min-w-0 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                    {item.name}
                  </span>
                </div>
                {item.success && nameServers.length > 0 && (
                  <div className="mt-1.5 pl-5">
                    <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">NS:</span>
                    {nameServers.map((server) => (
                      <div key={server} className="font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                        {server}
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Copy size={12} />}
                      className="mt-1.5"
                      onClick={() => void copyNameServers(nameServers)}
                    >
                      {t('cloudflare.dns.copy_ns')}
                    </Button>
                  </div>
                )}
                {!item.success && item.error && (
                  <p className="mt-1.5 pl-5 text-[length:var(--text-11-5)] text-[var(--danger)]">
                    {t('cloudflare.dns.reason')} {item.error}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
        <p className="border-t border-[var(--border-subtle)] pt-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('cloudflare.dns.result_summary', {
            total: result.total,
            succeeded: result.succeeded,
            failed: result.failed,
          })}
        </p>
      </div>
    </Modal>
  )
}
