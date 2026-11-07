import { useMemo } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { DecryptedAccount } from '@shared/tools/password/types'
import { t } from '../../../lib/i18n'
import { Empty } from '../../../components/feedback'
import { usePasswordVaultStore } from './store'
import { analyzeVault } from './utils/health'

const SECTIONS = [
  { key: 'weak', labelKey: 'tools.password.health.weak', tone: 'text-[var(--danger)]' },
  { key: 'reused', labelKey: 'tools.password.health.reused', tone: 'text-[var(--warning)]' },
  {
    key: 'stale',
    labelKey: 'tools.password.health.stale',
    tone: 'text-[var(--warning)]',
    hintKey: 'tools.password.health.stale_hint',
  },
  { key: 'incomplete', labelKey: 'tools.password.health.incomplete', tone: 'text-[var(--text-secondary)]' },
  { key: 'totpUnreadable', labelKey: 'tools.password.health.totp_unreadable', tone: 'text-[var(--danger)]' },
  { key: 'decryptUnreadable', labelKey: 'tools.password.health.decrypt_unreadable', tone: 'text-[var(--danger)]' },
] as const

/**
 * What the vault looks like from the inside: weak, repeated, old and half-filled credentials.
 *
 * Everything is computed from the decrypted rows the module already keeps in memory, so this view
 * costs one pass over the list and sends nothing anywhere.
 */
export function PasswordHealthView() {
  const accounts = usePasswordVaultStore((s) => s.accounts)
  const decryptedAccounts = usePasswordVaultStore((s) => s.decryptedAccounts)
  const setSelectedAccountId = usePasswordVaultStore((s) => s.setSelectedAccountId)
  const setActiveView = usePasswordVaultStore((s) => s.setActiveView)

  const rows = useMemo(
    () =>
      accounts
        .map((account) => decryptedAccounts[account.id])
        .filter((account): account is DecryptedAccount => Boolean(account)),
    [accounts, decryptedAccounts],
  )
  const health = useMemo(() => analyzeVault(rows), [rows])

  const openAccount = (id: string) => {
    setSelectedAccountId(id)
    setActiveView('all')
  }

  return (
    <div
      data-testid="password-health-view"
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg-base)] p-4 md:p-6"
    >
      <header className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--r-lg)] bg-[var(--accent-soft)] text-[var(--accent)]">
          <ShieldCheck size={20} aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
            {t('tools.password.health.title')}
          </h2>
          <p className="mt-0.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('tools.password.health.summary', {
              total: String(health.total),
              totp: String(health.withTotp),
            })}
          </p>
        </div>
      </header>

      {health.total === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty art="notes" title={t('tools.password.health.empty')} />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {SECTIONS.map((section) => {
            const items = health[section.key]
            return (
              <section
                key={section.key}
                aria-labelledby={`health-${section.key}`}
                className="flex flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
              >
                <div className="flex items-baseline justify-between gap-2 border-b border-[var(--border-subtle)] p-3">
                  <h3
                    id={`health-${section.key}`}
                    className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]"
                  >
                    {t(section.labelKey)}
                  </h3>
                  <span className={`text-[length:var(--text-12)] font-medium ${section.tone}`}>
                    {items.length}
                  </span>
                </div>

                {items.length === 0 ? (
                  <p className="p-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {t('tools.password.health.clear')}
                  </p>
                ) : (
                  <>
                    {'hintKey' in section && section.hintKey ? (
                      <p className="border-b border-[var(--border-subtle)] px-3 pb-2 pt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                        {t(section.hintKey)}
                      </p>
                    ) : null}
                    <ul className="max-h-56 divide-y divide-[var(--border-subtle)] overflow-y-auto">
                      {items.map((account) => (
                        <li key={`${section.key}-${account.id}`}>
                          <button
                            type="button"
                            onClick={() => openAccount(account.id)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                          >
                            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
                              {account.title || t('tools.password.account.title')}
                            </span>
                            <span className="min-w-0 max-w-[45%] truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                              {account.username || account.link}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
