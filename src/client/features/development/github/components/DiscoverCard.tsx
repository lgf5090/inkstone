import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Download, Heart, Star } from 'lucide-react'
import type { GithubDiscoverItem, GithubDiscoverRelease } from '@shared/development/github/types'
import { summarizeRelease } from '@shared/development/github/platforms'
import { t } from '../../../../lib/i18n'
import { IconButton } from '../../../../components/primitives'
import { Menu, type MenuItem } from '../../../../components/overlay'
import { useRepoDetail } from '../cache'
import { buildMirrorDownloadUrl, formatDate, formatNumber } from '../lib/format'
import { GithubAvatar } from './GithubAvatar'
import { PlatformBadges } from './PlatformBadges'

function assetFormat(name: string): string {
  return (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name).toUpperCase()
}

export function DiscoverCard({
  item,
  favorited,
  onToggleFavorite,
  onSelectRepo,
  mirrorBase,
}: {
  item: GithubDiscoverItem
  favorited: boolean
  onToggleFavorite: () => void
  onSelectRepo: () => void
  mirrorBase: string
}) {
  const versionAnchor = useRef<HTMLButtonElement>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [selected, setSelected] = useState<GithubDiscoverRelease | null>(null)
  const detail = useRepoDetail(versionsOpen ? item.repo.fullName : null, item.repo.defaultBranch, ['releases'])
  useEffect(() => {
    setSelected(null)
  }, [item.repo.id, item.release?.tagName])
  const release = selected ?? item.release
  const asset = release?.recommendedAsset ?? null
  const downloadUrl = asset ? buildMirrorDownloadUrl(mirrorBase, asset.downloadUrl) : ''
  const releases = detail.data?.releases ?? []
  const items: MenuItem[] = detail.loading && releases.length === 0
    ? [{ id: 'loading', label: t('development.github.common.loading'), disabled: true }]
    : releases.slice(0, 20).map((candidate) => ({
      id: candidate.tagName,
      label: `${candidate.tagName}${candidate.publishedAt ? ` · ${formatDate(candidate.publishedAt)}` : ''}`,
      checked: candidate.tagName === release?.tagName,
      onSelect: () => {
        setSelected(summarizeRelease(candidate, 'all'))
        setVersionsOpen(false)
      },
    }))

  return (
    <div
      className="group relative flex h-full min-h-[124px] w-full flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 pr-9 text-left transition-[border-color,background-color] duration-[var(--dur-fast)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-raised)]"
    >
      <button
        type="button"
        onClick={onSelectRepo}
        aria-label={item.repo.fullName}
        className="absolute inset-0 rounded-[var(--r-md)] focus-visible:shadow-[var(--shadow-ring-focus)] focus-visible:outline-none"
      />
      <span className="flex items-start gap-2">
        <GithubAvatar src={item.repo.owner.avatarUrl} name={item.repo.owner.login} size={28} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[length:var(--text-12)] font-medium leading-tight text-[var(--text-primary)] group-hover:text-[var(--accent)]">{item.repo.fullName}</span>
          <span className="mt-1 line-clamp-2 min-h-[2.2em] text-[length:var(--text-11)] leading-snug text-[var(--text-tertiary)]">{item.repo.description || t('development.github.store.no_description')}</span>
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {release ? (
          <>
            <button
              ref={versionAnchor}
              type="button"
              onClick={() => setVersionsOpen(true)}
              aria-label={t('development.github.store.pick_version')}
              title={t('development.github.store.pick_version')}
              className="relative z-10 inline-flex items-center gap-0.5 rounded-full bg-[var(--bg-raised)] px-2 py-0.5 text-[length:var(--text-11)] font-medium tabular text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              {release.tagName}
              <ChevronDown size={10} />
            </button>
            <PlatformBadges platforms={release.platforms} />
            {asset
              ? <span className="inline-flex items-center gap-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]" title={asset.name}><Download size={9} />{assetFormat(asset.name)}</span>
              : <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('development.github.store.no_asset')}</span>}
          </>
        ) : <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('development.github.store.no_release')}</span>}
      </span>
      <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pr-6 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
        <span className="inline-flex items-center gap-1 tabular-nums"><Star size={10} />{formatNumber(item.repo.stargazersCount)}</span>
        {item.repo.language && <span>{item.repo.language}</span>}
        {release && release.downloadCount > 0 && <span className="inline-flex items-center gap-1 tabular-nums"><Download size={10} />{formatNumber(release.downloadCount)}</span>}
        {release && <span className="ml-auto tabular-nums">{formatDate(release.publishedAt)}</span>}
      </span>
      <IconButton
        label={favorited ? t('development.github.store.unfavorite') : t('development.github.store.favorite')}
        size="sm"
        className="absolute right-1.5 top-1.5 z-10 bg-[var(--bg-surface)]"
        onClick={() => onToggleFavorite()}
      >
        <Heart size={13} className={favorited ? 'fill-[var(--accent)] text-[var(--accent)]' : ''} />
      </IconButton>
      {asset && (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('development.github.store.download_asset', { name: asset.name })}
          title={t('development.github.store.download_asset', { name: asset.name })}
          className="absolute bottom-2 right-2 z-10 inline-flex h-6 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-1.5 text-[length:var(--text-10)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]"
        >
          <Download size={10} />
          {assetFormat(asset.name)}
        </a>
      )}
      <Menu anchor={versionAnchor} open={versionsOpen} onClose={() => setVersionsOpen(false)} items={items} align="end" width={220} label={t('development.github.store.pick_version')} />
    </div>
  )
}
