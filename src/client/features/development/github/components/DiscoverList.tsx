import { AlertCircle, PanelLeft, RefreshCw, ShieldCheck, X } from 'lucide-react'
import type { GithubDiscoverResult, GithubRepo, GithubSortKey, GithubStoreFilters } from '@shared/development/github/types'
import { GITHUB_DISCOVER_TOPICS, GITHUB_TRACKED_OPTIONS, GITHUB_UPDATED_OPTIONS, GITHUB_UPDATE_FILTER_OPTIONS } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Empty, Skeleton } from '../../../../components/feedback'
import { formatNumber } from '../lib/format'
import { platformLabel } from './StoreSidebar'
import { StoreSearchBar } from './StoreSearchBar'
import { DiscoverCard } from './DiscoverCard'

function chartLabel(result: GithubDiscoverResult | null): string {
  if (!result) return t('development.github.store.discover')
  return t(`development.github.store.chart.${result.chart}` as Parameters<typeof t>[0])
}

function topicLabel(topic: string): string {
  const entry = GITHUB_DISCOVER_TOPICS.find((candidate) => candidate.value === topic)
  return entry ? t(entry.labelKey) : topic
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
  query,
  draft,
  onDraftChange,
  onSubmitSearch,
  onClearSearch,
  history,
  onPickHistory,
  sort,
  onSortChange,
  categoryLabel,
  favoritedIds,
  onToggleFavorite,
  mirrorBase,
  hasNext,
  filters,
  onOpenFilters,
  onClearFilter,
  onClearAllFilters,
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
  query: string
  draft: string
  onDraftChange: (value: string) => void
  onSubmitSearch: (value: string) => void
  onClearSearch: () => void
  history: readonly string[]
  onPickHistory: (value: string) => void
  sort: GithubSortKey
  onSortChange: (value: GithubSortKey) => void
  categoryLabel: string | null
  favoritedIds: ReadonlySet<string>
  onToggleFavorite: (repo: GithubRepo) => void
  mirrorBase: string
  hasNext: boolean
  filters: GithubStoreFilters
  onOpenFilters: () => void
  onClearFilter: (key: 'platform' | 'topic' | 'category' | keyof GithubStoreFilters) => void
  onClearAllFilters: () => void
}) {
  const showEmpty = Boolean(result && result.items.length === 0)
  const updatedLabel = t(GITHUB_UPDATED_OPTIONS.find((option) => option.value === filters.updated)?.labelKey ?? 'development.github.store.updated.any')
  const trackedLabel = t(GITHUB_TRACKED_OPTIONS.find((option) => option.value === filters.tracked)?.labelKey ?? 'development.github.store.tracked.any')
  const updateLabel = t(GITHUB_UPDATE_FILTER_OPTIONS.find((option) => option.value === filters.updateStatus)?.labelKey ?? 'development.github.store.update_status.any')
  const chips: { key: 'platform' | 'topic' | 'category' | keyof GithubStoreFilters; label: string }[] = []
  if (result?.platform && result.platform !== 'all') chips.push({ key: 'platform', label: platformLabel(result.platform) })
  if (result?.topic) chips.push({ key: 'topic', label: topicLabel(result.topic) })
  if (result?.category && result.category !== 'all') chips.push({ key: 'category', label: categoryLabel ?? '' })
  if (filters.language) chips.push({ key: 'language', label: t('development.github.store.filters.language_chip', { language: filters.language }) })
  if (filters.updated !== 'any') chips.push({ key: 'updated', label: updatedLabel })
  if (filters.tracked !== 'any') chips.push({ key: 'tracked', label: trackedLabel })
  if (filters.installerOnly) chips.push({ key: 'installerOnly', label: t('development.github.store.filters.installer') })
  if (filters.updateStatus !== 'any') chips.push({ key: 'updateStatus', label: updateLabel })
  const activeFilterCount = chips.length
  const hasFilters = activeFilterCount > 0

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="github-discover">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('development.github.common.toggle_sidebar')} size="sm" className="size-8 shrink-0 md:size-8" onClick={onOpenSidebar}><PanelLeft size={15} /></IconButton>
        <span className="min-w-0 max-w-full truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
          {query ? t('development.github.store.search_results', { query }) : chartLabel(result)}
        </span>
        {result && <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{t('development.github.store.results', { count: formatNumber(result.total) })}</span>}
        {loading && result && <Spinner size={12} className="text-[var(--text-quaternary)]" />}
        {result && (
          <span className="ml-auto flex items-center gap-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
            <ShieldCheck size={11} />
            <span className="hidden sm:inline">{result.verified ? t('development.github.store.verified_hint') : t('development.github.store.unverified_hint')}</span>
          </span>
        )}
        <IconButton label={t('development.github.store.refresh')} size="sm" className="size-8 shrink-0 md:size-8" onClick={onRefresh}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></IconButton>
      </div>

      <div className="shrink-0 border-b border-[var(--border-subtle)] px-3 py-2">
        <StoreSearchBar
          draft={draft}
          onDraftChange={onDraftChange}
          onSubmit={onSubmitSearch}
          onClear={onClearSearch}
          history={history}
          onPickHistory={onPickHistory}
          sort={sort}
          onSortChange={onSortChange}
          onOpenFilters={onOpenFilters}
          activeFilterCount={activeFilterCount}
        />
        {chips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {chips.map((chip) => (
              <span key={chip.key} className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-raised)] px-2 py-0.5 text-[length:var(--text-10)] text-[var(--text-secondary)]">
                {chip.label}
                <button type="button" aria-label={t('development.github.store.filters.remove', { name: chip.label })} onClick={() => onClearFilter(chip.key)} className="rounded-full p-0.5 text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><X size={9} /></button>
              </span>
            ))}
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[length:var(--text-10)]" onClick={onClearAllFilters}>{t('development.github.store.clear_filters')}</Button>
          </div>
        )}
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
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-2" aria-label={t('development.github.common.loading')}>
            {Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-[124px] rounded-[var(--r-md)]" />)}
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
              title={query ? t('development.github.store.search_empty_title') : t('development.github.store.empty_title')}
              description={query ? t('development.github.store.search_empty_desc') : t('development.github.store.empty_desc')}
              action={<Button size="sm" onClick={query ? onClearSearch : onClearFilters}>{query ? t('development.github.store.clear_search') : t('development.github.store.clear_filters')}</Button>}
            />
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-2">
            {result?.items.map((item) => (
              <li key={item.repo.id} className="relative">
                <DiscoverCard
                  item={item}
                  favorited={favoritedIds.has(String(item.repo.id))}
                  onToggleFavorite={() => onToggleFavorite(item.repo)}
                  onSelectRepo={() => onSelectRepo(item.repo)}
                  mirrorBase={mirrorBase}
                />
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
