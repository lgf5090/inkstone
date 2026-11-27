import { Cloud, HardDriveDownload, History, Share2 } from 'lucide-react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { t } from '../../../lib/i18n'
import { Badge } from '../../../components/primitives'
import type { EntryIndicators } from './types'

export function EntryBadges({
  entry,
  indicators,
  className = '',
}: {
  entry: CloudDriveEntry
  indicators?: EntryIndicators
  className?: string
}) {
  const versions = indicators?.versionCounts[entry.id] ?? 0
  const source = entry.storageKind === 'external'
    ? t('clouddrive.badge.source_external')
    : entry.storageKind === 'distributed'
      ? t('clouddrive.badge.source_distributed')
      : null
  const shared = indicators?.sharedIds.has(entry.id) ?? false
  const offline = indicators?.offlineIds.has(entry.id) ?? false

  if (!source && !shared && !offline && versions === 0) return null

  return (
    <span className={`cd-entry-badges ${className}`.trim()}>
      {source && (
        <Badge tone="neutral" className="cd-entry-badge">
          <Cloud size={11} aria-hidden="true" />
          <span>{source}</span>
        </Badge>
      )}
      {shared && (
        <Badge tone="accent" className="cd-entry-badge">
          <Share2 size={11} aria-hidden="true" />
          <span>{t('clouddrive.badge.shared')}</span>
        </Badge>
      )}
      {offline && (
        <Badge tone="success" className="cd-entry-badge">
          <HardDriveDownload size={11} aria-hidden="true" />
          <span>{t('clouddrive.badge.offline')}</span>
        </Badge>
      )}
      {versions > 0 && (
        <Badge tone="warning" className="cd-entry-badge">
          <History size={11} aria-hidden="true" />
          <span>{t('clouddrive.badge.versions', { count: versions })}</span>
        </Badge>
      )}
    </span>
  )
}
