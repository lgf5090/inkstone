/**
 * The credential viewer.
 *
 * Opening it is an audited action on the server; the dialog therefore fetches on each open instead
 * of holding a decrypted value in the screen's state. The values stay behind a password input with a
 * copy button, so a shoulder-surfer does not read them but a reader can still put one on the
 * clipboard.
 */
import { useEffect, useState } from 'react'
import type { CloudflareAccount, CloudflareAccountCredentials } from '@shared/cloudflare/model'
import { t } from '../../../../lib/i18n'
import { Badge, Button } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { LoadingBlock } from '../../../../components/feedback'
import { Modal } from '../../../../components/overlay'
import { CopyButton } from '../../components/CopyButton'
import { accountsApi } from '../../api/accounts'
import { cfErrorText } from '../../api/client'
import { cfT } from '../../i18n'
import { authTypeLabel } from './labels'

export function CredentialsDialog({
  open,
  account,
  onClose,
}: {
  open: boolean
  account: CloudflareAccount | null
  onClose: () => void
}) {
  const [data, setData] = useState<CloudflareAccountCredentials | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const accountId = account?.id ?? null

  useEffect(() => {
    if (!open || !accountId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    accountsApi.credentials(accountId)
      .then((next) => {
        if (!cancelled) setData(next)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(cfErrorText(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, accountId, attempt])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={cfT('cloudflare.accounts.cred_modal_title')}
      width={520}
      footer={<Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>}
    >
      {loading && <LoadingBlock label={t('common.loading')} />}
      {!loading && error && (
        <div role="alert" className="flex flex-col gap-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] p-3 text-[length:var(--text-12)] text-[var(--danger)]">
          <span>{cfT('cloudflare.accounts.msg.get_cred_failed', { error })}</span>
          <Button size="sm" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {!loading && !error && data && (
        <div className="grid gap-3">
          <p className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {cfT('cloudflare.accounts.cred_warning')}
          </p>
          <dl className="grid gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3 text-[length:var(--text-12-5)]">
            <SummaryRow label={cfT('cloudflare.accounts.account_name')} value={data.name} />
            <SummaryRow label={cfT('cloudflare.accounts.table.account_id')} value={data.cf_account_id || '—'} mono />
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-tertiary)]">{cfT('cloudflare.accounts.auth_type')}</dt>
              <dd className="m-0">
                <Badge tone={data.auth_type === 'token' ? 'accent' : 'warning'}>{authTypeLabel(data.auth_type)}</Badge>
              </dd>
            </div>
            {data.auth_type === 'global_key' && (
              <SummaryRow label={cfT('cloudflare.accounts.email')} value={data.email || '—'} />
            )}
          </dl>
          {data.api_token && <SecretRow label={cfT('cloudflare.accounts.api_token')} value={data.api_token} />}
          {data.api_key && <SecretRow label={cfT('cloudflare.accounts.api_key')} value={data.api_key} />}
          {data.password && <SecretRow label={cfT('cloudflare.accounts.login_password')} value={data.password} />}
        </div>
      )}
    </Modal>
  )
}

function SummaryRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[var(--text-tertiary)]">{label}</dt>
      <dd className={`m-0 min-w-0 truncate text-right ${mono ? 'font-mono text-[length:var(--text-11-5)]' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  )
}

function SecretRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{label}</span>
      <div className="flex items-center gap-1">
        <Input
          readOnly
          type="password"
          value={value}
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-[length:var(--text-12)]"
        />
        <CopyButton text={value} />
      </div>
    </div>
  )
}
