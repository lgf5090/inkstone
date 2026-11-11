import { Download, PanelLeft, RefreshCw, Trash2 } from 'lucide-react'
import type { GithubMirrorSource, GithubTrackedApp } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { Badge, Button, IconButton, Spinner } from '../../../../components/primitives'
import { Empty } from '../../../../components/feedback'
import { confirm } from '../../../../components/overlay'
import { buildMirrorDownloadUrl, formatDate } from '../lib/format'
import { trackedAppStatus } from '../lib/apps'
import { GithubAvatar } from './GithubAvatar'
import { platformLabel } from './StoreSidebar'

function StatusBadge({ app }: { app: GithubTrackedApp }) {
  const status = trackedAppStatus(app)
  if (!app.latestTag) return <Badge tone="neutral">{t('development.github.apps.not_checked')}</Badge>
  if (status.state === 'update-available') return <Badge tone="warning">{t('development.github.apps.update_available')}</Badge>
  if (status.state === 'up-to-date') return <Badge tone="success">{t('development.github.apps.up_to_date')}</Badge>
  return <Badge tone="neutral">{t('development.github.apps.unknown')}</Badge>
}

export function AppsView({
  apps,
  checking,
  mirror,
  onCheck,
  onRemove,
  onOpenSidebar,
  onDiscover,
}: {
  apps: GithubTrackedApp[]
  checking: boolean
  mirror: GithubMirrorSource | undefined
  onCheck: (ids: string[]) => void
  onRemove: (id: string) => void
  onOpenSidebar: () => void
  onDiscover: () => void
}) {
  const remove = async (app: GithubTrackedApp) => {
    const ok = await confirm({
      title: t('development.github.apps.remove_title'),
      description: t('development.github.apps.remove_desc', { name: app.fullName, platform: platformLabel(app.platform) }),
      confirmLabel: t('development.github.apps.remove_confirm'),
      tone: 'danger',
    })
    if (ok) onRemove(app.id)
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="github-apps">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('development.github.common.toggle_sidebar')} size="sm" className="size-8 shrink-0 md:size-8" onClick={onOpenSidebar}><PanelLeft size={15} /></IconButton>
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('development.github.apps.title')}</span>
        <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{t('development.github.apps.count', { count: apps.length })}</span>
        {checking && <Spinner size={12} className="text-[var(--text-quaternary)]" />}
        <Button variant="secondary" size="sm" className="ml-auto" disabled={checking || apps.length === 0} onClick={() => onCheck(apps.map((app) => app.id))}>
          <RefreshCw size={12} className={checking ? 'animate-spin' : ''} />
          {checking ? t('development.github.apps.checking') : t('development.github.apps.check_all')}
        </Button>
      </div>
      {apps.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty art="folder" title={t('development.github.apps.empty_title')} description={t('development.github.apps.empty_desc')} action={<Button size="sm" onClick={onDiscover}>{t('development.github.apps.go_discover')}</Button>} />
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto overscroll-contain">
          {apps.map((app) => {
            const status = trackedAppStatus(app)
            const mirrorUrl = app.latestAssetUrl && mirror ? buildMirrorDownloadUrl(mirror.url, app.latestAssetUrl) : app.latestAssetUrl
            return (
              <li key={app.id} className="group flex items-start gap-2.5 px-2.5 py-2.5" data-slot="github-app-row">
                <GithubAvatar src={app.ownerAvatarUrl} name={app.fullName.split('/')[0] ?? app.fullName} size={28} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <a href={app.repoUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)] hover:text-[var(--accent)] hover:underline">{app.fullName}</a>
                    <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{platformLabel(app.platform)}</span>
                    <StatusBadge app={app} />
                    <span className="ml-auto flex shrink-0 items-center gap-0.5 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                      <IconButton label={t('development.github.apps.check_one')} size="sm" disabled={checking} onClick={() => onCheck([app.id])}><RefreshCw size={12} /></IconButton>
                      <IconButton label={t('development.github.apps.remove')} size="sm" onClick={() => void remove(app)}><Trash2 size={12} /></IconButton>
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    <span className="tabular-nums">{t('development.github.apps.installed', { tag: app.installedTag || '—' })}</span>
                    <span aria-hidden="true" className="text-[var(--text-quaternary)]">·</span>
                    <span className={cn('tabular-nums', app.latestTag && status.state === 'update-available' && 'font-medium text-[var(--warning)]')}>{t('development.github.apps.latest', { tag: app.latestTag || '—' })}</span>
                    {app.assetPattern && <Badge tone="neutral">{t('development.github.apps.asset_pattern_chip', { pattern: app.assetPattern })}</Badge>}
                    {app.checkedAt > 0 && <span className="ml-auto tabular-nums text-[var(--text-quaternary)]">{t('development.github.apps.last_checked', { date: formatDate(new Date(app.checkedAt).toISOString()) })}</span>}
                  </div>
                  {app.latestTag && !status.hasAsset && <p className="mt-1 text-[length:var(--text-10)] text-[var(--warning)]">{t('development.github.apps.no_asset')}</p>}
                </div>
                {mirrorUrl && (
                  <a href={mirrorUrl} target="_blank" rel="noopener noreferrer" aria-label={t('development.github.apps.download')} title={t('development.github.apps.download')} className="mt-0.5 inline-flex h-7 shrink-0 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]">
                    <Download size={12} /><span className="hidden sm:inline">{t('development.github.apps.download')}</span>
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
