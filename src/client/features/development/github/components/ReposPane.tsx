import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GithubPrefs, GithubRepo, GithubViewId, SavedGithubRepo } from '@shared/development/github/types'
import { GITHUB_ALL_VIEW, GITHUB_EXPLORE_VIEW, GITHUB_PER_PAGE } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { navigateToAddress } from '../../../../lib/app-history'
import { confirm } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { githubApi } from '../api'
import { repoAddress } from '../routes'
import { useGithubSearch } from '../cache'
import { useGithubStore } from '../store'
import { loadRepoPrefs, saveRepoPrefs } from '../prefs'
import { sortSavedRepos, filterRepos } from '../lib/filters'
import { GithubPanes } from '../GithubPanes'
import { ModuleTabs, type GithubTab } from './ModuleTabs'
import { RepoSidebar } from './RepoSidebar'
import { RepoList } from './RepoList'
import { RepoDetail } from './RepoDetail'
import { TagManager } from './TagManager'
import { SidebarFooter } from './SidebarFooter'

function tagId(): string {
  return `gtag-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function ReposPane({
  tab,
  onTabChange,
  onOpenAccounts,
  onOpenMirrors,
  currentMirrorId,
  onCurrentMirrorChange,
  deepLinkRepo,
}: {
  tab: GithubTab
  onTabChange: (tab: GithubTab) => void
  onOpenAccounts: () => void
  onOpenMirrors: () => void
  currentMirrorId: string
  onCurrentMirrorChange: (id: string) => void
  deepLinkRepo: string | null
}) {
  const tags = useGithubStore((state) => state.tags)
  const repos = useGithubStore((state) => state.repos)
  const mirrors = useGithubStore((state) => state.mirrors)
  const upsertRepo = useGithubStore((state) => state.upsertRepo)
  const upsertTag = useGithubStore((state) => state.upsertTag)
  const deleteTag = useGithubStore((state) => state.deleteTag)
  const deleteRepo = useGithubStore((state) => state.deleteRepo)
  const toast = useUi((state) => state.toast)
  const refresh = useGithubStore((state) => state.refresh)
  const [prefs, setPrefs] = useState(loadRepoPrefs)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedView, setSelectedView] = useState<GithubViewId>(GITHUB_EXPLORE_VIEW)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [committedQuery, setCommittedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [extraRepo, setExtraRepo] = useState<GithubRepo | null>(null)
  const lookupRef = useRef<string | null>(null)

  const isExplore = selectedView === GITHUB_EXPLORE_VIEW
  const searchParams = useMemo(() => ({
    q: committedQuery,
    range: prefs.range,
    sort: prefs.sort,
    order: prefs.order,
    language: prefs.language,
    perPage: GITHUB_PER_PAGE,
    page,
  }), [committedQuery, prefs, page])
  const search = useGithubSearch(searchParams, isExplore)

  const selectedRepo = useMemo<GithubRepo | null>(() => {
    if (!selectedRepoId) return null
    const fromSearch = search.data?.items.find((repo) => String(repo.id) === selectedRepoId)
    if (fromSearch) return fromSearch
    const saved = repos.find((repo) => repo.id === selectedRepoId)?.data
    if (saved) return saved
    if (extraRepo && String(extraRepo.id) === selectedRepoId) return extraRepo
    return null
  }, [selectedRepoId, search.data, repos, extraRepo])

  const listItems = useMemo<GithubRepo[]>(() => {
    if (isExplore) return search.data?.items ?? []
    return filterRepos(sortSavedRepos(repos), selectedView, query).map((repo) => repo.data)
  }, [isExplore, search.data, repos, selectedView, query])

  const totalCount = isExplore ? (search.data?.total ?? 0) : listItems.length
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const currentMirror = mirrors.find((mirror) => mirror.id === currentMirrorId) ?? mirrors[0]

  const updatePrefs = useCallback((patch: Partial<GithubPrefs>, nextQuery?: string) => {
    setPrefs((previous) => {
      const next = { ...previous, ...patch }
      saveRepoPrefs(next)
      return next
    })
    setCommittedQuery((nextQuery ?? query).trim())
    setPage(1)
  }, [query])

  const selectView = useCallback((view: GithubViewId) => {
    setSelectedView(view)
    setSelectedRepoId(null)
    setPage(1)
  }, [])

  const toggleExpand = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const saveRepo = useCallback((repo: GithubRepo, patch: Partial<SavedGithubRepo>) => {
    const id = String(repo.id)
    const existing = useGithubStore.getState().repos.find((entry) => entry.id === id)
    const now = Date.now()
    const next: SavedGithubRepo = existing
      ? { ...existing, ...patch, updatedAt: now }
      : { id, fullName: repo.fullName, url: repo.url, data: repo, tagIds: [], pinned: false, favorited: false, createdAt: now, updatedAt: now, ...patch }
    void upsertRepo(next)
  }, [upsertRepo])

  const togglePin = useCallback((repo: GithubRepo) => {
    const existing = useGithubStore.getState().repos.find((entry) => entry.id === String(repo.id))
    saveRepo(repo, { pinned: !existing?.pinned })
  }, [saveRepo])

  const toggleFav = useCallback((repo: GithubRepo) => {
    const existing = useGithubStore.getState().repos.find((entry) => entry.id === String(repo.id))
    saveRepo(repo, { favorited: !existing?.favorited })
  }, [saveRepo])

  const toggleTag = useCallback((repo: GithubRepo, tag: string) => {
    const existing = useGithubStore.getState().repos.find((entry) => entry.id === String(repo.id))
    const tagIds = existing?.tagIds ?? []
    saveRepo(repo, { tagIds: tagIds.includes(tag) ? tagIds.filter((id) => id !== tag) : [...tagIds, tag] })
  }, [saveRepo])

  const removeRepo = useCallback(async (repo: GithubRepo) => {
    const saved = useGithubStore.getState().repos.find((entry) => entry.id === String(repo.id))
    if (!saved) return
    const ok = await confirm({
      title: t('development.github.repos.remove_saved_title'),
      description: t('development.github.repos.remove_saved_desc', { name: repo.fullName }),
      confirmLabel: t('development.github.repos.remove_saved'),
      tone: 'danger',
    })
    if (!ok) return
    void deleteRepo(saved.id)
    setSelectedRepoId((current) => (current === saved.id ? null : current))
    toast({ title: t('development.github.repos.removed'), tone: 'success' })
  }, [deleteRepo, toast])

  const selectRepo = useCallback((repo: GithubRepo) => {
    setSelectedRepoId(String(repo.id))
    navigateToAddress(repoAddress(repo.fullName))
  }, [])

  const selectedFullName = selectedRepo?.fullName ?? null
  useEffect(() => {
    if (!deepLinkRepo) return
    const normalized = deepLinkRepo.toLowerCase()
    if (selectedFullName?.toLowerCase() === normalized) return
    const saved = repos.find((repo) => repo.fullName.toLowerCase() === normalized)
    if (saved) {
      setSelectedView(GITHUB_ALL_VIEW)
      setSelectedRepoId(saved.id)
      return
    }
    if (lookupRef.current === normalized) return
    lookupRef.current = normalized
    void githubApi.repoLookup(deepLinkRepo)
      .then((repo) => {
        setExtraRepo(repo)
        setSelectedRepoId(String(repo.id))
      })
      .catch((error) => {
        toast({ title: t('development.github.repos.deep_link_missing'), description: error instanceof Error ? error.message : undefined, tone: 'danger' })
      })
  }, [deepLinkRepo, repos, selectedFullName, toast])

  const addTag = useCallback((name: string, color: string, parentId: string | null) => {
    const now = Date.now()
    void upsertTag({ id: tagId(), name, color, parentId, sortOrder: tags.filter((tag) => tag.parentId === parentId).length, createdAt: now, updatedAt: now })
  }, [tags, upsertTag])

  const updateTag = useCallback((id: string, patch: { name: string; color: string; parentId: string | null }) => {
    const existing = tags.find((tag) => tag.id === id)
    if (!existing) return
    void upsertTag({ ...existing, ...patch, updatedAt: Date.now() })
  }, [tags, upsertTag])

  const refreshLocal = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh])

  const sidebar = (
    <RepoSidebar tags={tags} savedRepos={repos} selectedView={selectedView} onSelect={selectView} expanded={expanded} onToggleExpand={toggleExpand} onManageTags={() => setTagManagerOpen(true)} />
  )

  return (
    <>
      <GithubPanes
        title={t('development.github.repos.title')}
        sidebarHeader={<ModuleTabs value={tab} onChange={onTabChange} />}
        sidebarFooter={<SidebarFooter onOpenAccounts={onOpenAccounts} onOpenMirrors={onOpenMirrors} currentMirrorName={currentMirror?.name} />}
        detailDisabled={!selectedRepo}
        detailKey={selectedRepoId}
        sidebar={sidebar}
        list={({ toggleSidebar, toggleDetail, detailDisabled }) => (
          <RepoList
            isExplore={isExplore}
            query={query}
            onQueryChange={setQuery}
            onCommitSearch={(value) => { setQuery(value); setCommittedQuery(value.trim()); setPage(1) }}
            onClear={() => { setQuery(''); setCommittedQuery(''); setPage(1) }}
            onGoDiscover={() => selectView(GITHUB_EXPLORE_VIEW)}
            loading={search.loading || refreshing}
            error={search.error instanceof Error ? search.error.message : null}
            prefs={prefs}
            onUpdatePrefs={updatePrefs}
            mirrors={mirrors}
            currentMirrorId={currentMirrorId}
            onCurrentMirrorChange={onCurrentMirrorChange}
            onManageMirrors={onOpenMirrors}
            onRefresh={() => { if (isExplore) void search.refetch(); else void refreshLocal() }}
            items={listItems}
            totalCount={totalCount}
            page={page}
            onPageChange={setPage}
            repoMap={repoMap}
            tags={tags}
            selectedRepoId={selectedRepoId}
            onSelectRepo={selectRepo}
            onTogglePin={togglePin}
            onToggleFav={toggleFav}
            onToggleTag={toggleTag}
            onRemoveRepo={removeRepo}
            toggleSidebar={toggleSidebar}
            toggleDetail={toggleDetail}
            detailDisabled={detailDisabled}
          />
        )}
        detail={<RepoDetail repo={selectedRepo} mirror={currentMirror} />}
      />
      <TagManager
        open={tagManagerOpen}
        onClose={() => setTagManagerOpen(false)}
        tags={tags}
        title={t('development.github.tags.manage_title')}
        description={t('development.github.tags.manage_desc')}
        onAdd={addTag}
        onUpdate={updateTag}
        onDelete={(id) => void deleteTag(id)}
      />
    </>
  )
}
