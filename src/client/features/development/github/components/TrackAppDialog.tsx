import { useEffect, useState } from 'react'
import type { GithubAssetPlatform, GithubRelease, GithubRepo } from '@shared/development/github/types'
import { GITHUB_ASSET_PLATFORMS, assetPlatform } from '@shared/development/github/platforms'
import { t } from '../../../../lib/i18n'
import { Badge, Button } from '../../../../components/primitives'
import { Field, Input, Segmented } from '../../../../components/form'
import { Modal } from '../../../../components/overlay'
import { GithubAvatar } from './GithubAvatar'
import { platformLabel } from './StoreSidebar'

export interface TrackAppValues {
  platform: GithubAssetPlatform
  assetPattern: string
  installedTag: string
}

function defaultPlatform(release: GithubRelease | null, fallback?: GithubAssetPlatform): GithubAssetPlatform {
  const recommended = release?.assets.find((asset) => assetPlatform(asset.name) !== null) ?? release?.assets[0]
  return (recommended ? assetPlatform(recommended.name) : null) ?? fallback ?? 'windows'
}

export function TrackAppDialog({
  open,
  repo,
  release,
  initialPlatform,
  initialTag,
  onClose,
  onSubmit,
}: {
  open: boolean
  repo: GithubRepo | null
  release: GithubRelease | null
  initialPlatform?: GithubAssetPlatform
  initialTag?: string
  onClose: () => void
  onSubmit: (values: TrackAppValues) => void
}) {
  const [platform, setPlatform] = useState<GithubAssetPlatform>(() => defaultPlatform(release, initialPlatform))
  const [pattern, setPattern] = useState('')
  const [installedTag, setInstalledTag] = useState(release?.tagName ?? initialTag ?? '')

  useEffect(() => {
    if (!open) return
    setPlatform(defaultPlatform(release, initialPlatform))
    setPattern('')
    setInstalledTag(release?.tagName ?? initialTag ?? '')
  }, [open, release, initialPlatform, initialTag, repo?.id])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('development.github.apps.track_title')}
      description={t('development.github.apps.track_desc')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => onSubmit({ platform, assetPattern: pattern, installedTag })}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5">
          <GithubAvatar src={repo?.owner.avatarUrl ?? ''} name={repo?.owner.login ?? ''} size={28} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{repo?.fullName}</p>
            <p className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('development.github.apps.track_hint')}</p>
          </div>
          {release ? <Badge tone="neutral">{release.tagName}</Badge> : <Badge tone="neutral">{t('development.github.store.no_release')}</Badge>}
        </div>
        <Field label={t('development.github.apps.platform')}>
          <Segmented
            value={platform}
            onChange={setPlatform}
            label={t('development.github.apps.platform')}
            options={GITHUB_ASSET_PLATFORMS.map((value) => ({ value, label: platformLabel(value) }))}
          />
        </Field>
        <Field label={t('development.github.apps.installed_tag')} hint={t('development.github.apps.installed_tag_hint')}>
          <Input value={installedTag} onChange={(event) => setInstalledTag(event.target.value)} placeholder={release?.tagName ?? 'v1.0.0'} maxLength={100} />
        </Field>
        <Field label={t('development.github.apps.asset_pattern')} hint={t('development.github.apps.asset_pattern_hint')}>
          <Input value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder={t('development.github.apps.asset_pattern_placeholder')} maxLength={200} />
        </Field>
      </div>
    </Modal>
  )
}
