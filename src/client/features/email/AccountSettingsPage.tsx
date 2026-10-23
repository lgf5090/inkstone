import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Download, Pencil, Plus, Plug, Save, Trash2 } from 'lucide-react'
import type { EmailAccountSettings, EmailSignature } from '@shared/email/model'
import {
  EMAIL_SIGNATURES_MAX,
  EMAIL_SIGNATURE_NAME_MAX_CHARS,
  EMAIL_SIGNATURE_TEXT_MAX_CHARS,
  EMAIL_VACATION_BODY_MAX_CHARS,
  EMAIL_VACATION_SUBJECT_MAX_CHARS,
  normalizeEmailSignatures,
  normalizeEmailVacation,
} from '@shared/email/model'
import { Button, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Field, Input, SettingRow, Switch, Textarea, useRovingRadio } from '../../components/form'
import { confirm } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
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

const VACATION_INPUT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

function vacationInputValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function vacationInputTimestamp(value: string): number | null {
  const text = value.trim()
  if (!VACATION_INPUT_RE.test(text)) return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? time : null
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
  const [signatures, setSignatures] = useState<EmailSignature[]>([])
  const [defaultSignatureId, setDefaultSignatureId] = useState<string | null>(null)
  const [editingSignatureId, setEditingSignatureId] = useState<string | null>(null)
  const [agentPrompt, setAgentPrompt] = useState('')
  const [autoDraft, setAutoDraft] = useState(true)
  const [focusedInbox, setFocusedInbox] = useState(true)
  const [vacationEnabled, setVacationEnabled] = useState(false)
  const [vacationStart, setVacationStart] = useState('')
  const [vacationEnd, setVacationEnd] = useState('')
  const [vacationSubject, setVacationSubject] = useState('')
  const [vacationBody, setVacationBody] = useState('')
  const [autoDraftStatus, setAutoDraftStatus] = useState<{ status: string | null, reason: string | null } | null>(null)
  const [autoDraftStatusError, setAutoDraftStatusError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endpoint = useMemo(mcpEndpoint, [])
  const signatureRoving = useRovingRadio(
    signatures.map((signature) => signature.id),
    defaultSignatureId ?? '',
    setDefaultSignatureId,
  )

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
    const normalized = normalizeEmailSignatures(account.settings)
    const vacation = normalizeEmailVacation(account.settings)
    setDisplayName(account.displayName)
    setSignatures(normalized.signatures.map((signature) => ({
      ...signature,
      name: signature.name || t('email.signatures.untitled'),
    })))
    setDefaultSignatureId(normalized.defaultId)
    setEditingSignatureId(null)
    setAgentPrompt(account.settings.agentSystemPrompt ?? '')
    setAutoDraft(account.settings.autoDraft ?? true)
    setFocusedInbox(account.settings.focusedInbox !== false)
    setVacationEnabled(vacation.enabled)
    setVacationStart(vacationInputValue(vacation.start))
    setVacationEnd(vacationInputValue(vacation.end))
    setVacationSubject(vacation.subject)
    setVacationBody(vacation.body)
    setError(null)
  }, [account?.id, account?.updatedAt])

  const updateSignature = (id: string, patch: Partial<EmailSignature>): void => {
    setSignatures((current) => current.map((signature) => signature.id === id ? { ...signature, ...patch } : signature))
  }

  const toggleSignature = (id: string, enabled: boolean): void => {
    setSignatures((current) => current.map((signature) => signature.id === id ? { ...signature, enabled } : signature))
    if (enabled || id !== defaultSignatureId) return
    const replacement = signatures.find((signature) => signature.id !== id && signature.enabled !== false)
    if (replacement) setDefaultSignatureId(replacement.id)
  }

  const addSignature = (): void => {
    if (signatures.length >= EMAIL_SIGNATURES_MAX) return
    const id = crypto.randomUUID()
    setSignatures((current) => [
      ...current,
      { id, name: t('email.signatures.untitled'), text: '', enabled: true },
    ])
    setDefaultSignatureId((current) => current ?? id)
    setEditingSignatureId(id)
  }

  const removeSignature = async (signature: EmailSignature): Promise<void> => {
    if (signature.id === defaultSignatureId && signatures.length > 1) {
      useUi.getState().toast({ title: t('email.settings.signatures_default_required'), tone: 'danger' })
      return
    }
    const name = signature.name.trim() || t('email.signatures.untitled')
    const ok = await confirm({
      title: t('email.settings.signatures_delete_title'),
      description: t('email.settings.signatures_delete_warning', { name }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setSignatures((current) => current.filter((entry) => entry.id !== signature.id))
    if (signature.id === defaultSignatureId) setDefaultSignatureId(null)
    if (editingSignatureId === signature.id) setEditingSignatureId(null)
  }

  const save = async (): Promise<void> => {
    if (!account) return
    const cleaned = signatures.map((signature) => ({
      ...signature,
      name: signature.name.trim(),
      text: signature.text.trim(),
    }))
    if (cleaned.some((signature) => !signature.name || !signature.text)) {
      setError(t('email.settings.signatures_incomplete'))
      return
    }
    const startText = vacationStart.trim()
    const endText = vacationEnd.trim()
    const vacationStartValue = startText ? vacationInputTimestamp(startText) : null
    const vacationEndValue = endText ? vacationInputTimestamp(endText) : null
    if ((startText && vacationStartValue === null) || (endText && vacationEndValue === null)) {
      setError(t('email.settings.vacation_invalid'))
      return
    }
    if (vacationStartValue !== null && vacationEndValue !== null && vacationStartValue > vacationEndValue) {
      setError(t('email.settings.vacation_order'))
      return
    }
    const selectedDefault = cleaned.some((signature) => signature.id === defaultSignatureId) ? defaultSignatureId : null
    const settings: EmailAccountSettings = {
      signatures: cleaned,
      ...(selectedDefault ? { defaultSignatureId: selectedDefault } : {}),
      autoDraft,
      focusedInbox,
      ...(agentPrompt.trim() ? { agentSystemPrompt: agentPrompt.trim() } : {}),
      vacation: {
        enabled: vacationEnabled,
        start: vacationStartValue,
        end: vacationEndValue,
        subject: vacationSubject.trim(),
        body: vacationBody,
      },
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

          <section aria-label={t('email.settings.signatures')} className="mt-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3">
            <h2 className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('email.settings.signatures')}</h2>
            <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{t('email.settings.signature_hint')}</p>
            {signatures.length > 0 ? (
              <div role="radiogroup" aria-label={t('email.settings.signatures_default')} className="mt-3 space-y-2">
                {signatures.map((signature, index) => {
                  const name = signature.name.trim() || t('email.signatures.untitled')
                  const active = signature.id === defaultSignatureId
                  const editing = signature.id === editingSignatureId
                  return (
                    <div
                      key={signature.id}
                      className={cn(
                        'rounded-[var(--r-md)] border px-3 py-2.5 transition-colors duration-[var(--dur-fast)]',
                        active ? 'border-[var(--accent)] bg-[var(--accent-softer)]' : 'border-[var(--border-subtle)]',
                      )}
                    >
                      <div className="flex items-start gap-2.5">
                        <button
                          ref={signatureRoving.setItemRef(index)}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          aria-label={t('email.settings.signatures_make_default', { name })}
                          tabIndex={signatureRoving.tabIndexFor(index)}
                          onKeyDown={signatureRoving.keyHandlerFor(index)}
                          onClick={() => setDefaultSignatureId(signature.id)}
                          className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--border-strong)]"
                        >
                          {active && <span aria-hidden="true" className="size-2.5 rounded-full bg-[var(--accent)]" />}
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="min-w-0 break-words text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{name}</span>
                            {active && (
                              <span className="rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[length:var(--text-10)] font-medium text-[var(--accent-contrast)]">
                                {t('email.settings.signatures_default_badge')}
                              </span>
                            )}
                            <div className="ml-auto flex items-center gap-1">
                              <Switch
                                checked={signature.enabled !== false}
                                onChange={(next) => toggleSignature(signature.id, next)}
                                label={t('email.settings.signatures_toggle', { name })}
                              />
                              <IconButton
                                label={t('email.settings.signatures_edit', { name })}
                                size="sm"
                                onClick={() => setEditingSignatureId(editing ? null : signature.id)}
                              >
                                <Pencil size={13} />
                              </IconButton>
                              <IconButton
                                label={t('email.settings.signatures_delete', { name })}
                                size="sm"
                                onClick={() => { void removeSignature(signature) }}
                              >
                                <Trash2 size={13} />
                              </IconButton>
                            </div>
                          </div>
                          {editing ? (
                            <div className="mt-2 space-y-2">
                              <Field label={t('email.settings.signature_name')}>
                                <Input
                                  value={signature.name}
                                  maxLength={EMAIL_SIGNATURE_NAME_MAX_CHARS}
                                  autoComplete="off"
                                  onChange={(event) => updateSignature(signature.id, { name: event.target.value })}
                                />
                              </Field>
                              <Field label={t('email.settings.signature_text')}>
                                <Textarea
                                  value={signature.text}
                                  maxLength={EMAIL_SIGNATURE_TEXT_MAX_CHARS}
                                  rows={4}
                                  placeholder={t('email.settings.signature_placeholder')}
                                  onChange={(event) => updateSignature(signature.id, { text: event.target.value })}
                                />
                              </Field>
                              <div className="flex justify-end">
                                <Button size="sm" variant="ghost" onClick={() => setEditingSignatureId(null)}>
                                  {t('email.settings.signatures_done')}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <p className="mt-1 line-clamp-2 whitespace-pre-line break-words text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
                              {signature.text.trim() || t('email.settings.signatures_no_text')}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="mt-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('email.settings.signatures_empty')}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-3">
              <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                {t('email.settings.signatures_count', { count: signatures.length, max: EMAIL_SIGNATURES_MAX })}
              </span>
              <Button
                size="sm"
                variant="secondary"
                icon={<Plus size={14} />}
                disabled={signatures.length >= EMAIL_SIGNATURES_MAX}
                onClick={addSignature}
              >
                {t('email.settings.signatures_add')}
              </Button>
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

          <section aria-label={t('email.settings.focused_inbox')} className="mt-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4">
            <SettingRow title={t('email.settings.focused_inbox')} description={t('email.settings.focused_inbox_hint')}>
              <Switch
                checked={focusedInbox}
                onChange={setFocusedInbox}
                label={t('email.settings.focused_inbox')}
              />
            </SettingRow>
          </section>

          <section aria-label={t('email.settings.vacation')} className="mt-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4">
            <SettingRow title={t('email.settings.vacation')} description={t('email.settings.vacation_hint')}>
              <Switch
                checked={vacationEnabled}
                onChange={setVacationEnabled}
                label={t('email.settings.vacation')}
              />
            </SettingRow>
            <div className="space-y-3 pb-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label={t('email.settings.vacation_start')} hint={t('email.settings.vacation_time_hint')}>
                  <Input
                    value={vacationStart}
                    maxLength={16}
                    autoComplete="off"
                    placeholder={t('email.settings.vacation_time_placeholder')}
                    onChange={(event) => setVacationStart(event.target.value)}
                  />
                </Field>
                <Field label={t('email.settings.vacation_end')} hint={t('email.settings.vacation_time_hint')}>
                  <Input
                    value={vacationEnd}
                    maxLength={16}
                    autoComplete="off"
                    placeholder={t('email.settings.vacation_time_placeholder')}
                    onChange={(event) => setVacationEnd(event.target.value)}
                  />
                </Field>
              </div>
              <Field label={t('email.settings.vacation_subject')} hint={t('email.settings.vacation_subject_hint')}>
                <Input
                  value={vacationSubject}
                  maxLength={EMAIL_VACATION_SUBJECT_MAX_CHARS}
                  autoComplete="off"
                  placeholder={t('email.settings.vacation_subject_placeholder')}
                  onChange={(event) => setVacationSubject(event.target.value)}
                />
              </Field>
              <Field label={t('email.settings.vacation_body')}>
                <Textarea
                  value={vacationBody}
                  maxLength={EMAIL_VACATION_BODY_MAX_CHARS}
                  rows={4}
                  placeholder={t('email.settings.vacation_body_placeholder')}
                  onChange={(event) => setVacationBody(event.target.value)}
                />
              </Field>
            </div>
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
