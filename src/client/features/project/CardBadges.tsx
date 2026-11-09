import type { ReactElement } from 'react'
import { CheckSquare, FileText, MessageSquare } from 'lucide-react'
import type { ProjectCardBadges } from '@shared/project/badges'
import { hasProjectCardBadges } from '@shared/project/badges'
import { t } from '../../lib/i18n'

export function CardBadges({ badges }: { badges: ProjectCardBadges }): ReactElement | null {
  if (!hasProjectCardBadges(badges)) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
      {badges.description && (
        <FileText size={13} role="img" aria-label={t('project.card.badge_description')} />
      )}
      {badges.comments > 0 && (
        <span className="flex items-center gap-0.5" aria-label={t('project.card.badge_comments', { count: badges.comments })}>
          <MessageSquare size={13} aria-hidden="true" />{badges.comments}
        </span>
      )}
      {badges.checkboxes > 0 && (
        <span className="flex items-center gap-0.5" aria-label={t('project.card.badge_tasks', { checked: badges.checked, total: badges.checkboxes })}>
          <CheckSquare size={13} aria-hidden="true" />{badges.checked}/{badges.checkboxes}
        </span>
      )}
    </span>
  )
}