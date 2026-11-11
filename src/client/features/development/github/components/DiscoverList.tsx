import { AlertCircle, Download, PanelLeft, RefreshCw, ShieldCheck, Star } from 'lucide-react'
import type { GithubDiscoverItem, GithubDiscoverResult, GithubRepo } from '@shared/development/github/types'
import { GITHUB_DISCOVER_MAX_PAGE, GITHUB_DISCOVER_TOPICS } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { Badge, Button, IconButton, Spinner } from '../../../../components/primitives'
import { Empty, Skeleton } from '../../../../components/feedback'
import { formatDate, formatNumber } from '../lib/format'
import { GithubAvatar } from './GithubAvatar'
import { platformLabel } from './StoreSidebar'

function chartLabel(result: GithubDiscoverResult | null): string {
  if (!result) return t('development.github.store.discover')
  return t(`development.github.store.chart.${result.chart}` as Parameters<typeof t>[0])
}

function topicLabel(topic: string): string {
  const entry = GITHUB_DISCOVER_TOPICS.find((candidate) => candidate.value === topic)
  return entry ? t(entry.labelKey) : topic
}

function ReleaseMeta({ item }: { item: GithubDiscoverItem }) {
  const release = item.release
  if (!release) {
    return <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('development.github.store.no_release')}</span>
  }
  return (
    <>
      <Badge tone="accent">{release.tagName}</Badge>
      {release.platforms.length > 0 && (
        <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">
          {release.platforms.map((platform) => platformLabel(platform)).join(' · ')}
        </span>
      )}
    </>
  )
}

export function DiscoverList({
  result,
  loading,
  error,
  onRetry,
  onRefresh,
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
  onRefresh: () => void
  page: number
  onPageChange: (page: number) => void
  onSelectRepo: (repo: GithubRepo) => void
  onClearFilters: () => void
  onOpenSidebar: () => void
}) {
  const hasNext = Boolean(result && page < GITHUB_DISCOVER_MAX_PAGE && page * result.perPage < result.total)
  const hasFilters = Boolean(result && (result.platform !== 'all' || result.topic !== ''))
  const showEmpty = Boolean(result && result.items.length === 0)

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="github-discover">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('development.github.common.toggle_sidebar')} size="sm" className="size-8 shrink-0 md:size-8" onClick={onOpenSidebar}><PanelLeft size={15} /></IconButton>
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{chartLabel(result)}</span>
        {result && <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{t('development.github.store.results', { count: formatNumber(result.total) })}</span>}
        {result?.platform !== undefined && result.platform !== 'all' && <Badge tone="neutral">{platformLabel(result.platform)}</Badge>}
        {result?.topic && <Badge tone="neutral">{topicLabel(result.topic)}</Badge>}
        {loading && result && <Spinner size={12} className="text-[var(--text-quaternary)]" />}
        {result && (
          <span className="ml-auto flex items-center gap-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
            <ShieldCheck size={11} />
            <span className="hidden sm:inline">{result.verified ? t('development.github.store.verified_hint') : t('development.github.store.unverified_hint')}</span>
          </span>
        )}
        <IconButton label={t('development.github.store.refresh')} size="sm" className="size-8 shrink-0 md:size-8" onClick={onRefresh}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></IconButton>
      </div>

      {error && result && (
        <div className="flex shrink-0 items-center gap-2 bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]" role="alert">
          <AlertCircle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{error.message}</span>
          <Button size="sm" variant="ghost" onClick={onRetry}>{t('development.github.common.retry')}</Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {loading && !result ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2" aria-label={t('development.github.common.loading')}>
            {Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-[108px] rounded-[var(--r-md)]" />)}
          </div>
        ) : error && !result ? (
          <div className="flex h-full items-center justify-center">
            <Empty
              art="search"
              title={t('development.github.store.load_failed')}
              description={error.message}
              action={<span className="flex flex-wrap items-center justify-center gap-2"><Button size="sm" onClick={onRetry}>{t('development.github.common.retry')}</Button>{hasFilters && <Button size="sm" variant="ghost" onClick={onClearFilters}>{t('development.github.store.clear_filters')}</Button>}</span>}
            />
          </div>
        ) : showEmpty ? (
          <div className="flex h-full items-center justify-center">
            <Empty
              art="search"
              title={t('development.github.store.empty_title')}
              description={t('development.github.store.empty_desc')}
              action={<Button size="sm" onClick={onClearFilters}>{t('development.github.store.clear_filters')}</Button>}
            />
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2">
            {result?.items.map((item) => (
              <li key={item.repo.id}>
                <button
                  type="button"
                  onClick={() => onSelectRepo(item.repo)}
                  className="group flex h-full min-h-[108px] w-full flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 text-left transition-[border-color,background-color] duration-[var(--dur-fast)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-raised)] focus-visible:shadow-[var(--shadow-ring-focus)] focus-visible:outline-none"
                >
                  <span className="flex items-start gap-2">
                    <GithubAvatar src={item.repo.owner.avatarUrl} name={item.repo.owner.login} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[length:var(--text-12)] font-medium leading-tight text-[var(--text-primary)] group-hover:text-[var(--accent)]">{item.repo.fullName}</span>
                      <span className="mt-1 line-clamp-2 min-h-[2.2em] text-[length:var(--text-11)] leading-snug text-[var(--text-tertiary)]">{item.repo.description || t('development.github.store.no_description')}</span>
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ReleaseMeta item={item} />
                  </span>
                  <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                    <span className="inline-flex items-center gap-1 tabular-nums"><Star size={10} />{formatNumber(item.repo.stargazersCount)}</span>
                    {item.repo.language && <span>{item.repo.language}</span>}
                    {item.release && item.release.downloadCount > 0 && <span className="inline-flex items-center gap-1 tabular-nums"><Download size={10} />{formatNumber(item.release.downloadCount)}</span>}
                    {item.release && <span className="ml-auto tabular-nums">{formatDate(item.release.publishedAt)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {result && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <span className="tabular-nums">{t('development.github.store.page', { page })}</span>
          <span className="flex items-center gap-1.5">
            <Button variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={() => onPageChange(page - 1)}>{t('development.github.store.previous')}</Button>
            <Button variant="secondary" size="sm" disabled={!hasNext || loading} onClick={() => onPageChange(page + 1)}>{t('development.github.store.next')}</Button>
          </span>
        </div>
      )}
    </div>
  )
}
