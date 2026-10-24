import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import type { EmailDeploymentSettings, EmailSendingProvider } from '@shared/email/deployment'
import {
  isValidDeploymentDomain,
  isValidResendFrom,
  normalizeDeploymentDomains,
} from '@shared/email/deployment'
import { Button } from '../../components/primitives'
import { Field, Input, Select } from '../../components/form'
import { Modal } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'
import { useEmailStore } from './store'

export function DeploymentSettingsPanel({
  onSaved,
  showHeading = true,
}: {
  onSaved?: (saved: EmailDeploymentSettings) => void
  showHeading?: boolean
}) {
  const config = useEmailStore((state) => state.config)
  const [deployment, setDeployment] = useState<EmailDeploymentSettings | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [domainText, setDomainText] = useState('')
  const [provider, setProvider] = useState<EmailSendingProvider>('cloudflare')
  const [resendFrom, setResendFrom] = useState('')
  const [resendKey, setResendKey] = useState('')
  const [clearResendKey, setClearResendKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async (): Promise<void> => {
    setStatus('loading')
    setLoadError(null)
    try {
      const value = await api.email.getDeployment()
      setDeployment(value)
      setDomainText(value.domains.join(', '))
      setProvider(value.provider)
      setResendFrom(value.resendFrom)
      setStatus('ready')
    } catch (reason) {
      setStatus('error')
      setLoadError(emailErrorText(reason))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async (): Promise<void> => {
    const domains = normalizeDeploymentDomains(domainText.split(/[,\n]/))
    if (domains.some((domain) => !isValidDeploymentDomain(domain))) {
      setError(t('email.settings.delivery_domain_invalid'))
      return
    }
    if (provider === 'resend' && !resendFrom.trim()) {
      setError(t('email.settings.delivery_resend_from_required'))
      return
    }
    if (provider === 'resend' && resendFrom.trim() && !isValidResendFrom(resendFrom)) {
      setError(t('email.settings.delivery_resend_from_invalid'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await api.email.updateDeployment({
        domains,
        provider,
        resendFrom: resendFrom.trim(),
        ...(resendKey.trim() ? { resendApiKey: resendKey.trim() } : {}),
        ...(clearResendKey ? { resendApiKey: null } : {}),
      })
      setDeployment(saved)
      setDomainText(saved.domains.join(', '))
      setProvider(saved.provider)
      setResendFrom(saved.resendFrom)
      setResendKey('')
      setClearResendKey(false)
      useUi.getState().toast({ title: t('email.settings.delivery_saved'), tone: 'success' })
      onSaved?.(saved)
    } catch (reason) {
      setError(emailErrorText(reason))
    } finally {
      setSaving(false)
    }
  }

  const sendingReady = deployment
    ? provider === 'resend'
      ? Boolean(deployment.hasResendKey) && resendFrom.trim().length > 0
      : deployment.cloudflareSending
    : false
  const attachmentsReady = deployment?.attachmentsAvailable === true

  return (
    <div className="space-y-3">
      {showHeading && (
        <h2 className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('email.settings.delivery')}</h2>
      )}
      <p className="m-0 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{t('email.settings.delivery_hint')}</p>
      {status === 'loading' && (
        <p role="status" className="m-0 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('common.loading')}</p>
      )}
      {status === 'error' && (
        <div role="alert" className="flex items-center gap-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
          <span className="min-w-0 flex-1">{loadError ?? t('email.settings.delivery_load_error')}</span>
          <Button size="sm" variant="ghost" onClick={() => { void load() }}>{t('common.retry')}</Button>
        </div>
      )}
      {status === 'ready' && deployment && (
        <>
          {deployment.envDomains.length > 0 && (
            <p className="m-0 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('email.settings.delivery_env_domains', { domains: deployment.envDomains.join(', ') })}
            </p>
          )}
          {config && config.addresses.length > 0 && (
            <p className="m-0 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2.5 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('email.settings.delivery_env_addresses', { addresses: config.addresses.join(', ') })}
            </p>
          )}
          <Field label={t('email.settings.delivery_domains')} hint={t('email.settings.delivery_domains_hint')}>
            <Input value={domainText} onChange={(event) => setDomainText(event.target.value)} autoComplete="off" placeholder={deployment.envDomains[0] ?? 'example.com'} />
          </Field>
          <Field label={t('email.settings.delivery_provider')} hint={t('email.settings.delivery_provider_hint')}>
            <Select value={provider} onChange={(event) => setProvider(event.target.value as EmailSendingProvider)}>
              <option value="cloudflare">{t('email.settings.delivery_provider_cloudflare')}</option>
              <option value="resend">{t('email.settings.delivery_provider_resend')}</option>
            </Select>
          </Field>
          {provider === 'resend' && (
            <>
              <Field label={t('email.settings.delivery_resend_from')} hint={t('email.settings.delivery_resend_from_hint')}>
                <Input value={resendFrom} onChange={(event) => setResendFrom(event.target.value)} autoComplete="off" placeholder={t('email.settings.delivery_resend_from_placeholder')} />
              </Field>
              <Field
                label={t('email.settings.delivery_resend_key')}
                hint={deployment.hasResendKey
                  ? t('email.settings.delivery_resend_key_saved', { hint: deployment.resendKeyHint })
                  : t('email.settings.delivery_resend_key_hint')}
              >
                <Input
                  type="password"
                  value={resendKey}
                  onChange={(event) => { setResendKey(event.target.value); setClearResendKey(false) }}
                  autoComplete="new-password"
                  placeholder={deployment.hasResendKey ? t('email.settings.delivery_resend_key_keep') : 're_...'}
                />
              </Field>
              {deployment.hasResendKey && (
                <Button
                  size="sm"
                  variant={clearResendKey ? 'danger' : 'ghost'}
                  onClick={() => setClearResendKey(!clearResendKey)}
                >
                  {clearResendKey ? t('email.settings.delivery_resend_key_clear_pending') : t('email.settings.delivery_resend_key_clear')}
                </Button>
              )}
            </>
          )}
          <dl className="m-0 space-y-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2.5 py-2 text-[length:var(--text-11)]">
            <div className="flex items-baseline gap-2">
              <dt className="shrink-0 text-[var(--text-tertiary)]">{t('email.settings.delivery_status_sending')}</dt>
              <dd className={cn('m-0', sendingReady ? 'text-[var(--text-secondary)]' : 'text-[var(--danger)]')}>
                {sendingReady ? t('email.settings.delivery_status_ready') : t('email.settings.delivery_status_sending_missing')}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="shrink-0 text-[var(--text-tertiary)]">{t('email.settings.delivery_status_attachments')}</dt>
              <dd className={cn('m-0', attachmentsReady ? 'text-[var(--text-secondary)]' : 'text-[var(--danger)]')}>
                {attachmentsReady ? t('email.settings.delivery_status_ready') : t('email.settings.delivery_status_attachments_missing')}
              </dd>
            </div>
          </dl>
          {error && (
            <p role="alert" className="m-0 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>
          )}
          <div className="flex justify-end">
            <Button size="sm" icon={<Save size={14} />} loading={saving} onClick={() => { void save() }}>
              {t('email.settings.delivery_save')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

export function DeploymentSettingsDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved?: (saved: EmailDeploymentSettings) => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('email.settings.delivery')}
      width={560}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      <DeploymentSettingsPanel onSaved={onSaved} showHeading={false} />
    </Modal>
  )
}
