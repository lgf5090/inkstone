import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Clock3, RefreshCw, XCircle } from 'lucide-react'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Badge, Button } from '../../../components/primitives'
import { useUi } from '../../../store/ui'
import { cfErrorText } from '../api/client'
import { storeApi, type CatalogSource, type TemplateItem } from '../api/store'
import { favoriteIds, useFavoriteCount } from '../lib/favorites'
import { useCfT } from '../i18n'
import { StoreCard } from './store/StoreCard'
import { StoreCategoryNav } from './store/StoreCategoryNav'
import { StoreToolbar } from './store/StoreToolbar'
import { TemplateDetailDrawer } from './store/TemplateDetailDrawer'
import { StoreDeployDialog } from './store/StoreDeployDialog'
import {
  categoryCounts,
  collectTags,
  filterTemplates,
  sortTemplates,
  templateKey,
  type StoreCategory,
  type StoreSort,
} from './store/helpers'

function StoreError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useCfT()
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-[var(--r-md)] border border-[var(--danger)]/45 bg-[var(--bg-raised)] px-3 py-2"
    >
      <span className="min-w-0 break-words text-[length:var(--text-12-5)] text-[var(--danger)]">
        {message}
      </span>
      <Button size="sm" variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>
    </div>
  )
}

export function StoreScreen() {
  const t = useCfT()
  const toast = useUi((state) => state.toast)
  const favoriteCount = useFavoriteCount()

  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [sources, setSources] = useState<CatalogSource[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  const [search, setSearch] = useState('')
  const [type, setType] = useState<StoreCategory | null>(null)
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [sort, setSort] = useState<StoreSort>('newest')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [detail, setDetail] = useState<TemplateItem | null>(null)
  const [deploy, setDeploy] = useState<TemplateItem | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void (async () => {
      try {
        await storeApi.init()
        const page = await storeApi.templates()
        if (cancelled) return
        setTemplates(page.templates)
        setSources(page.sources)
      } catch (failure) {
        if (!cancelled) setError(cfErrorText(failure))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [reload])

  async function refreshCatalog(): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    setError('')
    try {
      const page = await storeApi.refresh()
      setTemplates(page.templates)
      setSources(page.sources)
    } catch (failure) {
      const message = cfErrorText(failure)
      setError(message)
      toast({ title: message, tone: 'danger' })
    } finally {
      setRefreshing(false)
    }
  }

  const counts = useMemo(() => categoryCounts(templates), [templates])
  const tags = useMemo(() => collectTags(templates), [templates])
  const hasFilters = search.trim().length > 0
    || type !== null
    || selectedTags.length > 0
    || favoritesOnly

  const visible = useMemo(() => {
    void favoriteCount
    const filtered = filterTemplates(templates, {
      search,
      type,
      tags: selectedTags,
      favoriteIds: favoriteIds(),
      favoritesOnly,
    })
    return sortTemplates(filtered, sort, favoriteIds())
  }, [templates, search, type, selectedTags, favoritesOnly, sort, favoriteCount])

  function toggleTag(tag: string): void {
    setSelectedTags((previous) => (
      previous.includes(tag)
        ? previous.filter((item) => item !== tag)
        : [...previous, tag]
    ))
  }

  function clearFilters(): void {
    setSearch('')
    setType(null)
    setSelectedTags([])
    setFavoritesOnly(false)
  }

  const failedSources = sources.filter((source) => (
    source.last_status === 'error' && source.last_error
  ))

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-3 md:p-5">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
            {t('cloudflare.store.title')}
          </h1>
          <Button
            size="sm"
            variant="secondary"
            loading={refreshing}
            disabled={loading}
            icon={<RefreshCw size={14} />}
            onClick={() => void refreshCatalog()}
          >
            {t('cloudflare.store.refresh_catalog')}
          </Button>
        </header>

        {sources.length > 0 ? (
          <section aria-label={t('cloudflare.store.source')} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {sources.map((source) => {
                const failed = source.last_status === 'error'
                const ok = source.last_status === 'success' || source.last_status === 'ok'
                const Icon = failed ? XCircle : ok ? CheckCircle2 : Clock3
                return (
                  <span key={source.id} className="inline-flex items-center gap-1.5">
                    <Badge tone={failed ? 'danger' : ok ? 'success' : 'neutral'} className="gap-1.5">
                      <Icon size={12} aria-hidden="true" />
                      <span>{source.name}</span>
                      <span className="font-normal opacity-80">
                        {failed
                          ? t('cloudflare.store.failed')
                          : ok
                            ? t('cloudflare.store.updated')
                            : t('cloudflare.store.loading')}
                      </span>
                    </Badge>
                    <Badge>
                      {t('cloudflare.store_category_nav.all', { count: source.template_count ?? 0 })}
                    </Badge>
                  </span>
                )
              })}
            </div>
            {failedSources.map((source) => (
              <p key={source.id} role="alert" className="break-words text-[length:var(--text-11-5)] text-[var(--danger)]">
                <span className="font-medium">{source.name}</span>: {source.last_error}
              </p>
            ))}
          </section>
        ) : null}

        <StoreCategoryNav
          counts={counts}
          tags={tags}
          selectedType={type}
          selectedTags={selectedTags}
          onTypeChange={setType}
          onToggleTag={toggleTag}
        />

        <StoreToolbar
          search={search}
          sort={sort}
          favoritesOnly={favoritesOnly}
          hasFilters={hasFilters}
          onSearchChange={setSearch}
          onSortChange={setSort}
          onFavoritesOnlyChange={setFavoritesOnly}
          onClear={clearFilters}
        />

        {error && templates.length > 0 ? (
          <StoreError message={error} onRetry={() => setReload((value) => value + 1)} />
        ) : null}

        {loading && templates.length === 0 ? (
          <LoadingBlock label={t('cloudflare.store.loading')} />
        ) : null}

        {!loading && error && templates.length === 0 ? (
          <StoreError message={error} onRetry={() => setReload((value) => value + 1)} />
        ) : null}

        {!loading && !error && templates.length === 0 ? (
          <Empty
            art="select"
            title={t('cloudflare.store.no_templates')}
            action={hasFilters ? (
              <Button size="sm" variant="secondary" onClick={clearFilters}>
                {t('cloudflare.store_toolbar.clear_filter')}
              </Button>
            ) : undefined}
          />
        ) : null}

        {visible.length > 0 ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((item) => (
              <StoreCard
                key={templateKey(item)}
                item={item}
                onDetail={setDetail}
                onDeploy={setDeploy}
              />
            ))}
          </div>
        ) : null}

        {!loading && templates.length > 0 && visible.length === 0 ? (
          <Empty
            art="search"
            title={t('cloudflare.store.no_templates')}
            action={hasFilters ? (
              <Button size="sm" variant="secondary" onClick={clearFilters}>
                {t('cloudflare.store_toolbar.clear_filter')}
              </Button>
            ) : undefined}
          />
        ) : null}
      </div>

      {detail ? (
        <TemplateDetailDrawer
          item={detail}
          onClose={() => setDetail(null)}
          onDeploy={(item) => {
            setDetail(null)
            setDeploy(item)
          }}
        />
      ) : null}

      <StoreDeployDialog
        open={deploy !== null}
        item={deploy}
        onClose={() => setDeploy(null)}
      />
    </div>
  )
}
