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
import { loadRepoPrefs, loadSearchHistory, saveRepoPrefs, saveSearchHistory } from '../prefs'
import { sortSavedRepos, filterRepos } from '../lib/filters'
import { GithubPanes } from '../GithubPanes'
import { ModuleTabs, type GithubTab } from './ModuleTabs'
import { RepoSidebar } from './RepoSidebar'
import { RepoList } from './RepoList'
import { RepoDetail } from './RepoDetail'
import { TagManager } from './TagManager'
import { SidebarFooter } from './SidebarFooter'
import { RepoImportDialog } from './RepoImportDialog'

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
  const batchDeleteRepos = useGithubStore((state) => state.batchDeleteRepos)
  const batchUpdateRepos = useGithubStore((state) => state.batchUpdateRepos)
  const toast = useUi((state) => state.toast)
  const refresh = useGithubStore((state) => state.refresh)
  const [prefs, setPrefs] = useState(loadRepoPrefs)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedView, setSelectedView] = useState<GithubViewId>(GITHUB_EXPLORE_VIEW)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [committedQuery, setCommittedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [syncingStars, setSyncingStars] = useState(false)
  const [searchHistory, setSearchHistory] = useState(loadSearchHistory)
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

  const rememberSearch = useCallback((value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    setSearchHistory((previous) => {
      const next = [trimmed, ...previous.filter((entry) => entry !== trimmed)].slice(0, 8)
      saveSearchHistory(next)
      return next
    })
  }, [])

  const updatePrefs = useCallback((patch: Partial<GithubPrefs>, nextQuery?: string) => {
    setPrefs((previous) => {
      const next = { ...previous, ...patch }
      saveRepoPrefs(next)
      return next
    })
    const queryValue = (nextQuery ?? query).trim()
    setCommittedQuery(queryValue)
    setPage(1)
    rememberSearch(queryValue)
  }, [query, rememberSearch])

  const selectView = useCallback((view: GithubViewId) => {
    setSelectedView(view)
    setSelectedRepoId(null)
    setSelectedIds(new Set())
    setPage(1)
  }, [])

  useEffect(() => {
    setSelectedIds((previous) => {
      if (previous.size === 0) return previous
      const present = new Set(repos.map((repo) => repo.id))
      let changed = false
      const next = new Set<string>()
      for (const id of previous) {
        if (present.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : previous
    })
  }, [repos])

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
      : { id, fullName: repo.fullName, url: repo.url, data: repo, tagIds: [], pinned: false, favorited: false, notes: '', createdAt: now, updatedAt: now, ...patch }
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
    setSelectedIds((previous) => {
      if (!previous.has(saved.id)) return previous
      const next = new Set(previous)
      next.delete(saved.id)
      return next
    })
    toast({ title: t('development.github.repos.removed'), tone: 'success' })
  }, [deleteRepo, toast])

  const checkRepo = useCallback((id: string, checked: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const selectAllRepos = useCallback(() => {
    setSelectedIds((previous) => {
      const all = listItems.length > 0 && listItems.every((repo) => previous.has(String(repo.id)))
      const next = new Set(previous)
      for (const repo of listItems) {
        const id = String(repo.id)
        if (all) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }, [listItems])

  const batchPin = useCallback((pinned: boolean) => {
    if (selectedIds.size > 0) void batchUpdateRepos(Array.from(selectedIds), { pinned })
  }, [batchUpdateRepos, selectedIds])

  const batchFav = useCallback((favorited: boolean) => {
    if (selectedIds.size > 0) void batchUpdateRepos(Array.from(selectedIds), { favorited })
  }, [batchUpdateRepos, selectedIds])

  const batchTag = useCallback((tagId: string, action: 'add' | 'remove') => {
    if (selectedIds.size > 0) {
      void batchUpdateRepos(Array.from(selectedIds), action === 'add' ? { addTagIds: [tagId] } : { removeTagIds: [tagId] })
    }
  }, [batchUpdateRepos, selectedIds])

  const batchRemove = useCallback(async () => {
    if (selectedIds.size === 0) return
    const ok = await confirm({
      title: t('development.github.repos.remove_batch_title', { count: selectedIds.size }),
      description: t('development.github.repos.remove_batch_desc', { count: selectedIds.size }),
      confirmLabel: t('development.github.repos.remove_saved'),
      tone: 'danger',
    })
    if (!ok) return
    const removed = new Set(selectedIds)
    void batchDeleteRepos(Array.from(removed))
    setSelectedIds(new Set())
    setSelectedRepoId((current) => (current && removed.has(current) ? null : current))
  }, [batchDeleteRepos, selectedIds])

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

  const syncStars = useCallback(async () => {    if (syncingStars) return
    setSyncingStars(true)
    try {
      const result = await githubApi.starred(1, 100)
      const existing = new Set(useGithubStore.getState().repos.map((repo) => repo.id))
      let added = 0
      for (const repo of result.items) {
        if (existing.has(String(repo.id))) continue
        saveRepo(repo, {})
        added += 1
      }
      toast({ title: t('development.github.repos.stars_synced', { added, total: result.items.length }), tone: 'success' })
    } catch (error) {
      toast({ title: t('development.github.repos.stars_sync_failed'), description: error instanceof Error ? error.message : undefined, tone: 'danger' })
    } finally {
      setSyncingStars(false)
    }
  }, [saveRepo, syncingStars, toast])

  const exportLibrary = useCallback(() => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      tags,
      repos,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `github-repos-${new Date().toISOString().slice(0, 10)}.json`
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast({ title: t('development.github.repos.export_done'), tone: 'success' })
  }, [tags, repos, toast])

  const sidebar = (
    <RepoSidebar tags={tags} savedRepos={repos} selectedView={selectedView} onSelect={selectView} expanded={expanded} onToggleExpand={toggleExpand} onManageTags={() => setTagManagerOpen(true)} onImportRepo={() => setImportOpen(true)} />
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
            onCommitSearch={(value) => { setQuery(value); setCommittedQuery(value.trim()); setPage(1); rememberSearch(value) }}
            onClear={() => { setQuery(''); setCommittedQuery(''); setPage(1) }}
            searchHistory={searchHistory}
            onPickSearchHistory={(value) => { setQuery(value); setCommittedQuery(value); setPage(1) }}
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
            selectedIds={selectedIds}
            onCheckRepo={checkRepo}
            onSelectAllRepos={selectAllRepos}
            onBatchPin={batchPin}
            onBatchFav={batchFav}
            onBatchTag={batchTag}
            onBatchRemove={batchRemove}
            onSelectRepo={selectRepo}
            onTogglePin={togglePin}
            onToggleFav={toggleFav}
            onToggleTag={toggleTag}
            onRemoveRepo={removeRepo}
            onSyncStars={() => void syncStars()}
            syncingStars={syncingStars}
            onExportLibrary={exportLibrary}
            toggleSidebar={toggleSidebar}
            toggleDetail={toggleDetail}
            detailDisabled={detailDisabled}
          />
        )}
        detail={<RepoDetail repo={selectedRepo} mirror={currentMirror} notes={selectedRepo ? repos.find((entry) => entry.id === String(selectedRepo.id))?.notes ?? '' : ''} onUpdateNotes={selectedRepo && repos.some((entry) => entry.id === String(selectedRepo.id)) ? (notes) => saveRepo(selectedRepo, { notes }) : undefined} />}
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
      <RepoImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={(repo) => {
          saveRepo(repo, {})
          setSelectedView(GITHUB_ALL_VIEW)
          setSelectedRepoId(String(repo.id))
          navigateToAddress(repoAddress(repo.fullName))
          toast({ title: t('development.github.repos.import_done', { name: repo.fullName }), tone: 'success' })
        }}
      />
    </>
  )
}
