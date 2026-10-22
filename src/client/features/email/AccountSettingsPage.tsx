import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Download, Plug, Save, Trash2 } from 'lucide-react'
import type { EmailAccountSettings } from '@shared/email/model'
import { Button } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Field, Input, SettingRow, Switch, Textarea } from '../../components/form'
import { confirm } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'
import { emailFolderPath } from './email-address'
import { useEmailStore } from './store'

function mcpEndpoint(): string {
  if (typeof window === 'undefined') return '/mcp'
  return new URL('/mcp', window.location.origin).toString()
}

export function AccountSettingsPage({ accountId }: { accountId: string }) {
  const account = useEmailStore((state) => state.accounts.find((entry) => entry.id === accountId) ?? null)
  const accountsStatus = useEmailStore((state) => state.accountsStatus)
  const accountsError = useEmailStore((state) => state.accountsError)
  const config = useEmailStore((state) => state.config)
  const configStatus = useEmailStore((state) => state.configStatus)
  const loadAccounts = useEmailStore((state) => state.loadAccounts)
  const updateAccount = useEmailStore((state) => state.updateAccount)
  const deleteAccount = useEmailStore((state) => state.deleteAccount)

  const [displayName, setDisplayName] = useState('')
  const [signatureEnabled, setSignatureEnabled] = useState(false)
  const [signatureText, setSignatureText] = useState('')
  const [agentPrompt, setAgentPrompt] = useState('')
  const [autoDraft, setAutoDraft] = useState(true)
  const [autoDraftStatus, setAutoDraftStatus] = useState<{ status: string | null, reason: string | null } | null>(null)
  const [autoDraftStatusError, setAutoDraftStatusError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endpoint = useMemo(mcpEndpoint, [])

  useEffect(() => {
    if (accountsStatus === 'idle') void loadAccounts()
  }, [accountsStatus, loadAccounts])

  useEffect(() => {
    if (!account) return
    let cancelled = false
    setAutoDraftStatusError(false)
    void api.email.getAutoDraftStatus(account.id)
      .then((value) => { if (!cancelled) setAutoDraftStatus(value) })
      .catch(() => { if (!cancelled) setAutoDraftStatusError(true) })
    return () => { cancelled = true }
  }, [account?.id])

  useEffect(() => {
    if (!account) return
    setDisplayName(account.displayName)
    setSignatureEnabled(account.settings.signature?.enabled ?? false)
    setSignatureText(account.settings.signature?.text ?? '')
    setAgentPrompt(account.settings.agentSystemPrompt ?? '')
    setAutoDraft(account.settings.autoDraft ?? true)
    setError(null)
  }, [account?.id, account?.updatedAt])

  const save = async (): Promise<void> => {
    if (!account) return
    const settings: EmailAccountSettings = {
      signature: { enabled: signatureEnabled, text: signatureText },
      autoDraft,
      ...(agentPrompt.trim() ? { agentSystemPrompt: agentPrompt.trim() } : {}),
    }
    setSaving(true)
    setError(null)
    try {
      await updateAccount(account.id, {
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        settings,
      })
      useUi.getState().toast({ title: t('email.settings.saved'), tone: 'success' })
    } catch (reason) {
      setError(emailErrorText(reason))
    } finally {
      setSaving(false)
    }
  }

  const exportMailbox = async (): Promise<void> => {
    if (!account) return
    setExporting(true)
    setError(null)
    try {
      await api.email.exportAccount(account.id)
    } catch (reason) {
      setError(emailErrorText(reason))
    } finally {
      setExporting(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!account) return
    const ok = await confirm({
      title: t('email.accounts.delete_title'),
      description: t('email.accounts.delete_warning', { address: account.address }),
      confirmLabel: t('email.accounts.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await deleteAccount(account.id)
      useUi.getState().toast({ title: t('email.accounts.deleted'), tone: 'success' })
      navigateToPath('/email')
    } catch (reason) {
      setError(emailErrorText(reason))
    }
  }

  if (!account) {
    if (accountsStatus === 'loading' || accountsStatus === 'idle' || configStatus === 'loading') {
      return <LoadingBlock label={t('email.settings.loading')} />
    }
    if (accountsStatus === 'error') {
      return (
        <Empty
          art="folder"
          title={t('email.error_load')}
          description={accountsError}
          action={<Button size="sm" onClick={() => { void loadAccounts() }}>{t('common.retry')}</Button>}
        />
      )
    }
    return (
      <Empty
        art="folder"
        title={t('email.settings.not_found')}
        action={<Button size="sm" onClick={() => navigateToPath('/email')}>{t('email.back')}</Button>}
      />
    )
  }

  const autoDraftAvailable = config?.autoDraftAvailable === true
  const autoDraftStatusText = (() => {
    if (autoDraftStatusError) return t('email.settings.auto_draft_status_unavailable')
    if (!autoDraftStatus?.status) return t('email.settings.auto_draft_status_none')
    if (autoDraftStatus.status === 'queued') return t('email.settings.auto_draft_queued')
    if (autoDraftStatus.status === 'running') return t('email.settings.auto_draft_running')
    if (autoDraftStatus.status === 'done') return t('email.settings.auto_draft_done')
    if (autoDraftStatus.status === 'failed') return t('email.settings.auto_draft_failed')
    if (autoDraftStatus.reason === 'injection') return t('email.settings.auto_draft_skipped_injection')
    if (autoDraftStatus.reason === 'no_model') return t('email.settings.auto_draft_skipped_no_model')
    if (autoDraftStatus.reason === 'rate_limited') return t('email.settings.auto_draft_skipped_rate_limited')
    return t('email.settings.auto_draft_skipped_other')
  })()
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 md:px-3">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowLeft size={14} />}
          onClick={() => navigateToPath(emailFolderPath(account.id, 'inbox'))}
        >
          {t('email.header.back')}
        </Button>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('email.settings.title')}
        </span>
        <Button size="sm" icon={<Save size={14} />} loading={saving} onClick={() => { void save() }}>
          {t('email.settings.save')}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-4">
          {error && (
            <p role="alert" className="mb-3 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
              {error}
            </p>
          )}
          <section aria-label={t('email.settings.account')} className="space-y-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
            <h2 className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('email.settings.account')}</h2>
            <div className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{account.address}</div>
            <Field label={t('email.settings.display_name')} hint={t('email.settings.display_name_hint')}>
              <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="off" />
            </Field>
          </section>

          <section aria-label={t('email.settings.signature')} className="mt-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4">
            <SettingRow title={t('email.settings.signature')} description={t('email.settings.signature_hint')}>
              <Switch checked={signatureEnabled} onChange={setSignatureEnabled} label={t('email.settings.signature_enabled')} />
            </SettingRow>
            <div className="pb-4">
              <Field label={t('email.settings.signature_text')}>
                <Textarea
                  value={signatureText}
                  onChange={(event) => setSignatureText(event.target.value)}
                  disabled={!signatureEnabled}
                  rows={4}
                  placeholder={t('email.settings.signature_placeholder')}
                />
              </Field>
            </div>
          </section>

          <section aria-label={t('email.settings.agent')} className="mt-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('email.settings.agent')}</h2>
              <Button size="sm" variant="ghost" onClick={() => setAgentPrompt('')}>{t('email.settings.agent_reset')}</Button>
            </div>
            <Field label={t('email.settings.agent')} hint={t('email.settings.agent_hint')}>
              <Textarea
                value={agentPrompt}
                onChange={(event) => setAgentPrompt(event.target.value)}
                rows={5}
                placeholder={t('email.settings.agent_placeholder')}
              />
            </Field>
          </section>

          <section aria-label={t('email.settings.auto_draft')} className="mt-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4">
            <SettingRow
              title={t('email.settings.auto_draft')}
              description={autoDraftAvailable ? t('email.settings.auto_draft_hint') : t('email.settings.auto_draft_unavailable')}
            >
              <Switch
                checked={autoDraft}
                onChange={setAutoDraft}
                disabled={!autoDraftAvailable}
                label={t('email.settings.auto_draft')}
              />
            </SettingRow>
            <p role="status" className="pb-3 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
              {t('email.settings.auto_draft_status')} {autoDraftStatusText}
            </p>
          </section>

          <section aria-label={t('email.settings.mcp')} className="mt-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
            <div className="flex items-center gap-2">
              <Plug size={14} aria-hidden="true" className="text-[var(--text-tertiary)]" />
              <h2 className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('email.settings.mcp')}</h2>
            </div>
            <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{t('email.settings.mcp_hint')}</p>
            <div className="mt-2 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2.5 py-1.5">
              <div className="text-[length:var(--text-10-5)] font-medium uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                {t('email.settings.mcp_endpoint')}
              </div>
              <code className="break-all text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{endpoint}</code>
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => useUi.getState().openPanel('settings')}
            >
              {t('email.settings.mcp_open')}
            </Button>
          </section>

          <section aria-label={t('email.settings.export_title')} className="mt-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
            <h2 className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('email.settings.export_title')}</h2>
            <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{t('email.settings.export_hint')}</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              icon={<Download size={14} />}
              loading={exporting}
              onClick={() => { void exportMailbox() }}
            >
              {t('email.settings.export_button')}
            </Button>
          </section>

          <section aria-label={t('email.settings.danger')} className="mt-3 rounded-[var(--r-lg)] border border-[var(--danger-soft)] bg-[var(--bg-surface)] p-4">
            <h2 className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--danger)]">{t('email.settings.danger')}</h2>
            <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{t('email.settings.delete_hint')}</p>
            <Button size="sm" variant="danger" className="mt-2" icon={<Trash2 size={14} />} onClick={() => { void remove() }}>
              {t('email.settings.delete_account')}
            </Button>
          </section>
        </div>
      </div>
    </div>
  )
}
