import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ExternalLink, Search, Star } from 'lucide-react'
import type { GithubDevProfile, GithubRepo } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { Button, Spinner } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { githubApi } from '../api'
import { formatDate, formatNumber } from '../lib/format'
import { GithubAvatar } from './GithubAvatar'

export function DeveloperDialog({
  open,
  login,
  onClose,
  onOpenRepo,
}: {
  open: boolean
  login: string | null
  onClose: () => void
  onOpenRepo: (repo: GithubRepo) => void
}) {
  const [profile, setProfile] = useState<GithubDevProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [repoQuery, setRepoQuery] = useState('')
  const [repoSort, setRepoSort] = useState<'updated' | 'stars' | 'name'>('updated')

  useEffect(() => {
    if (!open || !login) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    githubApi.devProfile(login, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setProfile(next)
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setProfile(null)
        setError(failure instanceof Error ? failure.message : t('development.github.dev_profile.failed'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [open, login, attempt])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  const visibleRepos = useMemo(() => {
    const needle = repoQuery.trim().toLowerCase()
    const matched = needle
      ? (profile?.repos ?? []).filter((repo) => repo.name.toLowerCase().includes(needle) || (repo.description ?? '').toLowerCase().includes(needle))
      : (profile?.repos ?? [])
    return [...matched].sort((left, right) => {
      if (repoSort === 'name') return left.name.localeCompare(right.name)
      if (repoSort === 'stars') return right.stargazersCount - left.stargazersCount
      return right.updatedAt.localeCompare(left.updatedAt)
    })
  }, [profile, repoQuery, repoSort])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.github.dev_profile.title')}
      ariaLabel={t('development.github.dev_profile.title')}
      width={620}
      footer={<Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>}
    >
      {loading && (
        <div className="flex items-center justify-center gap-2 py-10 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          <Spinner size={15} />{t('development.github.common.loading')}
        </div>
      )}
      {!loading && error && (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <AlertCircle size={22} className="text-[var(--danger)]" />
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{error}</p>
          <Button variant="secondary" size="sm" onClick={retry}>{t('development.github.common.retry')}</Button>
        </div>
      )}
      {!loading && !error && profile && (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <GithubAvatar src={profile.avatarUrl} name={profile.login} size={52} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[length:var(--text-15)] font-semibold">{profile.name || profile.login}</p>
              <a href={profile.htmlUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[length:var(--text-12)] text-[var(--accent)] hover:underline">
                @{profile.login}<ExternalLink size={11} />
              </a>
              {profile.bio && <p className="mt-1 whitespace-pre-wrap text-[length:var(--text-12)] text-[var(--text-secondary)]">{profile.bio}</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-[var(--border-subtle)] py-2 sm:grid-cols-4">
            <div>
              <p className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('development.github.dev_profile.followers')}</p>
              <p className="text-[length:var(--text-12)] font-medium tabular-nums text-[var(--text-secondary)]">{formatNumber(profile.followers)}</p>
            </div>
            <div>
              <p className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('development.github.dev_profile.following')}</p>
              <p className="text-[length:var(--text-12)] font-medium tabular-nums text-[var(--text-secondary)]">{formatNumber(profile.following)}</p>
            </div>
            <div>
              <p className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('development.github.dev_profile.public_repos')}</p>
              <p className="text-[length:var(--text-12)] font-medium tabular-nums text-[var(--text-secondary)]">{formatNumber(profile.publicRepos)}</p>
            </div>
            <div>
              <p className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('development.github.dev_profile.joined')}</p>
              <p className="text-[length:var(--text-12)] font-medium tabular-nums text-[var(--text-secondary)]">{formatDate(profile.createdAt)}</p>
            </div>
          </div>
          {(profile.company || profile.location || profile.blog) && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {profile.company && <span>{profile.company}</span>}
              {profile.location && <span>{profile.location}</span>}
              {profile.blog && <a href={profile.blog} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">{profile.blog}</a>}
            </div>
          )}
          <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <p className="text-[length:var(--text-11)] font-medium tracking-wide text-[var(--text-quaternary)] uppercase">{t('development.github.dev_profile.repos')}</p>
              <span className="text-[length:var(--text-10)] tabular-nums text-[var(--text-quaternary)]">{visibleRepos.length}/{profile.repos.length}</span>
              <div className="relative ml-auto min-w-32 flex-1 sm:max-w-56">
                <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" />
                <Input value={repoQuery} onChange={(event) => setRepoQuery(event.target.value)} placeholder={t('development.github.dev_profile.repo_search')} aria-label={t('development.github.dev_profile.repo_search')} className="h-7 pl-7 text-[length:var(--text-11)]" />
              </div>
              <SelectMenu
                label={t('development.github.dev_profile.repo_sort')}
                value={repoSort}
                size="sm"
                width={150}
                align="end"
                className="w-auto shrink-0"
                options={[
                  { value: 'updated', label: t('development.github.dev_profile.sort_updated') },
                  { value: 'stars', label: t('development.github.dev_profile.sort_stars') },
                  { value: 'name', label: t('development.github.dev_profile.sort_name') },
                ]}
                onChange={setRepoSort}
              />
            </div>
            {profile.repos.length === 0 ? (
              <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.github.dev_profile.no_repos')}</p>
            ) : visibleRepos.length === 0 ? (
              <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.github.dev_profile.no_repo_matches')}</p>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">
                {visibleRepos.map((repo) => (
                  <li key={repo.id}>
                    <button
                      type="button"
                      onClick={() => { onOpenRepo(repo); onClose() }}
                      className="group flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[length:var(--text-12)] font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">{repo.name}</span>
                        {repo.description && <span className="block truncate text-[length:var(--text-10)] text-[var(--text-quaternary)]">{repo.description}</span>}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-[length:var(--text-10)] tabular-nums text-[var(--text-quaternary)]"><Star size={10} />{formatNumber(repo.stargazersCount)}</span>
                      {repo.language && <span className="hidden shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)] sm:inline">{repo.language}</span>}
                      <span className="hidden shrink-0 text-[length:var(--text-10)] tabular-nums text-[var(--text-quaternary)] md:inline">{formatDate(repo.updatedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
