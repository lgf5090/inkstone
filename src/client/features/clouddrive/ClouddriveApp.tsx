import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { HardDrive, LayoutGrid, List, PanelLeft, RefreshCw, Trash2 } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { navigateToPath } from '../../lib/app-history'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { useSession } from '../../store/session'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Drawer } from '../../components/overlay'
import { FilePreviewModal } from '../file-preview'
import { cloudDrivePath, useCloudDriveAddress, type CloudDrivePage } from './address'
import { cloudDriveCssVars } from './prefs'
import { useCloudDriveStore } from './store'
import { FilesPage } from './files/FilesPage'
import { MountsPage } from './mounts/MountsPage'
import { SharesPage } from './shares/SharesPage'
import { DashboardPage } from './admin/DashboardPage'
import { AlbumPage } from './album/AlbumPage'
import { TransfersPage } from './transfers/TransfersPage'
import { CloudDriveSettingsPage } from './settings/CloudDriveSettingsPage'
import { ApiKeysPage } from './keys/ApiKeysPage'
import './clouddrive.css'

const FAVORITES: readonly { page: CloudDrivePage; labelKey: MessageKey; icon: typeof HardDrive }[] = [
  { page: 'files', labelKey: 'clouddrive.nav.files', icon: HardDrive },
  { page: 'album', labelKey: 'clouddrive.nav.album', icon: LayoutGrid },
  { page: 'recent', labelKey: 'clouddrive.nav.recent', icon: RefreshCw },
  { page: 'starred', labelKey: 'clouddrive.nav.starred', icon: HardDrive },
  { page: 'trash', labelKey: 'clouddrive.nav.trash', icon: Trash2 },
  { page: 'shares', labelKey: 'clouddrive.nav.shares', icon: HardDrive },
]

const MANAGE: readonly { page: CloudDrivePage; labelKey: MessageKey; ownerOnly?: boolean }[] = [
  { page: 'mounts', labelKey: 'clouddrive.nav.mounts', ownerOnly: true },
  { page: 'storage', labelKey: 'clouddrive.nav.storage', ownerOnly: true },
  { page: 'dashboard', labelKey: 'clouddrive.nav.dashboard', ownerOnly: true },
  { page: 'files-admin', labelKey: 'clouddrive.nav.admin_files', ownerOnly: true },
  { page: 'index', labelKey: 'clouddrive.nav.index', ownerOnly: true },
  { page: 'preview-settings', labelKey: 'clouddrive.nav.preview', ownerOnly: true },
  { page: 'jobs', labelKey: 'clouddrive.nav.jobs', ownerOnly: true },
  { page: 'tasks', labelKey: 'clouddrive.nav.tasks' },
  { page: 'keys', labelKey: 'clouddrive.nav.keys' },
  { page: 'maintenance', labelKey: 'clouddrive.nav.maintenance', ownerOnly: true },
  { page: 'settings', labelKey: 'clouddrive.nav.settings' },
]

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
  const [preview, setPreview] = useState<CloudDriveEntry | null>(null)
  const [mobileNav, setMobileNav] = useState(false)

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
          {owner && (
            <SidebarSection label={t('clouddrive.sidebar.manage')}>
              {MANAGE.filter((item) => !item.ownerOnly || owner).map((item) => (
                <SidebarLink key={item.page} page={item.page} active={address.page === item.page} label={t(item.labelKey)} icon={HardDrive} mountId={address.mountId} onNavigate={navigate} />
              ))}
            </SidebarSection>
          )}
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
          <IconButton label={t('clouddrive.toolbar.refresh')} onClick={bumpRefresh}><RefreshCw size={15} /></IconButton>
          <nav aria-label={t('clouddrive.title')} className="flex min-w-0 items-center gap-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <span className="truncate">{mounts.find((mount) => mount.id === address.mountId)?.name ?? t('clouddrive.sidebar.primary')}</span>
            {address.path !== '/' && <><span aria-hidden>/</span><span className="truncate">{address.path}</span></>}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <IconButton label={t('clouddrive.toolbar.view_list')} active={prefs.viewMode === 'list'} onClick={() => setPrefs({ viewMode: 'list' })}><List size={15} /></IconButton>
            <IconButton label={t('clouddrive.toolbar.view_icon')} active={prefs.viewMode === 'icon'} onClick={() => setPrefs({ viewMode: 'icon' })}><LayoutGrid size={15} /></IconButton>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto">
          {address.page === 'files'
            ? (
                <FilesPage
                  mountId={address.mountId}
                  path={address.path}
                  readOnly={bootstrap.mounts.find((mount) => mount.id === address.mountId)?.readOnly}
                  onNavigate={navigate}
                  onPreview={setPreview}
                />
              )
            : address.page === 'album'
              ? <AlbumPage onOpenFiles={() => navigate(cloudDrivePath('files', address.mountId, '/'))} />
              : address.page === 'dashboard'
                ? <DashboardPage />
                : address.page === 'tasks'
                  ? <TransfersPage />
                  : address.page === 'settings'
                    ? <CloudDriveSettingsPage owner={owner} />
                    : address.page === 'keys'
                      ? <ApiKeysPage />
                      : address.page === 'shares'
                      ? <SharesPage />
                      : address.page === 'mounts' || address.page === 'storage'
                        ? <MountsPage showStorages={address.page === 'storage'} />
                        : <PagePlaceholder page={address.page} />}
        </main>
      </div>
      <Drawer open={mobileNav} onClose={() => setMobileNav(false)} side="left" width={278} title={t('clouddrive.title')}>
        <div className="flex flex-col gap-1 p-2">
          {[...FAVORITES, ...MANAGE.filter((item) => !item.ownerOnly || owner)].map((item) => (
            <a key={item.page} href={cloudDrivePath(item.page, address.mountId, '/')} onClick={(event) => { event.preventDefault(); setMobileNav(false); navigate(cloudDrivePath(item.page, address.mountId, '/')) }} className="flex h-9 items-center gap-2 rounded-[var(--r-md)] px-2 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
              {t(item.labelKey)}
            </a>
          ))}
          {mounts.map((mount) => (
            <a key={mount.id} href={cloudDrivePath('files', mount.id, '/')} onClick={(event) => { event.preventDefault(); setMobileNav(false); navigate(cloudDrivePath('files', mount.id, '/')) }} className="flex h-9 items-center gap-2 rounded-[var(--r-md)] px-2 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
              {mount.name}
            </a>
          ))}
        </div>
      </Drawer>
      {preview && (
        <FilePreviewModal
          open
          onClose={() => setPreview(null)}
          file={{ url: `/api/clouddrive/files/${encodeURIComponent(preview.id)}/content`, filename: preview.name, mime: preview.mime, size: preview.size }}
        />
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
      className={cn('flex h-8 items-center gap-2 rounded-[var(--r-md)] px-2 text-[length:var(--text-12)]', active ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
    >
      <Icon size={14} aria-hidden /> <span className="truncate">{label}</span>
    </a>
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
