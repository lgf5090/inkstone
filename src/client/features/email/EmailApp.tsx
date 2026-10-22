import { useEffect, useState } from 'react'
import type { EmailAccount, EmailConfig } from '@shared/email/model'
import { Button, Spinner } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { useLocale, t } from '../../lib/i18n'
import { navigateToPath, usePathname, useSearch } from '../../lib/app-history'
import { api, ApiError } from '../../lib/api'
import { useSession } from '../../store/session'
import { emailAccountPath, parseEmailAddress } from './email-address'

export function EmailApp() {
  useLocale()
  const pathname = usePathname()
  const search = useSearch()
  const address = parseEmailAddress(pathname, search)
  const sessionStatus = useSession((state) => state.status)
  const role = useSession((state) => state.user?.role)
  const [config, setConfig] = useState<EmailConfig | null>(null)
  const [accounts, setAccounts] = useState<EmailAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const nextConfig = await api.email.getConfig()
        let nextAccounts = await api.email.listAccounts()
        if (nextConfig.addresses.length > 0) {
          const created = await api.email.ensureAccounts().catch(() => [])
          if (created.length) nextAccounts = await api.email.listAccounts()
        }
        if (cancelled) return
        setConfig(nextConfig)
        setAccounts(nextAccounts)
      } catch (reason) {
        if (cancelled) return
        setError(reason instanceof ApiError ? reason.message : (reason as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [nonce])

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
  if (address.kind !== 'home') {
    const account = accounts.find((entry) => entry.id === address.accountId)
    return (
      <div className="flex h-full flex-col bg-[var(--bg-base)]">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-4">
          <Button size="sm" variant="ghost" onClick={() => navigateToPath('/email')}>
            {t('email.back')}
          </Button>
          <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {account?.displayName ?? account?.address ?? t('email.title')}
          </span>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Empty
            art="archive"
            title={t('email.shell_title')}
            description={t('email.shell_placeholder')}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-4">
        <h1 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('email.title')}</h1>
        {loading && <Spinner />}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading && accounts.length === 0 ? (
          <LoadingBlock label={t('email.loading')} />
        ) : error ? (
          <Empty
            art="archive"
            title={t('email.error_load')}
            description={error}
            action={<Button size="sm" onClick={() => setNonce((value) => value + 1)}>{t('common.retry')}</Button>}
          />
        ) : accounts.length === 0 ? (
          <Empty
            art="archive"
            title={t('email.empty_title')}
            description={config && config.domains.length === 0 ? t('email.no_domain') : t('email.empty_hint')}
          />
        ) : (
          <ul className="mx-auto flex max-w-2xl flex-col gap-1">
            {accounts.map((account) => (
              <li key={account.id}>
                <button
                  type="button"
                  onClick={() => navigateToPath(emailAccountPath(account.id))}
                  className="flex w-full items-center gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-inset)] text-[length:var(--text-13)] font-semibold text-[var(--text-secondary)]">
                    {(account.displayName || account.address).charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{account.displayName}</span>
                    <span className="block truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">{account.address}</span>
                  </span>
                  <span className="shrink-0 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.open')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
