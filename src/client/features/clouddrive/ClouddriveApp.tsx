import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import {
  Clock,
  Database,
  Eye,
  Files,
  Gauge,
  HardDrive,
  HardDriveDownload,
  Inbox,
  KeyRound,
  LayoutGrid,
  Link2,
  List,
  ListChecks,
  PanelLeft,
  RefreshCw,
  Search,
  Settings,
  Share2,
  Star,
  Tag,
  Timer,
  Trash2,
  Users,
  Wrench,
} from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { navigateToPath } from '../../lib/app-history'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Drawer } from '../../components/overlay'
import { FilePreviewModal } from '../file-preview'
import { cloudDrivePath, useCloudDriveAddress, type CloudDrivePage } from './address'
import { cloudDriveCssVars } from './prefs'
import { useCloudDriveStore } from './store'
import { FilesPage } from './files/FilesPage'
import './clouddrive.css'

/**
 * The drive opens on the file browser, so that page is loaded with the shell and every other one is
 * fetched when its tab is chosen: the admin console, the album, the sync planner and the share tables
 * are megabytes of code a member may never ask for.
 */
const MountsPage = lazy(() => import('./mounts/MountsPage').then((module) => ({ default: module.MountsPage })))
const StoragePage = lazy(() => import('./mounts/StoragePage').then((module) => ({ default: module.StoragePage })))
const MetaPage = lazy(() => import('./admin/MetaPage').then((module) => ({ default: module.MetaPage })))
const SharesPage = lazy(() => import('./shares/SharesPage').then((module) => ({ default: module.SharesPage })))
const DashboardPage = lazy(() => import('./admin/DashboardPage').then((module) => ({ default: module.DashboardPage })))
const AdminFilesPage = lazy(() => import('./admin/AdminFilesPage').then((module) => ({ default: module.AdminFilesPage })))
const IndexPage = lazy(() => import('./admin/IndexPage').then((module) => ({ default: module.IndexPage })))
const PreviewSettingsPage = lazy(() => import('./admin/PreviewSettingsPage').then((module) => ({ default: module.PreviewSettingsPage })))
const JobsPage = lazy(() => import('./admin/JobsPage').then((module) => ({ default: module.JobsPage })))
const MaintenancePage = lazy(() => import('./admin/MaintenancePage').then((module) => ({ default: module.MaintenancePage })))
const QuickFilesPage = lazy(() => import('./quick/QuickFilesPage').then((module) => ({ default: module.QuickFilesPage })))
const AlbumPage = lazy(() => import('./album/AlbumPage').then((module) => ({ default: module.AlbumPage })))
const TransfersPage = lazy(() => import('./transfers/TransfersPage').then((module) => ({ default: module.TransfersPage })))
const SyncPage = lazy(() => import('./sync/SyncPage').then((module) => ({ default: module.SyncPage })))
const OfflinePage = lazy(() => import('./offline/OfflinePage').then((module) => ({ default: module.OfflinePage })))
const RequestsPage = lazy(() => import('./requests/RequestsPage').then((module) => ({ default: module.RequestsPage })))
const TrashPage = lazy(() => import('./trash/TrashPage').then((module) => ({ default: module.TrashPage })))
const SharedPage = lazy(() => import('./shared/SharedPage').then((module) => ({ default: module.SharedPage })))
const CloudDriveSettingsPage = lazy(() => import('./settings/CloudDriveSettingsPage').then((module) => ({ default: module.CloudDriveSettingsPage })))
const ApiKeysPage = lazy(() => import('./keys/ApiKeysPage').then((module) => ({ default: module.ApiKeysPage })))

const FAVORITES: readonly { page: CloudDrivePage; labelKey: MessageKey; icon: typeof HardDrive }[] = [
  { page: 'files', labelKey: 'clouddrive.nav.files', icon: HardDrive },
  { page: 'album', labelKey: 'clouddrive.nav.album', icon: LayoutGrid },
  { page: 'recent', labelKey: 'clouddrive.nav.recent', icon: Clock },
  { page: 'starred', labelKey: 'clouddrive.nav.starred', icon: Star },
  { page: 'offline', labelKey: 'clouddrive.nav.offline', icon: HardDriveDownload },
  { page: 'trash', labelKey: 'clouddrive.nav.trash', icon: Trash2 },
  { page: 'shares', labelKey: 'clouddrive.nav.shares', icon: Share2 },
  { page: 'requests', labelKey: 'clouddrive.nav.requests', icon: Inbox },
  { page: 'shared', labelKey: 'clouddrive.nav.shared', icon: Users },
]

