import { AlertCircle, CheckCircle2, Download, Package, PanelLeft, RefreshCw, Trash2 } from 'lucide-react'
import type { GithubMirrorSource, GithubTrackedApp } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Empty } from '../../../../components/feedback'
import { confirm } from '../../../../components/overlay'
import { buildMirrorDownloadUrl, formatDate } from '../lib/format'
import { trackedAppStatus } from '../lib/apps'
import { GithubAvatar } from './GithubAvatar'
import { platformLabel } from './StoreSidebar'

function StatusBadge({ app }: { app: GithubTrackedApp }) {
  const status = trackedAppStatus(app)
  if (!app.latestTag) {
    return <span className="rounded-full bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.apps.not_checked')}</span>
  }
  if (status.state === 'update-available') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] px-2 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--warning)]"><Download size={10} />{t('development.github.apps.update_available')}</span>
  }
  if (status.state === 'up-to-date') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--success)_14%,transparent)] px-2 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--success)]"><CheckCircle2 size={10} />{t('development.github.apps.up_to_date')}</span>
  }
  return <span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]"><AlertCircle size={10} />{t('development.github.apps.unknown')}</span>
}

export function AppsView({
  apps,
  checking,
  mirror,
  onCheck,
  onRemove,
  onOpenSidebar,
}: {
  apps: GithubTrackedApp[]
  checking: boolean
  mirror: GithubMirrorSource | undefined
  onCheck: (ids: string[]) => void
  onRemove: (id: string) => void
  onOpenSidebar: () => void
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
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('development.github.common.toggle_sidebar')} size="sm" className="size-8 md:size-8" onClick={onOpenSidebar}><PanelLeft size={15} /></IconButton>
        <Package size={14} className="text-[var(--text-tertiary)]" />
        <span className="text-[length:var(--text-12)] font-medium">{t('development.github.apps.title')}</span>
        <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.apps.count', { count: apps.length })}</span>
        <Button variant="secondary" size="sm" className="ml-auto" disabled={checking || apps.length === 0} onClick={() => onCheck(apps.map((app) => app.id))}>
          {checking ? <Spinner size={12} /> : <RefreshCw size={12} />}
          {checking ? t('development.github.apps.checking') : t('development.github.apps.check_all')}
        </Button>
      </div>
      {apps.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty art="folder" title={t('development.github.apps.empty_title')} description={t('development.github.apps.empty_desc')} />
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto overscroll-contain">
          {apps.map((app) => {
            const status = trackedAppStatus(app)
            const mirrorUrl = app.latestAssetUrl && mirror ? buildMirrorDownloadUrl(mirror.url, app.latestAssetUrl) : app.latestAssetUrl
            return (
              <li key={app.id} className="flex items-start gap-2.5 px-3 py-3" data-slot="github-app-row">
                <GithubAvatar src={app.ownerAvatarUrl} name={app.fullName.split('/')[0] ?? app.fullName} size={30} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={app.repoUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-[length:var(--text-13)] font-semibold hover:text-[var(--accent)] hover:underline">{app.fullName}</a>
                    <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{platformLabel(app.platform)}</span>
                    <StatusBadge app={app} />
                    <span className="ml-auto flex shrink-0 items-center gap-0.5">
                      <IconButton label={t('development.github.apps.check_one')} size="sm" disabled={checking} onClick={() => onCheck([app.id])}><RefreshCw size={12} /></IconButton>
                      <IconButton label={t('development.github.apps.remove')} size="sm" onClick={() => void remove(app)}><Trash2 size={12} /></IconButton>
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                    <span>{t('development.github.apps.installed', { tag: app.installedTag || '—' })}</span>
                    <span className={cn(app.latestTag && status.state === 'update-available' && 'font-medium text-[var(--warning)]')}>{t('development.github.apps.latest', { tag: app.latestTag || '—' })}</span>
                    {app.assetPattern && <span className="text-[var(--text-quaternary)]">{t('development.github.apps.asset_pattern_chip', { pattern: app.assetPattern })}</span>}
                    {app.checkedAt > 0 && <span className="text-[var(--text-quaternary)]">{t('development.github.apps.last_checked', { date: formatDate(new Date(app.checkedAt).toISOString()) })}</span>}
                  </div>
                  {app.latestTag && !status.hasAsset && <p className="mt-1 text-[length:var(--text-11)] text-[var(--warning)]">{t('development.github.apps.no_asset')}</p>}
                </div>
                {mirrorUrl && (
                  <a href={mirrorUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex h-7 shrink-0 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
                    <Download size={12} />{t('development.github.apps.download')}
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
