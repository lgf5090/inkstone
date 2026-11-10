import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GithubDiscoverChart, GithubPlatformFilter, GithubRepo } from '@shared/development/github/types'
import { GITHUB_DISCOVER_PER_PAGE } from '@shared/development/github/types'
import { updateState } from '@shared/development/github/platforms'
import { t } from '../../../../lib/i18n'
import { navigateToPath } from '../../../../lib/app-history'
import { useUi } from '../../../../store/ui'
import { useGithubDiscover } from '../cache'
import { useGithubStore } from '../store'
import { storeAddress, type GithubStoreView } from '../routes'
import { GithubPanes } from '../GithubPanes'
import { ModuleTabs, type GithubTab } from './ModuleTabs'
import { SidebarFooter } from './SidebarFooter'
import { StoreSidebar } from './StoreSidebar'
import { DiscoverList } from './DiscoverList'
import { AppsView } from './AppsView'
import { RepoDetail } from './RepoDetail'

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
  const deleteApp = useGithubStore((state) => state.deleteApp)
  const checkApps = useGithubStore((state) => state.checkApps)
  const toast = useUi((state) => state.toast)
  const [view, setView] = useState<GithubStoreView>(initialView)
  const [chart, setChart] = useState<GithubDiscoverChart>('trending')
  const [platform, setPlatform] = useState<GithubPlatformFilter>('all')
  const [topic, setTopic] = useState('')
  const [page, setPage] = useState(1)
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null)
  const [checking, setChecking] = useState(false)

  const query = useMemo(() => ({
    chart,
    platform,
    topic,
    page,
    perPage: GITHUB_DISCOVER_PER_PAGE,
  }), [chart, platform, topic, page])
  const discover = useGithubDiscover(query, active && view === 'discover')

  const updateCount = useMemo(
    () => apps.filter((app) => app.latestTag && updateState(app.latestTag, app.installedTag) === 'update-available').length,
    [apps],
  )

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
    setPage(1)
  }, [])

  const changePlatform = useCallback((next: GithubPlatformFilter) => {
    setPlatform(next)
    setPage(1)
  }, [])

  const changeTopic = useCallback((next: string) => {
    setTopic(next)
    setPage(1)
  }, [])

  const clearFilters = useCallback(() => {
    setChart('trending')
    setPlatform('all')
    setTopic('')
    setPage(1)
  }, [])

  const runCheck = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    if (accounts.length === 0) {
      toast({ title: t('development.github.apps.account_required'), tone: 'warning' })
      return
    }
    setChecking(true)
    try {
      const result = await checkApps(ids)
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
  }, [accounts.length, checkApps, toast])

  const removeApp = useCallback((id: string) => {
    void deleteApp(id)
    toast({ title: t('development.github.apps.removed'), tone: 'success' })
  }, [deleteApp, toast])

  const currentMirror = mirrors.find((mirror) => mirror.id === currentMirrorId) ?? mirrors[0]
  const saved = selectedRepo ? repos.find((entry) => entry.id === String(selectedRepo.id)) : undefined

  const sidebar = (
    <StoreSidebar
      view={view}
      onViewChange={changeView}
      chart={chart}
      onChartChange={changeChart}
      platform={platform}
      onPlatformChange={changePlatform}
      topic={topic}
      onTopicChange={changeTopic}
      appCount={apps.length}
      updateCount={updateCount}
      filteredCount={view === 'discover' ? discover.data?.total ?? 0 : apps.length}
    />
  )

  return (
    <GithubPanes
      title={view === 'apps' ? t('development.github.apps.title') : t('development.github.store.title')}
      sidebarHeader={<ModuleTabs value={tab} onChange={onTabChange} />}
      sidebarFooter={<SidebarFooter onOpenAccounts={onOpenAccounts} onOpenMirrors={onOpenMirrors} currentMirrorName={currentMirror?.name} />}
      detailDisabled={!selectedRepo}
      detailKey={selectedRepo ? String(selectedRepo.id) : null}
      sidebar={sidebar}
      list={({ toggleSidebar }) => (view === 'apps'
        ? <AppsView apps={apps} checking={checking} mirror={currentMirror} onCheck={(ids) => void runCheck(ids)} onRemove={removeApp} onOpenSidebar={toggleSidebar} />
        : (
          <DiscoverList
            result={discover.data}
            loading={discover.loading}
            error={discover.error}
            onRetry={() => void discover.refetch()}
            page={page}
            onPageChange={setPage}
            onSelectRepo={setSelectedRepo}
            onClearFilters={clearFilters}
            onOpenSidebar={toggleSidebar}
          />
        ))}
      detail={<RepoDetail repo={selectedRepo} mirror={currentMirror} notes={saved?.notes ?? ''} />}
    />
  )
}
