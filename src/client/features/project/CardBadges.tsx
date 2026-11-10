import type { ReactElement } from 'react'
import { CheckSquare, FileText, ListTodo, MessageSquare } from 'lucide-react'
import type { ProjectCardBadges } from '@shared/project/badges'
import type { ProjectProperty } from '@shared/project/model'
import { hasProjectCardBadges } from '@shared/project/badges'
import { projectOptionCssColor } from '@shared/project/option-color'
import { t } from '../../lib/i18n'

import { TagPill } from '../../components/TagChip'

export function OptionChip({ property, value }: { property: ProjectProperty, value: string }): ReactElement | null {
  const option = property.options.find((entry) => entry.id === value)
  if (!option) return null
  const parts = option.value.split('/').map((s) => s.trim()).filter(Boolean)
  const isHierarchy = parts.length > 1
  return (
    <TagPill
      tone="tinted"
      color={projectOptionCssColor(option.color)}
      label={
        isHierarchy ? (
          <>
            <span className="opacity-70">{parts.slice(0, -1).join(' / ')} / </span>
            <span className="font-semibold">{parts[parts.length - 1]}</span>
          </>
        ) : option.value
      }
    />
  )
}

export function CardBadges({ badges, subtaskCount = 0, subtaskDone = 0 }: { badges: ProjectCardBadges, subtaskCount?: number, subtaskDone?: number }): ReactElement | null {
  const hasSubtasks = subtaskCount > 0
  if (!hasProjectCardBadges(badges) && !hasSubtasks) return null
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
      {hasSubtasks && (
        <span className="flex items-center gap-0.5 text-[var(--accent)] font-medium" aria-label={t('project.card.subtask_progress')}>
          <ListTodo size={13} aria-hidden="true" />{subtaskDone}/{subtaskCount}
        </span>
      )}
    </span>
  )
}