import { useEffect, useState } from 'react'
import { MailPlus } from 'lucide-react'
import { Button, Spinner } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { useLocale, t } from '../../lib/i18n'
import { usePathname, useSearch } from '../../lib/app-history'
import { useSession } from '../../store/session'
import { AccountManagerDialog } from './AccountManagerDialog'
import { DeploymentSettingsDialog } from './DeploymentSettings'
import { MailboxPage, type EmailWorkspacePanel } from './MailboxPage'
import { parseEmailAddress } from './email-address'
import { useEmailStore } from './store'

function baseAddress(accountId: string): Parameters<typeof MailboxPage>[0]['address'] {
  return { kind: 'mailbox', accountId, folderId: 'inbox', messageId: null, compose: null, draftId: null }
}

function panelFor(kind: 'home' | 'contacts' | 'settings' | 'stats' | 'rules' | 'templates'): EmailWorkspacePanel | null {
  if (kind === 'home') return null
  return kind
}

function NoMailboxState() {
  const [open, setOpen] = useState(false)
  const [deploymentOpen, setDeploymentOpen] = useState(false)
  const loadAccounts = useEmailStore((state) => state.loadAccounts)
  return (
    <div className="flex h-full items-center justify-center bg-[var(--bg-base)]">
      <Empty
        art="archive"
        title={t('email.empty_title')}
        description={t('email.empty_hint')}
        action={(
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" icon={<MailPlus size={14} />} onClick={() => setOpen(true)}>
              {t('email.accounts.create')}
            </Button>
            <Button size="sm" onClick={() => setDeploymentOpen(true)}>
              {t('email.settings.delivery')}
            </Button>
          </div>
        )}
      />
      <AccountManagerDialog
        open={open}
        onClose={() => setOpen(false)}
        activeAccountId=""
        onOpenSettings={() => undefined}
        onOpenDeployment={() => { setOpen(false); setDeploymentOpen(true) }}
      />
      <DeploymentSettingsDialog
        open={deploymentOpen}
        onClose={() => setDeploymentOpen(false)}
        onSaved={() => { void loadAccounts() }}
      />
    </div>
  )
}

export function EmailApp() {
  useLocale()
  const pathname = usePathname()
  const search = useSearch()
  const address = parseEmailAddress(pathname, search)
  const sessionStatus = useSession((state) => state.status)
  const role = useSession((state) => state.user?.role)
  const accounts = useEmailStore((state) => state.accounts)
  const accountsStatus = useEmailStore((state) => state.accountsStatus)
  const accountsError = useEmailStore((state) => state.accountsError)
  const loadAccounts = useEmailStore((state) => state.loadAccounts)

  useEffect(() => {
    if (sessionStatus !== 'authed' || role !== 'owner') return
    if (accountsStatus === 'idle') void loadAccounts()
  }, [accountsStatus, loadAccounts, role, sessionStatus])

  if (sessionStatus !== 'authed') {
    return <div className="flex h-full items-center justify-center"><Spinner /></div>
  }
  if (role !== 'owner') {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-base)]">
        <Empty
          art="archive"
          title={t('email.owner_only_title')}
          description={t('email.owner_only_hint')}
        />
      </div>
    )
  }
  if (accountsStatus === 'loading' || accountsStatus === 'idle') {
    return <LoadingBlock label={t('email.loading')} />
  }
  if (accountsStatus === 'error' && accounts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-base)]">
        <Empty
          art="archive"
          title={t('email.error_load')}
          description={accountsError}
          action={<Button size="sm" onClick={() => { void loadAccounts() }}>{t('common.retry')}</Button>}
        />
      </div>
    )
  }

  if (address.kind === 'home') {
    const account = accounts[0]
    if (!account) return <NoMailboxState />
    return <MailboxPage address={baseAddress(account.id)} account={account} />
  }
  if (address.kind === 'contacts') {
    const account = accounts[0]
    if (!account) return <NoMailboxState />
    return <MailboxPage address={baseAddress(account.id)} account={account} panel={panelFor('contacts')} />
  }
  if (address.kind === 'settings' || address.kind === 'stats' || address.kind === 'rules' || address.kind === 'templates') {
    const account = accounts.find((entry) => entry.id === address.accountId)
    if (!account) {
      return (
        <div className="flex h-full items-center justify-center bg-[var(--bg-base)]">
          <Empty
            art="folder"
            title={t('email.account_missing')}
            description={t('email.account_missing_hint')}
            action={<Button size="sm" onClick={() => { void loadAccounts() }}>{t('common.retry')}</Button>}
          />
        </div>
      )
    }
    const panel: EmailWorkspacePanel = address.kind
    return <MailboxPage address={baseAddress(account.id)} account={account} panel={panel} />
  }

  const account = accounts.find((entry) => entry.id === address.accountId)
  if (!account) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-base)]">
        <Empty
          art="folder"
          title={t('email.account_missing')}
          description={t('email.account_missing_hint')}
          action={<Button size="sm" onClick={() => { void loadAccounts() }}>{t('common.retry')}</Button>}
        />
      </div>
    )
  }
  return <MailboxPage address={address} account={account} />
}
