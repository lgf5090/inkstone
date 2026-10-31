import { useEffect, useMemo, useState } from 'react'
import type { GistFilesPatch, GistItem, GistPrefs, GistViewId, SavedGist } from '@shared/development/github/types'
import { GIST_ALL_VIEW, GIST_FAV_VIEW, GIST_MY_GITHUB_VIEW, GIST_PINNED_VIEW, GIST_EXPLORE_VIEW, extractUsernameFromView, isRemoteView } from '@shared/development/github/types'
import { MAX_GIST_DATA_BYTES } from '@shared/development/github/limits'
import { utf8ByteLength } from '@shared/text-utils'
import { t } from '../../../../lib/i18n'
import { useGithubStore } from '../store'
import { loadGistPrefs, loadGistViewMode, saveGistPrefs, saveGistViewMode } from '../prefs'
import { useGistDetailRemote, useRemoteGists } from '../cache'
import { githubApi } from '../api'
import { sortGists } from '../lib/filters'
import { GithubPanes } from '../GithubPanes'
import { ModuleTabs, type GithubTab } from './ModuleTabs'
import { GistSidebar } from './GistSidebar'
import { GistList } from './GistList'
import { GistDetail } from './GistDetail'
import { TagManager } from './TagManager'
import { SidebarFooter } from './SidebarFooter'
import { GistCreateDialog, GistImportDialog } from './GistDialogs'
import { ExportHistoryDialog } from './ExportHistoryDialog'
import { confirm } from '../../../../components/overlay'
import { Button, Spinner } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'

