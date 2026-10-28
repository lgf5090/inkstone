import { useCallback, useMemo, useState } from 'react'
import type { GithubPrefs, GithubRepo, GithubViewId, SavedGithubRepo } from '@shared/development/github/types'
import { GITHUB_EXPLORE_VIEW, GITHUB_PER_PAGE } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
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
}: {
  tab: GithubTab
  onTabChange: (tab: GithubTab) => void
  onOpenAccounts: () => void
  onOpenMirrors: () => void
  currentMirrorId: string
  onCurrentMirrorChange: (id: string) => void
}) {
  const tags = useGithubStore((state) => state.tags)
  const repos = useGithubStore((state) => state.repos)
  const mirrors = useGithubStore((state) => state.mirrors)
  const upsertRepo = useGithubStore((state) => state.upsertRepo)
  const upsertTag = useGithubStore((state) => state.upsertTag)
  const deleteTag = useGithubStore((state) => state.deleteTag)
  const [prefs, setPrefs] = useState(loadRepoPrefs)
  const [selectedView, setSelectedView] = useState<GithubViewId>(GITHUB_EXPLORE_VIEW)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [committedQuery, setCommittedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)

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
    return repos.find((repo) => repo.id === selectedRepoId)?.data ?? null
  }, [selectedRepoId, search.data, repos])

  const listItems = useMemo<GithubRepo[]>(() => {
    if (isExplore) return search.data?.items ?? []
    return filterRepos(sortSavedRepos(repos), selectedView, query).map((repo) => repo.data)
  }, [isExplore, search.data, repos, selectedView, query])

  const totalCount = isExplore ? (search.data?.total ?? 0) : listItems.length
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const currentMirror = mirrors.find((mirror) => mirror.id === currentMirrorId) ?? mirrors[0]
  const tagManager = useMemo(() => tags, [tags])

  const updatePrefs = useCallback((patch: Partial<GithubPrefs>) => {
    setPrefs((previous) => {
      const next = { ...previous, ...patch }
      saveRepoPrefs(next)
      return next
    })
    setPage(1)
  }, [])

  const selectView = (view: GithubViewId) => {
    setSelectedView(view)
    setSelectedRepoId(null)
    setPage(1)
  }

  const toggleExpand = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const saveRepo = (repo: GithubRepo, patch: Partial<SavedGithubRepo>) => {
    const id = String(repo.id)
    const existing = useGithubStore.getState().repos.find((entry) => entry.id === id)
    const now = Date.now()
    const next: SavedGithubRepo = existing
      ? { ...existing, ...patch, updatedAt: now }
      : { id, fullName: repo.fullName, url: repo.url, data: repo, tagIds: [], pinned: false, favorited: false, createdAt: now, updatedAt: now, ...patch }
    void upsertRepo(next)
  }

  const togglePin = (repo: GithubRepo) => {
    const existing = useGithubStore.getState().repos.find((entry) => entry.id === String(repo.id))
    saveRepo(repo, { pinned: !existing?.pinned })
  }

  const toggleFav = (repo: GithubRepo) => {
    const existing = useGithubStore.getState().repos.find((entry) => entry.id === String(repo.id))
    saveRepo(repo, { favorited: !existing?.favorited })
  }

  const toggleTag = (repo: GithubRepo, tag: string) => {
    const existing = useGithubStore.getState().repos.find((entry) => entry.id === String(repo.id))
    const tagIds = existing?.tagIds ?? []
    saveRepo(repo, { tagIds: tagIds.includes(tag) ? tagIds.filter((id) => id !== tag) : [...tagIds, tag] })
  }

  const addTag = (name: string, color: string, parentId: string | null) => {
    const now = Date.now()
    void upsertTag({ id: tagId(), name, color, parentId, sortOrder: tags.filter((tag) => tag.parentId === parentId).length, createdAt: now, updatedAt: now })
  }

  const updateTag = (id: string, patch: { name: string; color: string }) => {
    const existing = tags.find((tag) => tag.id === id)
    if (!existing) return
    void upsertTag({ ...existing, ...patch, updatedAt: Date.now() })
  }

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
        sidebar={sidebar}
        list={({ toggleSidebar, toggleDetail, detailDisabled }) => (
          <RepoList
            isExplore={isExplore}
            query={query}
            onQueryChange={setQuery}
            onCommitSearch={() => { setCommittedQuery(query.trim()); setPage(1) }}
            onClear={() => { setQuery(''); setCommittedQuery(''); setPage(1) }}
            loading={search.loading}
            error={search.error instanceof Error ? search.error.message : null}
            prefs={prefs}
            onUpdatePrefs={updatePrefs}
            mirrors={mirrors}
            currentMirrorId={currentMirrorId}
            onCurrentMirrorChange={onCurrentMirrorChange}
            onManageMirrors={onOpenMirrors}
            onRefresh={() => { if (isExplore) void search.refetch() }}
            items={listItems}
            totalCount={totalCount}
            page={page}
            onPageChange={setPage}
            repoMap={repoMap}
            tags={tags}
            selectedRepoId={selectedRepoId}
            onSelectRepo={(repo) => setSelectedRepoId(String(repo.id))}
            onTogglePin={togglePin}
            onToggleFav={toggleFav}
            onToggleTag={toggleTag}
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
        tags={tagManager}
        title={t('development.github.tags.manage_title')}
        description={t('development.github.tags.manage_desc')}
        onAdd={addTag}
        onUpdate={updateTag}
        onDelete={(id) => void deleteTag(id)}
      />
    </>
  )
}