const MANAGE: readonly { page: CloudDrivePage; labelKey: MessageKey; icon: typeof HardDrive; ownerOnly?: boolean }[] = [
  { page: 'mounts', labelKey: 'clouddrive.nav.mounts', icon: Link2, ownerOnly: true },
  { page: 'storage', labelKey: 'clouddrive.nav.storage', icon: Database, ownerOnly: true },
  { page: 'meta', labelKey: 'clouddrive.nav.meta', icon: Tag, ownerOnly: true },
  { page: 'dashboard', labelKey: 'clouddrive.nav.dashboard', icon: Gauge, ownerOnly: true },
  { page: 'files-admin', labelKey: 'clouddrive.nav.admin_files', icon: Files, ownerOnly: true },
  { page: 'index', labelKey: 'clouddrive.nav.index', icon: Search, ownerOnly: true },
  { page: 'preview-settings', labelKey: 'clouddrive.nav.preview', icon: Eye, ownerOnly: true },
  { page: 'jobs', labelKey: 'clouddrive.nav.jobs', icon: Timer, ownerOnly: true },
  { page: 'tasks', labelKey: 'clouddrive.nav.tasks', icon: ListChecks },
  { page: 'sync', labelKey: 'clouddrive.nav.sync', icon: RefreshCw },
  { page: 'keys', labelKey: 'clouddrive.nav.keys', icon: KeyRound },
  { page: 'maintenance', labelKey: 'clouddrive.nav.maintenance', icon: Wrench, ownerOnly: true },
  { page: 'settings', labelKey: 'clouddrive.nav.settings', icon: Settings },
]

/** One page name per URL, so the top bar and the drawer agree with the sidebar. */
const PAGE_LABELS = new Map<string, MessageKey>([...FAVORITES, ...MANAGE].map((item) => [item.page, item.labelKey]))

