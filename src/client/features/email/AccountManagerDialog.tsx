import { useState, type FormEvent } from 'react'
import { Mail, Plus, Settings2, Trash2 } from 'lucide-react'
import type { EmailAccount } from '@shared/email/model'
import { Avatar, Button, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Field, Input, Select } from '../../components/form'
import { Modal, Tooltip, confirm } from '../../components/overlay'
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

export function AccountManagerDialog({
  open,
  onClose,
  activeAccountId,
  onOpenSettings,
}: {
  open: boolean
  onClose: () => void
  activeAccountId: string
  onOpenSettings: (accountId: string) => void
}) {
  const config = useEmailStore((state) => state.config)
  const accounts = useEmailStore((state) => state.accounts)
  const accountsStatus = useEmailStore((state) => state.accountsStatus)
  const accountsError = useEmailStore((state) => state.accountsError)
  const loadAccounts = useEmailStore((state) => state.loadAccounts)
  const createAccount = useEmailStore((state) => state.createAccount)
  const deleteAccount = useEmailStore((state) => state.deleteAccount)
  const [creating, setCreating] = useState(false)
  const [address, setAddress] = useState('')
  const [localPart, setLocalPart] = useState('')
  const [domain, setDomain] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const domains = config?.domains ?? []
  const configured = config?.addresses ?? []
  const availableAddresses = configured.filter((entry) => !accounts.some((account) => account.address.toLowerCase() === entry.toLowerCase()))
  const canCreate = configured.length > 0 ? availableAddresses.length > 0 : domains.length > 0

  const openCreate = (): void => {
    setAddress(availableAddresses[0] ?? '')
    setLocalPart('')
    setDomain(domains[0] ?? '')
    setDisplayName('')
    setFormError(null)
    setCreating(true)
  }

  const close = (): void => {
    if (busy) return
    setCreating(false)
    onClose()
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    let trimmedLocalPart = localPart.trim().toLowerCase()
    let chosenDomain = domain
    if (configured.length > 0) {
      if (!availableAddresses.includes(address)) {
        setFormError(t('email.accounts.address_required'))
        return
      }
      const [local, host] = address.split('@')
      trimmedLocalPart = local ?? ''
      chosenDomain = host ?? ''
    } else {
      if (!trimmedLocalPart || !LOCAL_PART.test(trimmedLocalPart) || trimmedLocalPart.startsWith('.') || trimmedLocalPart.endsWith('.') || trimmedLocalPart.includes('..')) {
        setFormError(t('email.accounts.local_part_invalid'))
        return
      }
      if (!chosenDomain) {
        setFormError(t('email.accounts.domain_required'))
        return
      }
    }
    setBusy(true)
    setFormError(null)
    try {
      const account = await createAccount({
        localPart: trimmedLocalPart,
        domain: chosenDomain,
        displayName: displayName.trim() || undefined,
      })
      useUi.getState().toast({ title: t('email.accounts.created'), tone: 'success' })
      setCreating(false)
      onClose()
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
    setBusy(true)
    try {
      await deleteAccount(account.id)
      useUi.getState().toast({ title: t('email.accounts.deleted'), tone: 'success' })
      const next = useEmailStore.getState().accounts[0]
      if (next) navigateToPath(emailFolderPath(next.id, 'inbox'))
      else onClose()
    } catch (error) {
      reportFailure(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('email.accounts.manage_title')}
      description={t('email.accounts.manage_hint')}
      width={600}
      dismissible={!busy}
      footer={canCreate && !creating
        ? (
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>{t('common.close')}</Button>
              <Button variant="primary" icon={<Plus size={14} />} onClick={openCreate} disabled={busy}>
                {t('email.accounts.create')}
              </Button>
            </>
          )
        : <Button variant="ghost" onClick={close} disabled={busy}>{t('common.close')}</Button>}
    >
      {accountsError && accounts.length > 0 && (
        <div role="alert" className="mb-3 flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--text-11-5)] text-[var(--danger)]">
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
          description={canCreate ? t('email.empty_hint') : t('email.no_domain')}
          action={canCreate ? <Button size="sm" icon={<Plus size={14} />} onClick={openCreate}>{t('email.accounts.create')}</Button> : undefined}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {accounts.map((account) => {
            const active = account.id === activeAccountId
            const name = account.displayName || account.address
            return (
              <li key={account.id} className="flex items-center gap-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] pr-1">
                <button
                  type="button"
                  onClick={() => {
                    onClose()
                    navigateToPath(emailFolderPath(account.id, 'inbox'))
                  }}
                  aria-current={active ? 'true' : undefined}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--r-md)] px-3 py-2.5 text-left hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-inset"
                >
                  <Avatar name={name} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{name}</span>
                    <span className="block truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{account.address}</span>
                  </span>
                  {active && <span className="shrink-0 text-[length:var(--text-10-5)] font-medium text-[var(--accent)]">{t('email.accounts.active')}</span>}
                </button>
                <Tooltip label={t('email.header.settings')} side="top">
                  <IconButton label={t('email.header.settings')} size="sm" disabled={busy} onClick={() => { onClose(); onOpenSettings(account.id) }}>
                    <Settings2 size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label={t('email.accounts.delete_address', { address: account.address })} side="top">
                  <IconButton
                    label={t('email.accounts.delete_address', { address: account.address })}
                    size="sm"
                    disabled={busy}
                    onClick={() => { void remove(account) }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </Tooltip>
              </li>
            )
          })}
        </ul>
      )}
      {creating && (
        <form onSubmit={(event) => { void submit(event) }} className="mt-4 space-y-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
          <div className="flex items-center gap-2">
            <Mail size={15} className="text-[var(--text-tertiary)]" aria-hidden="true" />
            <span className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('email.accounts.create_title')}</span>
          </div>
          <p className="m-0 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('email.accounts.create_hint')}</p>
          {configured.length > 0 ? (
            <Field label={t('email.accounts.address')} required>
              <Select value={address} onChange={(event) => setAddress(event.target.value)}>
                {availableAddresses.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </Select>
            </Field>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label={t('email.accounts.local_part')} required>
                <Input value={localPart} onChange={(event) => setLocalPart(event.target.value)} autoComplete="off" data-autofocus />
              </Field>
              <Field label={t('email.accounts.domain')} required>
                <Select value={domain} onChange={(event) => setDomain(event.target.value)}>
                  {domains.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </Select>
              </Field>
            </div>
          )}
          <Field label={t('email.accounts.display_name')}>
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="off" />
          </Field>
          {formError && (
            <p role="alert" className="m-0 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">{formError}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)} disabled={busy}>{t('common.cancel')}</Button>
            <Button size="sm" variant="primary" type="submit" loading={busy}>{t('email.accounts.create')}</Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
