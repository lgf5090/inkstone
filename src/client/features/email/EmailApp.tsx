import { useEffect } from 'react'
import { Button, Spinner } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { useLocale, t } from '../../lib/i18n'
import { navigateToPath, usePathname, useSearch } from '../../lib/app-history'
import { useSession } from '../../store/session'
import { AccountListPage } from './AccountListPage'
import { AccountSettingsPage } from './AccountSettingsPage'
import { MailboxPage } from './MailboxPage'
import { parseEmailAddress } from './email-address'
import { useEmailStore } from './store'

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
  if (address.kind === 'home') return <AccountListPage />
  if (address.kind === 'settings') return <AccountSettingsPage accountId={address.accountId} />

  const account = accounts.find((entry) => entry.id === address.accountId)
  if (!account) {
    if (accountsStatus === 'loading' || accountsStatus === 'idle') {
      return <LoadingBlock label={t('email.loading')} />
    }
    if (accountsStatus === 'error') {
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
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-base)]">
        <Empty
          art="folder"
          title={t('email.account_missing')}
          description={t('email.account_missing_hint')}
          action={<Button size="sm" onClick={() => navigateToPath('/email')}>{t('email.back')}</Button>}
        />
      </div>
    )
  }
  return <MailboxPage address={address} account={account} />
}