export function ClouddriveApp() {
  const address = useCloudDriveAddress()
  const user = useSession((state) => state.user)
  const bootstrap = useCloudDriveStore((state) => state.bootstrap)
  const status = useCloudDriveStore((state) => state.status)
  const error = useCloudDriveStore((state) => state.error)
  const prefs = useCloudDriveStore((state) => state.prefs)
  const load = useCloudDriveStore((state) => state.load)
  const setPrefs = useCloudDriveStore((state) => state.setPrefs)
  const bumpRefresh = useCloudDriveStore((state) => state.bumpRefresh)

  useEffect(() => { void load() }, [load])

  const vars = useMemo(() => cloudDriveCssVars(prefs), [prefs])
  const [preview, setPreview] = useState<{ entries: CloudDriveEntry[]; index: number } | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  /**
   * One button, every page: `refreshKey` is the list pages' signal and the bootstrap call covers the
   * capacity and mount cards that have no list of their own.
   */
  const refreshEverything = useCallback(async () => {
    setRefreshing(true)
    bumpRefresh()
    try {
      await useCloudDriveStore.getState().refresh()
    } catch (caught) {
      useUi.getState().toast({
        title: t('clouddrive.failed'),
        description: caught instanceof Error ? caught.message : String(caught),
        tone: 'danger',
      })
    } finally {
      setRefreshing(false)
    }
  }, [bumpRefresh])

  useEffect(() => {
    if (!preview) return
    const current = preview.entries[preview.index]
    if (!current || !['images', 'txt', 'code'].includes(current.category)) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      event.stopPropagation()
      setPreview((state) => {
        if (!state) return state
        const next = event.key === 'ArrowLeft' ? state.index - 1 : state.index + 1
        if (next < 0 || next >= state.entries.length) return state
        return { ...state, index: next }
      })
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [preview])

  if (IS_DEMO_MODE) {
    return <div className="flex h-full items-center justify-center p-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.demo_unavailable')}</div>
  }

  if (status === 'loading' || status === 'idle') {
    return <div className="flex h-full items-center justify-center"><Spinner /></div>
  }

  if (status === 'error' || !bootstrap) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('clouddrive.failed')}</p>
        {error && <p className="max-w-[520px] text-[length:var(--text-11)] text-[var(--text-tertiary)]">{error}</p>}
        <Button variant="secondary" onClick={() => void load()}>{t('clouddrive.retry')}</Button>
      </div>
    )
  }

  const owner = user?.role === 'owner' || bootstrap.user.role === 'owner'
  const mounts = bootstrap.mounts.filter((mount) => mount.enabled)
  const activeMount = bootstrap.mounts.find((mount) => mount.id === address.mountId)
  const navigate = (path: string) => navigateToPath(path)

  return (
    <div className="cd-app flex h-full min-h-0 bg-[var(--bg-base)]" style={vars as CSSProperties} data-clouddrive-app="">
      <aside className={cn('cd-sidebar flex h-full min-h-0 w-[220px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] max-md:hidden', !prefs.sidebarVisible && 'md:hidden')}>
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
          <span className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]"><HardDrive size={16} /></span>
          <span className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('clouddrive.title')}</span>
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <SidebarSection label={t('clouddrive.sidebar.favorites')}>
            {FAVORITES.map((item) => <SidebarLink key={item.page} page={item.page} active={address.page === item.page} label={t(item.labelKey)} icon={item.icon} mountId={address.mountId} onNavigate={navigate} />)}
          </SidebarSection>
          <SidebarSection label={t('clouddrive.sidebar.locations')}>
            {mounts.map((mount) => (
              <SidebarLink key={mount.id} page="files" active={address.page === 'files' && address.mountId === mount.id} label={mount.name} icon={HardDrive} mountId={mount.id} onNavigate={navigate} />
            ))}
          </SidebarSection>
          <SidebarSection label={t('clouddrive.sidebar.manage')}>
            {MANAGE.filter((item) => !item.ownerOnly || owner).map((item) => (
              <SidebarLink key={item.page} page={item.page} active={address.page === item.page} label={t(item.labelKey)} icon={item.icon} mountId={address.mountId} onNavigate={navigate} />
            ))}
          </SidebarSection>
          <div className="mt-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
            <div className="text-[length:var(--text-10)] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">{t('clouddrive.capacity.title')}</div>
            <div className="mt-1 text-[length:var(--text-11)] text-[var(--text-secondary)]">
              {bootstrap.usage.quotaBytes
                ? t('clouddrive.sidebar.capacity_quota', { used: formatBytes(bootstrap.usage.usedBytes), total: formatBytes(bootstrap.usage.quotaBytes) })
                : t('clouddrive.sidebar.capacity_value', { used: formatBytes(bootstrap.usage.usedBytes) })}
            </div>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
          <IconButton className="md:hidden" label={t('clouddrive.toolbar.menu')} onClick={() => setMobileNav(true)}><PanelLeft size={15} /></IconButton>
          <IconButton label={t('clouddrive.toolbar.refresh')} onClick={() => void refreshEverything()}>
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : undefined} />
          </IconButton>
          <h1 className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t(PAGE_LABELS.get(address.page) ?? 'clouddrive.nav.files')}
          </h1>
          <div className="ml-auto flex items-center gap-1">
            <IconButton label={t('clouddrive.toolbar.view_list')} active={prefs.viewMode === 'list'} onClick={() => setPrefs({ viewMode: 'list' })}><List size={15} /></IconButton>
            <IconButton label={t('clouddrive.toolbar.view_icon')} active={prefs.viewMode === 'icon'} onClick={() => setPrefs({ viewMode: 'icon' })}><LayoutGrid size={15} /></IconButton>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          <Suspense fallback={<PageLoading />}>
          {address.page === 'files'
            ? (
                <FilesPage
                  mountId={address.mountId}
                  mountName={mounts.find((mount) => mount.id === address.mountId)?.name}
                  path={address.path}
                  readOnly={!activeMount || (activeMount.storageId !== 'primary' && activeMount.readOnly)}
                  external={!!activeMount && activeMount.storageId !== 'primary'}
                  folderSummary={activeMount?.folderSummary ?? false}
                  onNavigate={(nextPath) => navigate(cloudDrivePath('files', address.mountId, nextPath))}
                  onPreview={(entry, context) => setPreview({ entries: context?.entries ?? [entry], index: context?.index ?? 0 })}
                />
              )
            : address.page === 'recent'
              ? <QuickFilesPage mode="recent" />
              : address.page === 'starred'
                ? <QuickFilesPage mode="starred" />
                : address.page === 'trash'
                  ? <TrashPage mountId={address.mountId} />
                  : address.page === 'offline'
                  ? <OfflinePage />
                : address.page === 'album'
              ? <AlbumPage onOpenFiles={() => navigate(cloudDrivePath('files', address.mountId, '/'))} />
              : address.page === 'dashboard'
                ? <DashboardPage />
                : address.page === 'files-admin'
                  ? <AdminFilesPage />
                  : address.page === 'index'
                    ? <IndexPage />
                    : address.page === 'preview-settings'
                      ? <PreviewSettingsPage />
                      : address.page === 'jobs'
                        ? <JobsPage />
                        : address.page === 'maintenance'
                          ? <MaintenancePage />
                : address.page === 'tasks'
                  ? <TransfersPage />
                  : address.page === 'sync'
                    ? <SyncPage />
                  : address.page === 'settings'
                    ? <CloudDriveSettingsPage owner={owner} />
                    : address.page === 'keys'
                      ? <ApiKeysPage />
                      : address.page === 'shares'
                      ? <SharesPage />
                      : address.page === 'requests'
                        ? <RequestsPage />
                      : address.page === 'shared'
                        ? <SharedPage />
                      : address.page === 'mounts'
                        ? <MountsPage />
                        : address.page === 'storage'
                          ? <StoragePage />
                          : address.page === 'meta'
                            ? <MetaPage />
                          : <PagePlaceholder page={address.page} />}
          </Suspense>
        </main>
      </div>
      <Drawer open={mobileNav} onClose={() => setMobileNav(false)} side="left" width={278} title={t('clouddrive.title')}>
        <div className="flex flex-col gap-1 p-2">
          {[...FAVORITES, ...MANAGE.filter((item) => !item.ownerOnly || owner)].map((item) => (
            <a key={item.page} href={cloudDrivePath(item.page, address.mountId, '/')} onClick={(event) => { event.preventDefault(); setMobileNav(false); navigate(cloudDrivePath(item.page, address.mountId, '/')) }} className="flex h-9 items-center gap-2 rounded-[var(--r-md)] px-2 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
              <item.icon size={14} aria-hidden /> {t(item.labelKey)}
            </a>
          ))}
          {mounts.map((mount) => (
            <a key={mount.id} href={cloudDrivePath('files', mount.id, '/')} onClick={(event) => { event.preventDefault(); setMobileNav(false); navigate(cloudDrivePath('files', mount.id, '/')) }} className="flex h-9 items-center gap-2 rounded-[var(--r-md)] px-2 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
              <HardDrive size={14} aria-hidden /> {mount.name}
            </a>
          ))}
        </div>
      </Drawer>
      {preview && preview.entries[preview.index] && (
        <>
          <FilePreviewModal
            key={preview.entries[preview.index]!.id}
            open
            onClose={() => setPreview(null)}
            file={{
              url: `/api/clouddrive/files/${encodeURIComponent(preview.entries[preview.index]!.id)}/content`,
              filename: preview.entries[preview.index]!.name,
              mime: preview.entries[preview.index]!.mime,
              size: preview.entries[preview.index]!.size,
            }}
          />
          {preview.entries.length > 1 && (
            <div aria-hidden className="pointer-events-none fixed bottom-4 left-1/2 z-[var(--z-top)] -translate-x-1/2 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1 text-[length:var(--text-11)] tabular text-[var(--text-secondary)] shadow-[var(--shadow-pop)]">
              {preview.index + 1} / {preview.entries.length} · ← →
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SidebarSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-3">
      <h2 className="px-2 pb-1 text-[length:var(--text-10)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{label}</h2>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  )
}

function SidebarLink({ page, label, icon: Icon, active, mountId, onNavigate }: { page: CloudDrivePage; label: string; icon: typeof HardDrive; active: boolean; mountId: string; onNavigate: (path: string) => void }) {
  const path = cloudDrivePath(page, mountId, '/')
  return (
    <a
      href={path}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        onNavigate(path)
      }}
      className={cn('flex h-8 items-center gap-2 rounded-[var(--r-md)] px-2 text-[length:var(--text-12)]', active ? 'bg-[var(--accent-soft)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
    >
      <Icon size={14} aria-hidden /> <span className="truncate">{label}</span>
    </a>
  )
}

/** The chosen page's module is on its way; the shell keeps its shape while it arrives. */
function PageLoading() {
  return (
    <div role="status" aria-live="polite" className="flex h-full items-center justify-center">
      <span className="sr-only">{t('clouddrive.loading')}</span>
      <Spinner />
    </div>
  )
}

function PagePlaceholder({ page }: { page: CloudDrivePage }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[var(--text-tertiary)]">
      <HardDrive size={24} aria-hidden />
      <p className="text-[length:var(--text-13)]">{t(`clouddrive.nav.${page === 'files-admin' ? 'admin_files' : page === 'preview-settings' ? 'preview' : page}` as MessageKey)}</p>
      <p className="text-[length:var(--text-11)]">{t('clouddrive.empty.folder')}</p>
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