function causeText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tagId(): string {
  return `gist-tag-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function wrapRemote(gist: GistItem, local: SavedGist | undefined): SavedGist {
  if (local) return { ...local, data: gist }
  return { id: gist.id, description: gist.description, url: gist.url, data: gist, tagIds: [], pinned: false, favorited: false, notes: '', createdAt: Date.parse(gist.createdAt) || 0, updatedAt: Date.parse(gist.updatedAt) || 0 }
}

export function GistsPane({
  tab,
  onTabChange,
  onOpenAccounts,
  onOpenMirrors,
  currentMirrorId,
}: {
  tab: GithubTab
  onTabChange: (tab: GithubTab) => void
  onOpenAccounts: () => void
  onOpenMirrors: () => void
  currentMirrorId: string
}) {
  const gistTags = useGithubStore((state) => state.gistTags)
  const gists = useGithubStore((state) => state.gists)
  const accounts = useGithubStore((state) => state.accounts)
  const activeAccountId = useGithubStore((state) => state.activeAccountId)
  const exportsEnabled = useGithubStore((state) => state.capabilities.exports)
  const mirrors = useGithubStore((state) => state.mirrors)
  const upsertGist = useGithubStore((state) => state.upsertGist)
  const patchGist = useGithubStore((state) => state.patchGist)
  const deleteGist = useGithubStore((state) => state.deleteGist)
  const batchDelete = useGithubStore((state) => state.batchDeleteGists)
  const batchUpdate = useGithubStore((state) => state.batchUpdateGists)
  const upsertGistTag = useGithubStore((state) => state.upsertGistTag)
  const deleteGistTag = useGithubStore((state) => state.deleteGistTag)
  const refresh = useGithubStore((state) => state.refresh)
  const toast = useUi((state) => state.toast)
  const [prefs, setPrefs] = useState(loadGistPrefs)
  const [refreshing, setRefreshing] = useState(false)
  const [viewMode, setViewMode] = useState<'list' | 'card'>(loadGistViewMode)
  const [selectedView, setSelectedView] = useState<GistViewId>(GIST_ALL_VIEW)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedGistId, setSelectedGistId] = useState<string | null>(null)
  const [selectedRemoteId, setSelectedRemoteId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [remotePage, setRemotePage] = useState(1)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [exportHistoryOpen, setExportHistoryOpen] = useState(false)
  const [searchIds, setSearchIds] = useState<Set<string> | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [fullGists, setFullGists] = useState<Map<string, SavedGist>>(new Map())
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const remote = isRemoteView(selectedView)
  const remoteUsername = extractUsernameFromView(selectedView)
  const remoteType = selectedView === GIST_EXPLORE_VIEW ? 'public' : selectedView === GIST_MY_GITHUB_VIEW ? 'mine' : 'user'
  const remoteQuery = useRemoteGists(
    remoteType,
    remoteUsername,
    remotePage,
    remote,
    selectedView === GIST_MY_GITHUB_VIEW ? activeAccountId : null,
  )
  const remoteDetail = useGistDetailRemote(remote ? selectedRemoteId : null)
  const remoteItems = useMemo(() => (remoteQuery.data?.items ?? []).map((gist) => wrapRemote(gist, gists.find((local) => local.id === gist.id))), [remoteQuery.data, gists])
  const filteredRemote = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? remoteItems.filter((gist) => gist.description.toLowerCase().includes(needle) || gist.data.files.some((file) => file.filename.toLowerCase().includes(needle) || file.content.toLowerCase().includes(needle))) : remoteItems
  }, [remoteItems, query])
  const filteredLocal = useMemo(() => {
    let list = gists
    if (selectedView === GIST_PINNED_VIEW) list = gists.filter((gist) => gist.pinned)
    else if (selectedView === GIST_FAV_VIEW) list = gists.filter((gist) => gist.favorited)
    else if (selectedView.startsWith('tag:')) { const tag = selectedView.slice(4); list = gists.filter((gist) => gist.tagIds.includes(tag)) }
    const needle = query.trim().toLowerCase()
    if (needle) {
      list = searchIds
        ? list.filter((gist) => searchIds.has(gist.id))
        : list.filter((gist) => gist.description.toLowerCase().includes(needle) || gist.data.files.some((file) => file.filename.toLowerCase().includes(needle) || (file.preview ?? '').toLowerCase().includes(needle)))
    }
    return sortGists(list, prefs)
  }, [gists, selectedView, query, prefs, searchIds])
  const items = remote ? filteredRemote : filteredLocal
  const selectedLocal = gists.find((gist) => gist.id === selectedGistId) ?? null
  const selectedRemote = remote ? remoteItems.find((gist) => gist.id === selectedRemoteId) ?? null : null
  const needsFull = Boolean(selectedLocal?.data.files.some((file) => file.truncated))
  const localDetail = selectedLocal
    ? needsFull
      ? fullGists.get(selectedLocal.id)?.data ?? null
      : selectedLocal.data
    : null
  const detailGist = remote ? remoteDetail.data ?? selectedRemote?.data ?? null : localDetail
  const ownUsernames = useMemo(() => new Set(accounts.map((account) => account.username)), [accounts])
  const canEditRemote = Boolean(detailGist?.owner && ownUsernames.has(detailGist.owner.login))
  const savedRemoteIds = useMemo(() => new Set(gists.map((gist) => gist.id)), [gists])
  const currentMirror = mirrors.find((mirror) => mirror.id === currentMirrorId) ?? mirrors[0]
  const activeAccount = accounts.find((account) => account.id === activeAccountId) ?? accounts[0] ?? null

  useEffect(() => { setRemotePage(1) }, [selectedView])

  const needle = query.trim()
  useEffect(() => {
    if (remote || !needle) {
      setSearchIds(null)
      setSearchLoading(false)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSearchLoading(true)
      githubApi.searchSavedGists(needle, controller.signal)
        .then((ids) => { if (!cancelled) setSearchIds(new Set(ids)) })
        .catch((error) => {
          if (cancelled) return
          setSearchIds(null)
          toast({ title: causeText(error), tone: 'danger' })
        })
        .finally(() => { if (!cancelled) setSearchLoading(false) })
    }, 200)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [needle, remote, toast])

  const localId = selectedLocal?.id ?? null
  const localUpdatedAt = selectedLocal?.updatedAt ?? 0
  useEffect(() => {
    if (remote || !localId || !needsFull) {
      setDetailLoading(false)
      setDetailError(null)
      return
    }
    const cached = fullGists.get(localId)
    if (cached && cached.updatedAt >= localUpdatedAt) {
      setDetailLoading(false)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    githubApi.getSavedGist(localId)
      .then((gist) => {
        if (cancelled) return
        setFullGists((previous) => {
          const next = new Map(previous)
          next.delete(localId)
          next.set(localId, gist)
          while (next.size > 20) {
            const oldest = next.keys().next().value
            if (oldest === undefined) break
            next.delete(oldest)
          }
          return next
        })
      })
      .catch((error) => { if (!cancelled) setDetailError(causeText(error)) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [remote, localId, localUpdatedAt, needsFull, fullGists])

  const retryFull = () => {
    if (!localId) return
    setDetailError(null)
    setFullGists((previous) => {
      const next = new Map(previous)
      next.delete(localId)
      return next
    })
  }

  const updatePrefs = (patch: Partial<GistPrefs>) => {
    setPrefs((previous) => {
      const next = { ...previous, ...patch }
      saveGistPrefs(next)
      return next
    })
  }
  const changeViewMode = (mode: 'list' | 'card') => {
    setViewMode(mode)
    saveGistViewMode(mode)
  }
  const selectView = (view: GistViewId) => {
    setSelectedView(view)
    setSelectedGistId(null)
    setSelectedRemoteId(null)
    setSelectedIds(new Set())
    setQuery('')
  }
  const toggleExpand = (id: string) => setExpanded((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const persist = (gist: SavedGist) => upsertGist({ ...gist, updatedAt: Date.now() })
  const currentGist = (gist: SavedGist) => useGithubStore.getState().gists.find((entry) => entry.id === gist.id) ?? gist
  const togglePin = (gist: SavedGist) => { const current = currentGist(gist); void patchGist(current.id, { pinned: !current.pinned }) }
  const toggleFav = (gist: SavedGist) => { const current = currentGist(gist); void patchGist(current.id, { favorited: !current.favorited }) }
  const toggleTag = (gist: SavedGist, tag: string) => { const current = currentGist(gist); void patchGist(current.id, { tagIds: current.tagIds.includes(tag) ? current.tagIds.filter((id) => id !== tag) : [...current.tagIds, tag] }) }
  const updateNotes = (notes: string) => { if (selectedGistId) void patchGist(selectedGistId, { notes }) }
  const snapshotFits = (data: GistItem): boolean =>
    utf8ByteLength(JSON.stringify(data)) <= MAX_GIST_DATA_BYTES
  const snapshotTooLarge = (): string =>
    t('development.github.gists.snapshot_too_large', {
      limit: Math.round(MAX_GIST_DATA_BYTES / (1024 * 1024)),
    })
  const saveLocal = async (gist: SavedGist) => {
    let data = gist.data
    if (data.files.some((file) => !file.content && file.size > 0)) {
      try {
        data = await githubApi.gistDetail(gist.id)
      } catch (cause) {
        toast({ title: cause instanceof Error ? cause.message : t('development.github.common.load_failed'), tone: 'danger' })
        return
      }
    }
    if (!snapshotFits(data)) {
      toast({ title: snapshotTooLarge(), tone: 'danger' })
      return
    }
    const now = Date.now()
    persist({ id: gist.id, description: data.description, url: data.url, data, tagIds: [], pinned: false, favorited: false, notes: '', createdAt: now, updatedAt: now })
    setSelectedGistId(gist.id)
  }
  const check = (id: string, next: boolean) => setSelectedIds((previous) => { const set = new Set(previous); if (next) set.add(id); else set.delete(id); return set })
  const selectAll = () => setSelectedIds((previous) => { const all = items.length > 0 && items.every((gist) => previous.has(gist.id)); const next = new Set(previous); items.forEach((gist) => { if (all) next.delete(gist.id); else next.add(gist.id) }); return next })
  const batchPin = (pinned: boolean) => { if (selectedIds.size > 0) void batchUpdate(Array.from(selectedIds), { pinned }) }
  const batchFav = (favorited: boolean) => { if (selectedIds.size > 0) void batchUpdate(Array.from(selectedIds), { favorited }) }
  const batchTag = (tag: string, action: 'add' | 'remove') => { if (selectedIds.size > 0) void batchUpdate(Array.from(selectedIds), action === 'add' ? { addTagIds: [tag] } : { removeTagIds: [tag] }) }
  const batchRemove = async () => {
    if (selectedIds.size === 0) return
    const ok = await confirm({ title: t('development.github.gists.delete_title'), description: t('development.github.gists.delete_batch_desc', { count: selectedIds.size }), confirmLabel: t('development.github.gists.confirm_delete'), tone: 'danger' })
    if (!ok) return
    void batchDelete(Array.from(selectedIds))
    setSelectedIds(new Set())
    setSelectedGistId(null)
  }
  const deleteOne = async (id: string) => {
    if (remote) {
      if (!canEditRemote) return
      const ok = await confirm({ title: t('development.github.gists.delete_title'), description: t('development.github.gists.delete_remote_desc', { description: detailGist?.description ?? id }), confirmLabel: t('development.github.gists.confirm_delete'), tone: 'danger' })
      if (!ok) return
      try { await githubApi.deleteRemoteGist(id); if (savedRemoteIds.has(id)) void deleteGist(id); setSelectedRemoteId(null); void remoteQuery.refetch() }
      catch (cause) { toast({ title: cause instanceof Error ? cause.message : t('development.github.gists.delete_failed'), tone: 'danger' }) }
      return
    }
    const ok = await confirm({ title: t('development.github.gists.delete_title'), description: t('development.github.gists.delete_local_desc', { description: selectedLocal?.description ?? id }), confirmLabel: t('development.github.gists.confirm_delete'), tone: 'danger' })
    if (!ok) return
    void deleteGist(id)
    setSelectedGistId(null)
  }
  const updateRemote = async (gist: GistItem, files: GistFilesPatch) => {
    const updated = await githubApi.updateRemoteGist(gist.id, {
      description: gist.description,
      ...(Object.keys(files).length > 0 ? { files } : {}),
    })
    setSelectedRemoteId(updated.id)
    const local = gists.find((entry) => entry.id === gist.id)
    if (local) persist({ ...local, data: updated, updatedAt: Date.now() })
    void remoteQuery.refetch()
    void remoteDetail.refetch()
  }
  const updateLocal = (gist: GistItem) => {
    const current = useGithubStore.getState().gists.find((entry) => entry.id === selectedGistId)
    if (!current) return undefined
    if (!snapshotFits(gist)) throw new Error(snapshotTooLarge())
    return persist({ ...current, description: gist.description, url: gist.url || current.url, data: gist })
  }
  const addTag = (name: string, color: string, parentId: string | null) => { const now = Date.now(); void upsertGistTag({ id: tagId(), name, color, parentId, sortOrder: gistTags.filter((tag) => tag.parentId === parentId).length, createdAt: now, updatedAt: now }) }
  const editTag = (id: string, patch: { name: string; color: string; parentId: string | null }) => { const existing = gistTags.find((tag) => tag.id === id); if (existing) void upsertGistTag({ ...existing, ...patch, updatedAt: Date.now() }) }
  const refreshLocal = async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  const remoteTitle = selectedView === GIST_EXPLORE_VIEW ? t('development.github.gists.public_gists') : selectedView === GIST_MY_GITHUB_VIEW ? `${t('development.github.gists.my_github')}${activeAccount ? ` · ${activeAccount.username}` : ''}` : remoteUsername ? t('development.github.gists.user_gists', { username: remoteUsername }) : t('development.github.gists.explore_github')

  return (
    <>
      <GithubPanes
        title={t('development.github.gists.title')}
        sidebarHeader={<ModuleTabs value={tab} onChange={onTabChange} />}
        sidebarFooter={<SidebarFooter onOpenAccounts={onOpenAccounts} onOpenMirrors={onOpenMirrors} currentMirrorName={currentMirror?.name} />}
        detailDisabled={!detailGist}
        detailKey={remote ? selectedRemoteId : selectedGistId}
        sidebar={<GistSidebar tags={gistTags} savedGists={gists} selectedView={selectedView} onSelect={selectView} expanded={expanded} onToggleExpand={toggleExpand} onManageTags={() => setTagManagerOpen(true)} onCreate={() => setCreateOpen(true)} onImport={() => setImportOpen(true)} accounts={accounts} />}
        list={({ toggleSidebar, toggleDetail, detailDisabled }) => (
          <GistList
            query={query}
            onQueryChange={setQuery}
            onClear={() => setQuery('')}
            totalCount={items.length}
            viewMode={viewMode}
            onViewModeChange={changeViewMode}
            prefs={prefs}
            onUpdatePrefs={updatePrefs}
            onRefresh={() => { if (remote) void remoteQuery.refetch(); else void refreshLocal() }}
            items={items}
            tags={gistTags}
            selectedGistId={remote ? selectedRemoteId : selectedGistId}
            onSelectGist={(gist) => remote ? setSelectedRemoteId(gist.id) : setSelectedGistId(gist.id)}
            onTogglePin={togglePin}
            onToggleFav={toggleFav}
            onToggleTag={toggleTag}
            selectedIds={selectedIds}
            onCheck={check}
            onSelectAll={selectAll}
            onBatchDelete={() => void batchRemove()}
            onBatchPin={batchPin}
            onBatchFav={batchFav}
            onBatchTag={batchTag}
            onCreate={() => setCreateOpen(true)}
            onImport={() => setImportOpen(true)}
            exportsEnabled={exportsEnabled}
            onOpenExportHistory={() => setExportHistoryOpen(true)}
            loading={remote ? remoteQuery.loading : refreshing || searchLoading}
            error={remote && remoteQuery.error instanceof Error ? remoteQuery.error.message : null}
            remote={remote}
            savedRemoteIds={remote ? savedRemoteIds : undefined}
            onSaveToLocal={remote ? (gist) => void saveLocal(gist) : undefined}
            hasNextPage={remote ? Boolean(remoteQuery.data?.hasNext) : false}
            currentPage={remote ? remotePage : 1}
            onLoadPage={setRemotePage}
            remoteTitle={remote ? remoteTitle : undefined}
            toggleSidebar={toggleSidebar}
            toggleDetail={toggleDetail}
            detailDisabled={detailDisabled}
          />
        )}
        detail={detailLoading && !detailGist
          ? <div className="flex h-full items-center justify-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]"><Spinner size={15} />{t('development.github.common.loading')}</div>
          : detailError && !detailGist
            ? <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"><p className="text-[length:var(--text-12)] text-[var(--danger)]" role="alert">{detailError}</p><Button variant="secondary" size="sm" onClick={retryFull}>{t('development.github.common.retry')}</Button></div>
            : <GistDetail gist={detailGist} notes={remote ? '' : selectedLocal?.notes ?? ''} readOnly={remote ? !canEditRemote : false} exportsEnabled={exportsEnabled} exportable={!remote} onUpdateNotes={remote ? undefined : updateNotes} onUpdateGist={remote ? updateRemote : updateLocal} onDeleteGist={(id) => void deleteOne(id)} onOpenExportHistory={exportsEnabled ? () => setExportHistoryOpen(true) : undefined} />}
      />
      <TagManager open={tagManagerOpen} onClose={() => setTagManagerOpen(false)} tags={gistTags} title={t('development.github.tags.manage_gist_title')} description={t('development.github.tags.manage_gist_desc')} onAdd={addTag} onUpdate={editTag} onDelete={(id) => void deleteGistTag(id)} />
      <GistImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={(gist) => { if (!snapshotFits(gist)) { toast({ title: snapshotTooLarge(), tone: 'danger' }); return } const now = Date.now(); persist({ id: gist.id, description: gist.description, url: gist.url, data: gist, tagIds: [], pinned: false, favorited: false, notes: '', createdAt: now, updatedAt: now }); setSelectedView(GIST_ALL_VIEW); setSelectedGistId(gist.id) }} />
      <GistCreateDialog open={createOpen} onClose={() => setCreateOpen(false)} accountCount={accounts.length} accounts={accounts} activeAccountId={activeAccountId} onOpenAccounts={() => { setCreateOpen(false); onOpenAccounts() }} onCreate={(gist) => { void saveLocal(wrapRemote(gist, undefined)); setSelectedView(GIST_ALL_VIEW) }} />
      <ExportHistoryDialog open={exportHistoryOpen} onClose={() => setExportHistoryOpen(false)} />
    </>
  )
}
