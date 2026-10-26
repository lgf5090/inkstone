import { useMemo, useState, type ChangeEvent } from 'react'
import { Search as SearchIcon, X, Star } from 'lucide-react'
import type { DecryptedAccount } from '@shared/tools/password/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { Empty } from '../../../components/feedback'
import { Input } from '../../../components/form'
import { usePasswordVaultStore } from './store'
import { FaviconAvatar } from './FaviconAvatar'
import { AccountForm } from './AccountForm'

export function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query.trim() || !text) return <span>{text}</span>

  const q = query.trim()
  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  const parts = text.split(regex)

  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark
            key={i}
            className="rounded bg-[var(--accent-soft)] px-0.5 font-semibold text-[var(--accent)]"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  )
}

export function Search({ className }: { className?: string }) {
  const accounts = usePasswordVaultStore((s) => s.accounts)
  const decryptedAccounts = usePasswordVaultStore((s) => s.decryptedAccounts)
  const selectedAccountId = usePasswordVaultStore((s) => s.selectedAccountId)
  const setSelectedAccountId = usePasswordVaultStore((s) => s.setSelectedAccountId)
  const toggleFavorite = usePasswordVaultStore((s) => s.toggleFavorite)

  const [query, setQuery] = useState('')

  const allDecrypted = useMemo(() => {
    return accounts
      .map((a) => decryptedAccounts[a.id])
      .filter((a): a is DecryptedAccount => Boolean(a))
  }, [accounts, decryptedAccounts])

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []

    return allDecrypted.filter((a) => {
      return (
        a.title.toLowerCase().includes(q) ||
        a.username.toLowerCase().includes(q) ||
        a.link.toLowerCase().includes(q) ||
        a.remark.toLowerCase().includes(q)
      )
    })
  }, [allDecrypted, query])

  return (
    <div
      data-testid="password-search-view"
      className={cn('flex h-full min-h-0 flex-1 overflow-hidden bg-[var(--bg-base)]', className)}
    >
      {/* Search and results column */}
      <div className="flex h-full min-h-0 w-full md:w-80 lg:w-96 shrink-0 flex-col border-r border-[var(--border-subtle)]">
        {/* Search Input Bar */}
        <div className="shrink-0 border-b border-[var(--border-subtle)] p-3">
          <Input
            value={query}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            placeholder={t('tools.password.account.search_placeholder')}
            leading={<SearchIcon size={14} />}
            trailing={
              query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={t('tools.password.search.clear')}
                  className="rounded p-0.5 text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"
                >
                  <X size={13} />
                </button>
              ) : null
            }
            className="h-8 w-full text-[length:var(--text-12)]"
            autoFocus
            data-testid="global-search-input"
          />

          {query.trim() && (
            <div className="mt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.password.search.results_count', { count: searchResults.length })}
            </div>
          )}
        </div>

        {/* Results List or Empty State */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {!query.trim() ? (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center">
              <Empty
                art="search"
                title={t('tools.password.search.title')}
                description={t('tools.password.search.desc')}
              />
            </div>
          ) : searchResults.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center">
              <Empty
                art="search"
                title={t('tools.password.search.not_found')}
                description={t('tools.password.search.not_found_desc', { query })}
              />
            </div>
          ) : (
            searchResults.map((acc) => {
              const isSelected = acc.id === selectedAccountId
              return (
                <div
                  key={acc.id}
                  data-testid="search-result-item"
                  className="group relative flex items-center gap-1"
                >
                  {/* Same split as the account card: the row is a button, the star is its own control. */}
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={acc.title || t('tools.password.account.title')}
                    data-testid="search-result-row"
                    onClick={() => setSelectedAccountId(acc.id)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-3 rounded-lg border px-3 py-2 text-left select-none transition-colors duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                      isSelected
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]/20 shadow-sm'
                        : 'border-transparent bg-transparent hover:bg-[var(--bg-hover)]',
                    )}
                  >
                  <FaviconAvatar
                    url={acc.link}
                    title={acc.title}
                    favicon={acc.favicon}
                    size={34}
                  />

                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium text-[length:var(--text-13)]">
                      <HighlightMatch
                        text={acc.title || t('tools.password.account.title')}
                        query={query}
                      />
                    </div>
                    <div className="truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                      <HighlightMatch text={acc.username || acc.link || '-'} query={query} />
                    </div>
                  </div>
                  </button>

                  <button
                    type="button"
                    aria-label={
                      acc.isFavorite
                        ? t('tools.password.account.unfavorite')
                        : t('tools.password.account.favorite')
                    }
                    onClick={(e) => {
                      e.stopPropagation()
                      void toggleFavorite(acc.id)
                    }}
                    className="shrink-0 p-1 rounded-md text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-amber-400"
                  >
                    <Star
                      size={16}
                      className={cn(
                        acc.isFavorite
                          ? 'fill-amber-400 text-amber-400'
                          : 'text-[var(--text-quaternary)]',
                      )}
                    />
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Detail Form pane on desktop */}
      <div className="hidden md:flex flex-1 min-w-0 h-full overflow-hidden">
        <AccountForm />
      </div>
    </div>
  )
}
