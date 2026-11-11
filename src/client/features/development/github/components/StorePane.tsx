import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Download, ExternalLink, PackagePlus } from 'lucide-react'
import type {
  GithubAssetPlatform,
  GithubDiscoverCategory,
  GithubDiscoverChart,
  GithubDiscoverItem,
  GithubPlatformFilter,
  GithubRepo,
  GithubSortKey,
  GithubStoreFilters,
  GithubTrackedApp,
  SavedGithubRepo,
} from '@shared/development/github/types'
import { DEFAULT_STORE_FILTERS, GITHUB_DISCOVER_CATEGORIES, GITHUB_DISCOVER_PER_PAGE } from '@shared/development/github/types'
import { trackedAppStatus, buildTrackedApp } from '../lib/apps'
import { t } from '../../../../lib/i18n'
import { copyText } from '../../../../lib/clipboard'
import { navigateToPath } from '../../../../lib/app-history'
import { useUi } from '../../../../store/ui'
import { Menu, useContextMenu, type MenuItem } from '../../../../components/overlay'
import { useGithubDiscover, useStoreSearch } from '../cache'
import { useGithubStore } from '../store'
import { storeAddress, type GithubStoreView } from '../routes'
import { loadSearchHistory, loadSectionView, loadStorePrefs, saveSearchHistory, saveSectionView, saveStorePrefs, type GithubSectionView } from '../prefs'
import { savedRepoFrom } from '../lib/saved-repos'
import { buildMirrorDownloadUrl } from '../lib/format'
import { GithubPanes, type SidebarPaneControls } from '../GithubPanes'
import { ModuleTabs, type GithubTab } from './ModuleTabs'
import { SidebarFooter } from './SidebarFooter'
import { StoreSidebar } from './StoreSidebar'
import { DiscoverList } from './DiscoverList'
import { AppsView } from './AppsView'
import { FavoritesView } from './FavoritesView'
import { StoreFiltersDialog } from './StoreFiltersDialog'
import { TrackAppDialog, type TrackAppValues } from './TrackAppDialog'
import { RepoDetail } from './RepoDetail'

const ORIGIN = { x: 0, y: 0 }

