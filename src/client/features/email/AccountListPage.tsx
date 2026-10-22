import { useEffect, useState, type FormEvent } from 'react'
import { Mail, Plus, Trash2 } from 'lucide-react'
import type { EmailAccount } from '@shared/email/model'
import { Button, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Field, Input, Select } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import { emailErrorText } from './errors'
import { emailFolderPath } from './email-address'
import { useEmailStore } from './store'

const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/i

function reportFailure(error: unknown): void {
  useUi.getState().toast({ title: t('email.toast.failed'), description: emailErrorText(error), tone: 'danger' })
}

export function AccountListPage() {
  const config = useEmailStore((state) => state.config)
  const configStatus = useEmailStore((state) => state.configStatus)
  const accounts = useEmailStore((state) => state.accounts)
  const accountsStatus = useEmailStore((state) => state.accountsStatus)
  const accountsError = useEmailStore((state) => state.accountsError)
  const loadAccounts = useEmailStore((state) => state.loadAccounts)
  const createAccount = useEmailStore((state) => state.createAccount)
  const deleteAccount = useEmailStore((state) => state.deleteAccount)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState(false)
  const [localPart, setLocalPart] = useState('')
  const [domain, setDomain] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (accountsStatus === 'idle') void loadAccounts()
  }, [accountsStatus, loadAccounts])

  const domains = config?.domains ?? []
  const canCreate = domains.length > 0

  const openCreate = (): void => {
    setLocalPart('')
    setDomain(domains[0] ?? '')
    setDisplayName('')
    setFormError(null)
    setOpen(true)
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmed = localPart.trim().toLowerCase()
    if (!trimmed || !LOCAL_PART.test(trimmed) || trimmed.startsWith('.') || trimmed.endsWith('.') || trimmed.includes('..')) {
      setFormError(t('email.accounts.local_part_invalid'))
      return
    }
    if (!domain) {
      setFormError(t('email.accounts.domain_required'))
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const account = await createAccount({
        localPart: trimmed,
        domain,
        displayName: displayName.trim() || undefined,
      })
      useUi.getState().toast({ title: t('email.accounts.created'), tone: 'success' })
      setOpen(false)
      navigateToPath(emailFolderPath(account.id, 'inbox'))
    } catch (error) {
      setFormError(emailErrorText(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (account: EmailAccount): Promise<void> => {
    const ok = await confirm({
      title: t('email.accounts.delete_title'),
      description: t('email.accounts.delete_warning', { address: account.address }),
      confirmLabel: t('email.accounts.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setCreating(true)
    try {
      await deleteAccount(account.id)
      useUi.getState().toast({ title: t('email.accounts.deleted'), tone: 'success' })
    } catch (error) {
      reportFailure(error)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-4">
        <h1 className="min-w-0 flex-1 truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('email.title')}</h1>
        {canCreate && (
          <Button size="sm" icon={<Plus size={14} />} onClick={openCreate} disabled={creating}>
            {t('email.accounts.create')}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {accountsError && accounts.length > 0 && (
          <div role="alert" className="mx-auto mb-3 flex max-w-2xl items-center gap-2 rounded-[var(--r-md)] bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--text-11-5)] text-[var(--danger)]">
            <span className="min-w-0 flex-1">{accountsError}</span>
            <Button size="sm" variant="ghost" onClick={() => { void loadAccounts() }}>{t('common.retry')}</Button>
          </div>
        )}
        {accountsStatus === 'loading' && accounts.length === 0 ? (
          <LoadingBlock label={t('email.loading')} />
        ) : accountsStatus === 'error' && accounts.length === 0 ? (
          <Empty
            art="archive"
            title={t('email.error_load')}
            description={accountsError}
            action={<Button size="sm" onClick={() => { void loadAccounts() }}>{t('common.retry')}</Button>}
          />
        ) : accounts.length === 0 ? (
          <Empty
            art="archive"
            title={t('email.empty_title')}
            description={configStatus === 'loading'
              ? t('email.loading')
              : canCreate ? t('email.empty_hint') : t('email.no_domain')}
            action={canCreate
              ? <Button size="sm" icon={<Plus size={14} />} onClick={openCreate}>{t('email.accounts.create')}</Button>
              : undefined}
          />
        ) : (
          <ul className="mx-auto flex max-w-2xl list-none flex-col gap-1 p-0">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] pr-1"
              >
                <button
                  type="button"
                  onClick={() => navigateToPath(emailFolderPath(account.id, 'inbox'))}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--r-md)] px-3 py-2.5 text-left hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-inset"
                >
                  <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-inset)] text-[length:var(--text-13)] font-semibold text-[var(--text-secondary)]">
                    {(account.displayName || account.address).charAt(0).toUpperCase() || <Mail size={15} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                      {account.displayName || account.address}
                    </span>
                    <span className="block truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">{account.address}</span>
                  </span>
                  <span className="shrink-0 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.open')}</span>
                </button>
                <IconButton
                  label={t('email.accounts.delete_address', { address: account.address })}
                  size="sm"
                  disabled={creating}
                  onClick={() => { void remove(account) }}
                >
                  <Trash2 size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Modal
        open={open}
        onClose={() => { if (!busy) setOpen(false) }}
        title={t('email.accounts.create_title')}
        description={t('email.accounts.create_hint')}
        width={480}
        dismissible={!busy}
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" form="email-create-account" loading={busy}>{t('email.accounts.create')}</Button>
          </>
        )}
      >
        <form id="email-create-account" className="space-y-3" onSubmit={(event) => { void submit(event) }}>
          <Field label={t('email.accounts.local_part')} hint={t('email.accounts.local_part_hint')} required>
            <Input
              value={localPart}
              onChange={(event) => setLocalPart(event.target.value)}
              placeholder={t('email.accounts.local_part_placeholder')}
              autoComplete="off"
              spellCheck={false}
              invalid={formError !== null}
            />
          </Field>
          <Field label={t('email.accounts.domain')} required>
            <Select value={domain} onChange={(event) => setDomain(event.target.value)}>
              {domains.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </Select>
          </Field>
          <Field label={t('email.accounts.display_name')}>
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={t('email.accounts.display_name_placeholder')}
              autoComplete="off"
            />
          </Field>
          {formError && <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--danger)]">{formError}</p>}
        </form>
      </Modal>
    </div>
  )
}
