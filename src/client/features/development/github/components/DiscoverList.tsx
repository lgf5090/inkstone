import { AlertCircle, Calendar, Download, ExternalLink, Package, PanelLeft, Star } from 'lucide-react'
import type { GithubDiscoverItem, GithubDiscoverResult, GithubRepo } from '@shared/development/github/types'
import { GITHUB_DISCOVER_MAX_PAGE } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Empty } from '../../../../components/feedback'
import { formatDate, formatNumber } from '../lib/format'
import { GithubAvatar } from './GithubAvatar'
import { platformLabel } from './StoreSidebar'

function ReleaseChips({ item }: { item: GithubDiscoverItem }) {
  const release = item.release
  if (!release) {
    return <span className="rounded-full bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.store.no_release')}</span>
  }
  return (
    <>
      <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--accent-on-soft)]">{release.tagName}</span>
      {release.platforms.map((platform) => (
        <span key={platform} className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{platformLabel(platform)}</span>
      ))}
      <span className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]"><Download size={10} />{t('development.github.store.downloads', { count: formatNumber(release.downloadCount) })}</span>
      <span className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]"><Calendar size={10} />{formatDate(release.publishedAt)}</span>
    </>
  )
}

export function DiscoverList({
  result,
  loading,
  error,
  onRetry,
  page,
  onPageChange,
  onSelectRepo,
  onClearFilters,
  onOpenSidebar,
}: {
  result: GithubDiscoverResult | null
  loading: boolean
  error: Error | null
  onRetry: () => void
  page: number
  onPageChange: (page: number) => void
  onSelectRepo: (repo: GithubRepo) => void
  onClearFilters: () => void
  onOpenSidebar: () => void
}) {
  if (loading && !result) {
    return <div className="flex h-full items-center justify-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]"><Spinner size={15} />{t('development.github.common.loading')}</div>
  }
  if (error && !result) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty art="search" title={t('development.github.store.load_failed')} description={error.message} action={<Button size="sm" onClick={onRetry}>{t('development.github.common.retry')}</Button>} />
      </div>
    )
  }
  if (!result || result.items.length === 0) {
    const hasNextPage = Boolean(result && page < GITHUB_DISCOVER_MAX_PAGE && page * result.perPage < result.total)
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty
          art="search"
          title={t('development.github.store.empty_title')}
          description={t('development.github.store.empty_desc')}
          action={<span className="flex items-center gap-1.5">{hasNextPage && <Button size="sm" onClick={() => onPageChange(page + 1)}>{t('development.github.store.next')}</Button>}<Button size="sm" variant="secondary" onClick={onClearFilters}>{t('development.github.store.clear_filters')}</Button></span>}
        />
      </div>
    )
  }
  const hasNext = page < GITHUB_DISCOVER_MAX_PAGE && page * result.perPage < result.total
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        <IconButton label={t('development.github.common.toggle_sidebar')} size="sm" className="size-8 md:size-8" onClick={onOpenSidebar}><PanelLeft size={15} /></IconButton>
        <Package size={13} className="text-[var(--text-tertiary)]" />
        <span>{t('development.github.store.results', { count: formatNumber(result.total) })}</span>
        <span className="ml-auto">{result.verified ? t('development.github.store.verified_hint') : t('development.github.store.unverified_hint')}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        <ul className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {result.items.map((item) => (
            <li key={item.repo.id}>
              <button
                type="button"
                onClick={() => onSelectRepo(item.repo)}
                className="flex h-full w-full flex-col gap-1.5 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              >
                <span className="flex items-start gap-2">
                  <GithubAvatar src={item.repo.owner.avatarUrl} name={item.repo.owner.login} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{item.repo.owner.login}/<span className="text-[var(--accent)]">{item.repo.name}</span></span>
                    <span className="mt-0.5 line-clamp-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{item.repo.description || t('development.github.store.no_description')}</span>
                  </span>
                  <ExternalLink size={12} className="mt-1 shrink-0 text-[var(--text-quaternary)]" />
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <ReleaseChips item={item} />
                </span>
                <span className="mt-auto flex flex-wrap items-center gap-3 pt-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  <span className="inline-flex items-center gap-1"><Star size={10} />{formatNumber(item.repo.stargazersCount)}</span>
                  {item.repo.language && <span>{item.repo.language}</span>}
                  <span className="ml-auto inline-flex items-center gap-1">{t('development.github.store.open')} <ExternalLink size={10} /></span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <span>{t('development.github.store.page', { page })}</span>
        <span className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={() => onPageChange(page - 1)}>{t('development.github.store.previous')}</Button>
          <Button variant="secondary" size="sm" disabled={!hasNext || loading} onClick={() => onPageChange(page + 1)}>{t('development.github.store.next')}</Button>
        </span>
        {error && <span role="alert" className="inline-flex items-center gap-1 text-[var(--danger)]"><AlertCircle size={11} />{error.message}</span>}
      </div>
    </div>
  )
}
