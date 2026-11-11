import { useRef, useState } from 'react'
import { Copy, Download, ExternalLink, PanelLeft, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import type { GithubMirrorSource, GithubTrackedApp } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { copyText } from '../../../../lib/clipboard'
import { Badge, Button, IconButton, Spinner } from '../../../../components/primitives'
import { Empty } from '../../../../components/feedback'
import { confirm, Menu, useContextMenu, type MenuItem } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { buildMirrorDownloadUrl, formatDate } from '../lib/format'
import { trackedAppStatus } from '../lib/apps'
import type { GithubSectionView } from '../prefs'
import { GithubAvatar } from './GithubAvatar'
import { platformLabel } from './StoreSidebar'
import { ViewToggle } from './ViewToggle'

const ORIGIN = { x: 0, y: 0 }

function StatusBadge({ app }: { app: GithubTrackedApp }) {
  const status = trackedAppStatus(app)
  if (!app.latestTag) return <Badge tone="neutral">{t('development.github.apps.not_checked')}</Badge>
  if (status.suppressed === 'ignored') return <Badge tone="neutral">{t('development.github.apps.ignored')}</Badge>
  if (status.suppressed === 'skipped') return <Badge tone="neutral">{t('development.github.apps.skipped')}</Badge>
  if (status.state === 'update-available') return <Badge tone="warning">{t('development.github.apps.update_available')}</Badge>
  if (status.state === 'up-to-date') return <Badge tone="success">{t('development.github.apps.up_to_date')}</Badge>
  return <Badge tone="neutral">{t('development.github.apps.unknown')}</Badge>
}

function RowMenu({ app, onPatch }: { app: GithubTrackedApp; onPatch: (patch: Partial<GithubTrackedApp>) => void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const status = trackedAppStatus(app)
  const items: MenuItem[] = [
    {
      id: 'ignore',
      label: app.updateCheckEnabled ? t('development.github.apps.ignore_updates') : t('development.github.apps.enable_updates'),
      checked: !app.updateCheckEnabled,
      onSelect: () => onPatch({ updateCheckEnabled: !app.updateCheckEnabled }),
    },
    {
      id: 'skip',
      label: status.suppressed === 'skipped' ? t('development.github.apps.unskip_release') : t('development.github.apps.skip_release'),
      checked: status.suppressed === 'skipped',
      disabled: !app.latestTag,
      onSelect: () => onPatch({ skippedTag: status.suppressed === 'skipped' ? '' : app.latestTag }),
    },
  ]
  return (
    <>
      <IconButton ref={anchor} label={t('development.github.apps.actions')} size="sm" onClick={() => setOpen(true)}><Settings2 size={12} /></IconButton>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={items} align="end" width={210} label={t('development.github.apps.actions')} />
    </>
  )
}

export function AppsView({
  apps,
  checking,
  mirror,
  view,
  onViewChange,
  onCheck,
  onRemove,
  onPatch,
  onOpenSidebar,
  onDiscover,
}: {
  apps: GithubTrackedApp[]
  checking: boolean
  mirror: GithubMirrorSource | undefined
  view: GithubSectionView
  onViewChange: (view: GithubSectionView) => void
  onCheck: (ids: string[]) => void
  onRemove: (id: string) => void
  onPatch: (app: GithubTrackedApp, patch: Partial<GithubTrackedApp>) => void
  onOpenSidebar: () => void
  onDiscover: () => void
}) {
  const toast = useUi((state) => state.toast)
  const menu = useContextMenu()
  const [target, setTarget] = useState<GithubTrackedApp | null>(null)
  const remove = async (app: GithubTrackedApp) => {
    const ok = await confirm({
      title: t('development.github.apps.remove_title'),
      description: t('development.github.apps.remove_desc', { name: app.fullName, platform: platformLabel(app.platform) }),
      confirmLabel: t('development.github.apps.remove_confirm'),
      tone: 'danger',
    })
    if (ok) onRemove(app.id)
  }
  const copy = async (value: string) => {
    const ok = await copyText(value)
    toast({ title: ok ? t('development.github.sidebar.copied') : t('development.github.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }
  const downloadUrl = (app: GithubTrackedApp) => (app.latestAssetUrl && mirror ? buildMirrorDownloadUrl(mirror.url, app.latestAssetUrl) : app.latestAssetUrl)
  const openMenu = (app: GithubTrackedApp, event: React.MouseEvent) => {
    setTarget(app)
    const row = event.currentTarget as HTMLElement
    row.querySelector<HTMLElement>('a[href]')?.focus({ preventScroll: true })
    menu.onContextMenu(event)
  }
  const openMenuAt = (app: GithubTrackedApp, event: React.KeyboardEvent) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    setTarget(app)
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    menu.openAt({ x: rect.left + 12, y: rect.top + 12 })
  }
  const status = target ? trackedAppStatus(target) : null
  const items: MenuItem[] = target ? [
    {
      id: 'check',
      label: t('development.github.apps.menu.check'),
      icon: <RefreshCw size={13} />,
      disabled: checking || target.updateCheckEnabled === false,
      onSelect: () => onCheck([target.id]),
    },
    {
      id: 'download',
      label: t('development.github.apps.menu.download'),
      icon: <Download size={13} />,
      disabled: !downloadUrl(target),
      reason: downloadUrl(target) ? undefined : t('development.github.apps.no_asset'),
      onSelect: () => { const url = downloadUrl(target); if (url) window.open(url, '_blank', 'noopener,noreferrer') },
    },
    {
      id: 'open',
      label: t('development.github.apps.menu.open_github'),
      icon: <ExternalLink size={13} />,
      onSelect: () => window.open(target.repoUrl, '_blank', 'noopener,noreferrer'),
    },
    {
      id: 'copy-name',
      label: t('development.github.apps.menu.copy_name'),
      icon: <Copy size={13} />,
      separatorBefore: true,
      onSelect: () => void copy(target.fullName),
    },
    {
      id: 'copy-link',
      label: t('development.github.apps.menu.copy_link'),
      icon: <Copy size={13} />,
      onSelect: () => void copy(target.repoUrl),
    },
    {
      id: 'ignore',
      label: target.updateCheckEnabled ? t('development.github.apps.ignore_updates') : t('development.github.apps.enable_updates'),
      checked: !target.updateCheckEnabled,
      separatorBefore: true,
      onSelect: () => onPatch(target, { updateCheckEnabled: !target.updateCheckEnabled }),
    },
    {
      id: 'skip',
      label: status?.suppressed === 'skipped' ? t('development.github.apps.unskip_release') : t('development.github.apps.skip_release'),
      checked: status?.suppressed === 'skipped',
      disabled: !target.latestTag,
      onSelect: () => onPatch(target, { skippedTag: status?.suppressed === 'skipped' ? '' : target.latestTag }),
    },
    {
      id: 'remove',
      label: t('development.github.apps.remove'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => void remove(target),
    },
  ] : []

  const downloadLink = (app: GithubTrackedApp) => {
    const url = downloadUrl(app)
    if (!url) return null
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" aria-label={t('development.github.apps.download')} title={t('development.github.apps.download')} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]">
        <Download size={12} /><span className="hidden sm:inline">{t('development.github.apps.download')}</span>
      </a>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="github-apps">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('development.github.common.toggle_sidebar')} size="sm" className="size-8 shrink-0 md:size-8" onClick={onOpenSidebar}><PanelLeft size={15} /></IconButton>
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('development.github.apps.title')}</span>
        <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{t('development.github.apps.count', { count: apps.length })}</span>
        {checking && <Spinner size={12} className="text-[var(--text-quaternary)]" />}
        <span className="ml-auto flex items-center gap-1.5">
          <ViewToggle value={view} onChange={onViewChange} />
          <Button variant="secondary" size="sm" disabled={checking || apps.length === 0} onClick={() => onCheck(apps.map((app) => app.id))}>
            <RefreshCw size={12} className={checking ? 'animate-spin' : ''} />
            {checking ? t('development.github.apps.checking') : t('development.github.apps.check_all')}
          </Button>
        </span>
      </div>
      {apps.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty art="folder" title={t('development.github.apps.empty_title')} description={t('development.github.apps.empty_desc')} action={<Button size="sm" onClick={onDiscover}>{t('development.github.apps.go_discover')}</Button>} />
        </div>
      ) : view === 'grid' ? (
        <ul className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] content-start gap-2 overflow-y-auto overscroll-contain p-3" data-slot="github-app-grid">
          {apps.map((app) => (
            <li
              key={app.id}
              data-slot="github-app-card"
              onContextMenu={(event) => openMenu(app, event)}
              className="group relative flex min-h-[132px] flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 hover:border-[var(--border-strong)] hover:bg-[var(--bg-raised)]"
            >
              <div className="flex items-start gap-2">
                <GithubAvatar src={app.ownerAvatarUrl} name={app.fullName.split('/')[0] ?? app.fullName} size={28} />
                <div className="min-w-0 flex-1">
                  <a
                    href={app.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onKeyDown={(event) => openMenuAt(app, event)}
                    className="block truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)] hover:text-[var(--accent)] hover:underline"
                    title={app.fullName}
                  >{app.fullName}</a>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{platformLabel(app.platform)}</span>
                    <StatusBadge app={app} />
                  </div>
                </div>
                <RowMenu app={app} onPatch={(patch) => onPatch(app, patch)} />
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                <span className="tabular-nums">{t('development.github.apps.installed', { tag: app.installedTag || '—' })}</span>
                <span className="tabular-nums">{t('development.github.apps.latest', { tag: app.latestTag || '—' })}</span>
              </div>
              <div className="mt-auto flex items-center gap-1 border-t border-[var(--border-subtle)] pt-2 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                {app.checkedAt > 0 && <span className="truncate tabular-nums">{t('development.github.apps.last_checked', { date: formatDate(new Date(app.checkedAt).toISOString()) })}</span>}
                <span className="ml-auto flex shrink-0 items-center gap-0.5">
                  <IconButton label={t('development.github.apps.check_one')} size="sm" disabled={checking} onClick={() => onCheck([app.id])}><RefreshCw size={12} /></IconButton>
                  <IconButton label={t('development.github.apps.remove')} size="sm" onClick={() => void remove(app)}><Trash2 size={12} /></IconButton>
                </span>
                {downloadLink(app)}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto overscroll-contain" data-slot="github-app-list">
          {apps.map((app) => {
            const status = trackedAppStatus(app)
            const mirrorUrl = downloadUrl(app)
            return (
              <li key={app.id} className="group flex items-start gap-2.5 px-2.5 py-2.5" data-slot="github-app-row" onContextMenu={(event) => openMenu(app, event)}>
                <GithubAvatar src={app.ownerAvatarUrl} name={app.fullName.split('/')[0] ?? app.fullName} size={28} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <a
                      href={app.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onKeyDown={(event) => openMenuAt(app, event)}
                      className="min-w-0 truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)] hover:text-[var(--accent)] hover:underline"
                      title={app.fullName}
                    >{app.fullName}</a>
                    <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{platformLabel(app.platform)}</span>
                    <StatusBadge app={app} />
                    <span className="ml-auto flex shrink-0 items-center gap-0.5 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                      <RowMenu app={app} onPatch={(patch) => onPatch(app, patch)} />
                      <IconButton label={t('development.github.apps.check_one')} size="sm" disabled={checking} onClick={() => onCheck([app.id])}><RefreshCw size={12} /></IconButton>
                      <IconButton label={t('development.github.apps.remove')} size="sm" onClick={() => void remove(app)}><Trash2 size={12} /></IconButton>
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    <span className="tabular-nums">{t('development.github.apps.installed', { tag: app.installedTag || '—' })}</span>
                    <span aria-hidden="true" className="text-[var(--text-quaternary)]">·</span>
                    <span className={cn('tabular-nums', app.latestTag && status.state === 'update-available' && !status.suppressed && 'font-medium text-[var(--warning)]')}>{t('development.github.apps.latest', { tag: app.latestTag || '—' })}</span>
                    {app.assetPattern && <Badge tone="neutral">{t('development.github.apps.asset_pattern_chip', { pattern: app.assetPattern })}</Badge>}
                    {app.checkedAt > 0 && <span className="ml-auto tabular-nums text-[var(--text-quaternary)]">{t('development.github.apps.last_checked', { date: formatDate(new Date(app.checkedAt).toISOString()) })}</span>}
                  </div>
                  {app.latestTag && !status.hasAsset && <p className="mt-1 text-[length:var(--text-10)] text-[var(--warning)]">{t('development.github.apps.no_asset')}</p>}
                </div>
                {mirrorUrl && downloadLink(app)}
              </li>
            )
          })}
        </ul>
      )}
      <Menu anchor={menu.point ?? ORIGIN} open={menu.point !== null && target !== null} onClose={() => { menu.close(); setTarget(null) }} items={items} align="start" width={230} label={t('development.github.apps.actions')} />
    </div>
  )
}
