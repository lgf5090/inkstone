import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Calendar, ExternalLink, Star, Users } from 'lucide-react'
import type { GithubDevProfile, GithubRepo } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { Button, Spinner } from '../../../../components/primitives'
import { Modal } from '../../../../components/overlay'
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.github.dev_profile.title')}
      ariaLabel={t('development.github.dev_profile.title')}
      width={620}
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
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-1.5">
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.dev_profile.followers')}</p>
              <p className="text-[length:var(--text-12)] font-medium">{formatNumber(profile.followers)}</p>
            </div>
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-1.5">
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.dev_profile.following')}</p>
              <p className="text-[length:var(--text-12)] font-medium">{formatNumber(profile.following)}</p>
            </div>
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-1.5">
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.dev_profile.public_repos')}</p>
              <p className="text-[length:var(--text-12)] font-medium">{formatNumber(profile.publicRepos)}</p>
            </div>
            <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 py-1.5">
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.dev_profile.joined')}</p>
              <p className="truncate text-[length:var(--text-12)] font-medium">{formatDate(profile.createdAt)}</p>
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
            <p className="mb-1.5 text-[length:var(--text-11)] font-medium tracking-wide text-[var(--text-quaternary)] uppercase">{t('development.github.dev_profile.repos')}</p>
            {profile.repos.length === 0 ? (
              <p className="rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] p-4 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.github.dev_profile.no_repos')}</p>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">
                {profile.repos.map((repo) => (
                  <li key={repo.id}>
                    <button
                      type="button"
                      onClick={() => { onOpenRepo(repo); onClose() }}
                      className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[length:var(--text-11)] transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-[var(--text-secondary)]">{repo.name}</span>
                        {repo.description && <span className="block truncate text-[var(--text-quaternary)]">{repo.description}</span>}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-[var(--text-quaternary)]"><Star size={10} />{formatNumber(repo.stargazersCount)}</span>
                      {repo.language && <span className="hidden shrink-0 text-[var(--text-quaternary)] sm:inline">{repo.language}</span>}
                      <Calendar size={10} className="shrink-0 text-[var(--text-quaternary)]" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]"><Users size={11} />{t('development.github.dev_profile.note')}</p>
        </div>
      )}
    </Modal>
  )
}
