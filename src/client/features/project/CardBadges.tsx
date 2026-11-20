import type { ReactElement } from 'react'
import { CalendarDays, CheckSquare, FileText, Hash, Link2, ListTodo, Mail, MessageSquare, Phone, Type, User, Users, type LucideIcon } from 'lucide-react'
import type { ProjectCardBadges } from '@shared/project/badges'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone, PROJECT_PROPERTY_CAPABILITIES } from '@shared/project/model'
import { parseProjectDateValue, projectStampToDay } from '@shared/project/date'
import { projectPropertyDisplayText } from '@shared/project/view-eval'
import { hasProjectCardBadges } from '@shared/project/badges'
import { projectOptionCssColor } from '@shared/project/option-color'
import { t, useLocale } from '../../lib/i18n'
import { useProjectPeople } from './people-context'

import { TagPill } from '../../components/TagChip'

function startOfToday(): number {
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

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
        <span role="img" className="flex items-center gap-0.5" aria-label={t('project.card.badge_comments', { count: badges.comments })}>
          <MessageSquare size={13} aria-hidden="true" />{badges.comments}
        </span>
      )}
      {badges.checkboxes > 0 && (
        <span role="img" className="flex items-center gap-0.5" aria-label={t('project.card.badge_tasks', { checked: badges.checked, total: badges.checkboxes })}>
          <CheckSquare size={13} aria-hidden="true" />{badges.checked}/{badges.checkboxes}
        </span>
      )}
      {hasSubtasks && (
        <span role="img" className="flex items-center gap-0.5 text-[var(--accent)] font-medium" aria-label={t('project.card.subtask_progress')}>
          <ListTodo size={13} aria-hidden="true" />{subtaskDone}/{subtaskCount}
        </span>
      )}
    </span>
  )
}
export function optionDot(color: string): ReactElement {
  return <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: projectOptionCssColor(color) ?? 'var(--text-quaternary)' }} />
}

const PROPERTY_ICONS: Partial<Record<ProjectProperty['type'], LucideIcon>> = {
  date: CalendarDays,
  person: User,
  multiPerson: Users,
  number: Hash,
  url: Link2,
  email: Mail,
  phone: Phone,
  text: Type,
}

/** A date whose whole range has passed reads as overdue; an open-ended one is judged on its start. */
function isOverdue(card: ProjectCard, property: ProjectProperty, properties: readonly ProjectProperty[], todayStamp: number): boolean {
  const value = parseProjectDateValue(card.values[property.id] ?? '')
  if (value?.from === undefined) return false
  if (isProjectCardDone(card, properties)) return false
  return projectStampToDay(value.to ?? value.from, value.includeTime === true, value.timeZone).getTime() < todayStamp
}

/**
 * The row a board card wears under its title.
 *
 * A kanban card has to be readable without opening it, so the properties the view already shows are
 * repeated here as chips — the group's own property is left out because the column already says it.
 * Only set values are drawn: an empty chip per property would bury the title it is meant to support.
 */
export function CardPropertyChips({ card, properties, excludePropertyId, max = 4, todayStamp }: {
  card: ProjectCard
  properties: readonly ProjectProperty[]
  excludePropertyId?: string
  max?: number
  /** One midnight for the whole board, so a thousand chips do not each build a Date. */
  todayStamp?: number
}): ReactElement | null {
  const today = todayStamp ?? startOfToday()
  const people = useProjectPeople()
  const locale = useLocale()
  const shown = properties
    .filter((property) => property.id !== excludePropertyId && !PROJECT_PROPERTY_CAPABILITIES[property.type].readOnly && card.values[property.id])
    .slice(0, max)
  if (shown.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-card-properties={card.id}>
      {shown.map((property) => {
        if (property.type === 'select') return <OptionChip key={property.id} property={property} value={card.values[property.id]!} />
        const Icon = PROPERTY_ICONS[property.type] ?? Type
        const overdue = property.type === 'date' && isOverdue(card, property, properties, today)
        return (
          <span
            key={property.id}
            title={property.name}
            className={`inline-flex max-w-full items-center gap-1 rounded-[var(--r-sm)] px-1.5 py-0.5 text-[length:var(--text-11)] ${overdue ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : 'bg-[var(--bg-sunken)] text-[var(--text-secondary)]'}`}
          >
            <Icon size={11} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{projectPropertyDisplayText(card, property, people, locale)}</span>
            {overdue && <span className="sr-only"> {t('project.card.overdue')}</span>}
          </span>
        )
      })}
    </div>
  )
}