export function StorePane({
  tab,
  onTabChange,
  onOpenAccounts,
  onOpenMirrors,
  currentMirrorId,
  initialView,
  active,
}: {
  tab: GithubTab
  onTabChange: (tab: GithubTab) => void
  onOpenAccounts: () => void
  onOpenMirrors: () => void
  currentMirrorId: string
  initialView: GithubStoreView
  active: boolean
}) {
  const apps = useGithubStore((state) => state.apps)
  const repos = useGithubStore((state) => state.repos)
  const mirrors = useGithubStore((state) => state.mirrors)
  const accounts = useGithubStore((state) => state.accounts)
  const upsertRepo = useGithubStore((state) => state.upsertRepo)
  const upsertApp = useGithubStore((state) => state.upsertApp)
  const deleteApp = useGithubStore((state) => state.deleteApp)
  const checkApps = useGithubStore((state) => state.checkApps)
  const toast = useUi((state) => state.toast)
  const [view, setView] = useState<GithubStoreView>(initialView)
  const [chart, setChart] = useState<GithubDiscoverChart>('trending')
  const [platform, setPlatform] = useState<GithubPlatformFilter>(() => loadStorePrefs().platform)
  const [category, setCategory] = useState<GithubDiscoverCategory>(() => loadStorePrefs().category)
  const [sort, setSort] = useState<GithubSortKey>(() => loadStorePrefs().sort)
  const [filters, setFilters] = useState<GithubStoreFilters>(() => {
    const prefs = loadStorePrefs()
    return {
      language: prefs.language,
      updated: prefs.updated,
      tracked: prefs.tracked,
      installerOnly: prefs.installerOnly,
      updateStatus: prefs.updateStatus,
    }
  })
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [topic, setTopic] = useState('')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState<string[]>(loadSearchHistory)
  const [page, setPage] = useState(1)
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null)
  const [checking, setChecking] = useState(false)
  const [appsView, setAppsView] = useState<GithubSectionView>(() => loadSectionView('apps'))
  const [favoritesView, setFavoritesView] = useState<GithubSectionView>(() => loadSectionView('favorites'))
  const cardMenu = useContextMenu()
  const [cardTarget, setCardTarget] = useState<GithubDiscoverItem | null>(null)
  const [trackTarget, setTrackTarget] = useState<{ repo: GithubRepo; platform: GithubAssetPlatform; tag: string } | null>(null)

  const discoverQuery = useMemo(() => ({
    chart,
    platform,
    topic,
    category,
    query: '',
    sort,
    order: 'desc' as const,
    page,
    perPage: GITHUB_DISCOVER_PER_PAGE,
    ...filters,
  }), [category, chart, filters, page, platform, sort, topic])
  const discover = useGithubDiscover(discoverQuery, active && view === 'discover' && query === '')

  const searchParams = useMemo(() => ({
    q: query,
    platform,
    topic,
    category,
    sort,
    order: 'desc' as const,
    page,
    perPage: GITHUB_DISCOVER_PER_PAGE,
    ...filters,
  }), [category, filters, page, platform, query, sort, topic])
  const search = useStoreSearch(searchParams, active && view === 'discover' && query.length >= 2)

  const result = query ? search.data : discover.data
  const loading = query ? search.loading : discover.loading
  const error = query ? search.error : discover.error
  const refetch = query ? search.refetch : discover.refetch

  const updateCount = useMemo(
    () => apps.filter((app) => {
      const status = trackedAppStatus(app)
      return app.latestTag && status.state === 'update-available' && !status.suppressed
    }).length,
    [apps],
  )
  const favorites = useMemo(() => repos.filter((repo) => repo.favorited), [repos])
  const favoritedIds = useMemo(() => new Set(favorites.map((repo) => repo.id)), [favorites])
  const categoryLabel = useMemo(() => {
    if (category === 'all') return null
    const entry = GITHUB_DISCOVER_CATEGORIES.find((candidate) => candidate.value === category)
    return entry ? t(entry.labelKey) : null
  }, [category])

  const persistPrefs = useCallback((patch: { platform?: GithubPlatformFilter; category?: GithubDiscoverCategory; sort?: GithubSortKey } & Partial<GithubStoreFilters>) => {
    saveStorePrefs({
      platform: patch.platform ?? platform,
      category: patch.category ?? category,
      sort: patch.sort ?? sort,
      ...filters,
      ...patch,
    })
  }, [category, filters, platform, sort])

  const changeView = useCallback((next: GithubStoreView) => {
    setView(next)
    setSelectedRepo(null)
    navigateToPath(storeAddress(next))
  }, [])

  useEffect(() => {
    setView(initialView)
  }, [initialView])

  const changeChart = useCallback((next: GithubDiscoverChart) => {
    setChart(next)
    setQuery('')
    setDraft('')
    setPage(1)
  }, [])

  const changePlatform = useCallback((next: GithubPlatformFilter) => {
    setPlatform(next)
    persistPrefs({ platform: next })
    setPage(1)
  }, [persistPrefs])

  const changeCategory = useCallback((next: GithubDiscoverCategory) => {
    setCategory(next)
    persistPrefs({ category: next })
    setPage(1)
  }, [persistPrefs])

  const changeSort = useCallback((next: GithubSortKey) => {
    setSort(next)
    persistPrefs({ sort: next })
    setPage(1)
  }, [persistPrefs])

  const changeTopic = useCallback((next: string) => {
    setTopic(next)
    setPage(1)
  }, [])

  const changeFilters = useCallback((patch: Partial<GithubStoreFilters>) => {
    const next = { ...filters, ...patch }
    setFilters(next)
    persistPrefs(next)
    setPage(1)
  }, [filters, persistPrefs])

  const clearFilter = useCallback((key: 'platform' | 'topic' | 'category' | keyof GithubStoreFilters) => {
    if (key === 'platform') { setPlatform('all'); persistPrefs({ platform: 'all' }); setPage(1); return }
    if (key === 'topic') { setTopic(''); setPage(1); return }
    if (key === 'category') { setCategory('all'); persistPrefs({ category: 'all' }); setPage(1); return }
    changeFilters({ [key]: DEFAULT_STORE_FILTERS[key] })
  }, [changeFilters, persistPrefs])

  const clearFilters = useCallback(() => {
    setChart('trending')
    setPlatform('all')
    setCategory('all')
    setTopic('')
    setQuery('')
    setDraft('')
    setFilters({ ...DEFAULT_STORE_FILTERS })
    setPage(1)
    saveStorePrefs({ platform: 'all', category: 'all', sort, ...DEFAULT_STORE_FILTERS })
  }, [sort])

  const commitSearch = useCallback((value: string) => {
    const next = value.trim()
    if (next.length < 2) {
      toast({ title: t('development.github.store.search_too_short'), tone: 'warning' })
      return
    }
    setQuery(next)
    setDraft(next)
    setPage(1)
    const merged = [next, ...history.filter((entry) => entry.toLowerCase() !== next.toLowerCase())].slice(0, 8)
    setHistory(merged)
    saveSearchHistory(merged)
  }, [history, toast])

  const clearSearch = useCallback(() => {
    setQuery('')
    setDraft('')
    setPage(1)
  }, [])

  const pickHistory = useCallback((value: string) => commitSearch(value), [commitSearch])

  const toggleFavorite = useCallback((repo: GithubRepo) => {
    const existing = useGithubStore.getState().repos.find((entry) => entry.id === String(repo.id))
    const next: SavedGithubRepo = savedRepoFrom(repo, existing, { favorited: !existing?.favorited })
    void upsertRepo(next)
    toast({ title: next.favorited ? t('development.github.store.favorited') : t('development.github.store.unfavorited'), tone: 'success' })
  }, [toast, upsertRepo])

  const runCheck = useCallback(async (ids: string[]) => {
    const enabled = ids.filter((id) => apps.find((app) => app.id === id)?.updateCheckEnabled !== false)
    if (enabled.length === 0) return
    if (accounts.length === 0) {
      toast({ title: t('development.github.apps.account_required'), tone: 'warning' })
      return
    }
    setChecking(true)
    try {
      const result = await checkApps(enabled)
      toast({
        title: t('development.github.apps.checked', { checked: result.checked, failed: result.failed.length }),
        ...(result.failed[0] ? { description: result.failed[0].message } : {}),
        tone: result.failed.length > 0 ? 'warning' : 'success',
      })
    } catch (error) {
      toast({
        title: t('development.github.apps.check_failed'),
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      })
    } finally {
      setChecking(false)
    }
  }, [accounts.length, apps, checkApps, toast])

  const removeApp = useCallback((id: string) => {
    void deleteApp(id)
    toast({ title: t('development.github.apps.removed'), tone: 'success' })
  }, [deleteApp, toast])

  const patchApp = useCallback((app: GithubTrackedApp, patch: Partial<GithubTrackedApp>) => {
    void useGithubStore.getState().upsertApp({ ...app, ...patch })
  }, [])

  const currentMirror = mirrors.find((mirror) => mirror.id === currentMirrorId) ?? mirrors[0]

  const changeAppsView = useCallback((next: GithubSectionView) => {
    setAppsView(next)
    saveSectionView('apps', next)
  }, [])

  const changeFavoritesView = useCallback((next: GithubSectionView) => {
    setFavoritesView(next)
    saveSectionView('favorites', next)
  }, [])

  const copyValue = useCallback(async (value: string) => {
    const ok = await copyText(value)
    toast({ title: ok ? t('development.github.sidebar.copied') : t('development.github.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }, [toast])

  const openCardMenu = useCallback((item: GithubDiscoverItem, event: React.MouseEvent) => {
    setCardTarget(item)
    ;(event.currentTarget as HTMLElement).querySelector<HTMLElement>('button[aria-label]')?.focus({ preventScroll: true })
    cardMenu.onContextMenu(event)
  }, [cardMenu])

  const openCardMenuAt = useCallback((item: GithubDiscoverItem, event: React.KeyboardEvent) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    setCardTarget(item)
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    cardMenu.openAt({ x: rect.left + 12, y: rect.top + 12 })
  }, [cardMenu])

  const beginTrack = useCallback((repo: GithubRepo, platform: GithubAssetPlatform = 'windows', tag = '') => {
    setTrackTarget({ repo, platform, tag })
  }, [])

  const submitTrack = useCallback(async (values: TrackAppValues) => {
    if (!trackTarget) return
    const app = buildTrackedApp(trackTarget.repo, values.platform, values.assetPattern, values.installedTag)
    try {
      await upsertApp(app)
    } catch (error) {
      toast({
        title: t('development.github.apps.save_failed'),
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      })
      return
    }
    setTrackTarget(null)
    toast({ title: t('development.github.apps.saved', { name: trackTarget.repo.fullName }), tone: 'success' })
    if (accounts.length === 0) return
    try {
      const result = await checkApps([app.id])
      if (result.failed.length > 0) toast({ title: t('development.github.apps.check_failed'), description: result.failed[0]?.message, tone: 'warning' })
    } catch (error) {
      toast({ title: t('development.github.apps.check_failed'), description: error instanceof Error ? error.message : undefined, tone: 'warning' })
    }
  }, [accounts.length, checkApps, toast, trackTarget, upsertApp])

  const cardDownloadUrl = cardTarget?.release?.recommendedAsset
    ? buildMirrorDownloadUrl(currentMirror?.url ?? '', cardTarget.release.recommendedAsset.downloadUrl)
    : ''
  const cardTracked = Boolean(cardTarget && apps.some((app) => app.id === String(cardTarget.repo.id)))
  const cardMenuItems: MenuItem[] = cardTarget ? [
    { id: 'open', label: t('development.github.store.menu.open_detail'), onSelect: () => setSelectedRepo(cardTarget.repo) },
    { id: 'github', label: t('development.github.store.menu.open_github'), icon: <ExternalLink size={13} />, onSelect: () => window.open(cardTarget.repo.url, '_blank', 'noopener,noreferrer') },
    {
      id: 'download',
      label: t('development.github.store.menu.download'),
      icon: <Download size={13} />,
      disabled: !cardDownloadUrl,
      reason: cardDownloadUrl ? undefined : t('development.github.store.no_asset_hint'),
      onSelect: () => { if (cardDownloadUrl) window.open(cardDownloadUrl, '_blank', 'noopener,noreferrer') },
    },
    { id: 'copy-name', label: t('development.github.store.menu.copy_name'), icon: <Copy size={13} />, separatorBefore: true, onSelect: () => void copyValue(cardTarget.repo.fullName) },
    { id: 'copy-link', label: t('development.github.store.menu.copy_link'), icon: <Copy size={13} />, onSelect: () => void copyValue(cardTarget.repo.url) },
    {
      id: 'favorite',
      label: favoritedIds.has(String(cardTarget.repo.id)) ? t('development.github.store.unfavorite') : t('development.github.store.favorite'),
      checked: favoritedIds.has(String(cardTarget.repo.id)),
      onSelect: () => toggleFavorite(cardTarget.repo),
    },
    {
      id: 'track',
      label: cardTracked ? t('development.github.store.menu.tracked') : t('development.github.store.menu.track'),
      icon: <PackagePlus size={13} />,
      disabled: cardTracked,
      onSelect: () => {
        const platform = cardTarget.release?.platforms[0]
        beginTrack(cardTarget.repo, platform, cardTarget.release?.tagName ?? '')
      },
    },
  ] : []

  const saved = selectedRepo ? repos.find((entry) => entry.id === String(selectedRepo.id)) : undefined

  const sidebar = ({ closeSidebar }: SidebarPaneControls) => (
    <StoreSidebar
      view={view}
      onViewChange={changeView}
      chart={chart}
      onChartChange={changeChart}
      platform={platform}
      onPlatformChange={changePlatform}
      topic={topic}
      onTopicChange={changeTopic}
      category={category}
      onCategoryChange={changeCategory}
      updateCount={updateCount}
      favoriteCount={favorites.length}
      filteredCount={query ? search.data?.total : discover.data?.total}
      onNavigate={closeSidebar}
    />
  )

  return (
    <>
    <GithubPanes
      title={view === 'apps' ? t('development.github.apps.title') : view === 'favorites' ? t('development.github.store.favorites') : t('development.github.store.title')}
      sidebarHeader={<ModuleTabs value={tab} onChange={onTabChange} />}
      sidebarFooter={<SidebarFooter onOpenAccounts={onOpenAccounts} onOpenMirrors={onOpenMirrors} currentMirrorName={currentMirror?.name} />}
      detailDisabled={!selectedRepo}
      detailKey={selectedRepo ? String(selectedRepo.id) : null}
      autoHideDetail
      sidebar={sidebar}
      list={({ toggleSidebar }) => (view === 'apps'
        ? <AppsView apps={apps} checking={checking} mirror={currentMirror} view={appsView} onViewChange={changeAppsView} onCheck={(ids) => void runCheck(ids)} onRemove={removeApp} onPatch={patchApp} onOpenSidebar={toggleSidebar} onDiscover={() => changeView('discover')} />
        : view === 'favorites'
          ? <FavoritesView favorites={favorites} view={favoritesView} onViewChange={changeFavoritesView} onOpenRepo={setSelectedRepo} onToggleFavorite={toggleFavorite} onTrack={(repo) => beginTrack(repo)} onOpenSidebar={toggleSidebar} onDiscover={() => changeView('discover')} />
          : (
            <DiscoverList
              result={result}
              loading={loading}
              error={error}
              onRetry={() => void refetch()}
              onRefresh={() => void refetch()}
              page={page}
              onPageChange={setPage}
              onSelectRepo={setSelectedRepo}
              onClearFilters={clearFilters}
              onOpenSidebar={toggleSidebar}
              query={query}
              draft={draft}
              onDraftChange={setDraft}
              onSubmitSearch={commitSearch}
              onClearSearch={clearSearch}
              history={history}
              onPickHistory={pickHistory}
              sort={sort}
              onSortChange={changeSort}
              categoryLabel={categoryLabel}
              favoritedIds={favoritedIds}
              onToggleFavorite={toggleFavorite}
              mirrorBase={currentMirror?.url ?? ''}
              hasNext={result?.hasNext ?? false}
              filters={filters}
              onOpenFilters={() => setFiltersOpen(true)}
              onClearFilter={clearFilter}
              onClearAllFilters={clearFilters}
              onCardContextMenu={openCardMenu}
              onCardContextKeyDown={openCardMenuAt}
            />
          ))}
      detail={<RepoDetail repo={selectedRepo} mirror={currentMirror} notes={saved?.notes ?? ''} favorited={Boolean(saved?.favorited)} onToggleFavorite={toggleFavorite} />}
    />
    <StoreFiltersDialog open={filtersOpen} onClose={() => setFiltersOpen(false)} filters={filters} onChange={changeFilters} />
    <Menu anchor={cardMenu.point ?? ORIGIN} open={cardMenu.point !== null && cardTarget !== null} onClose={() => { cardMenu.close(); setCardTarget(null) }} items={cardMenuItems} align="start" width={220} label={t('development.github.common.menu')} />
    <TrackAppDialog open={trackTarget !== null} repo={trackTarget?.repo ?? null} release={null} initialPlatform={trackTarget?.platform} initialTag={trackTarget?.tag} onClose={() => setTrackTarget(null)} onSubmit={(values) => void submitTrack(values)} />
    </>
  )
}
