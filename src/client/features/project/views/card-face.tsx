/**
 * What a card looks like on a surface: cover, title, the properties the view chose to show, its
 * badges and its subtask progress. The board, the list and the day panel all draw the same face, so
 * a card is recognisable when the reader moves between them.
 */
import type { ReactElement, ReactNode } from 'react'
import { GripVertical, ListTodo, Pin, Plus, Star, Trash2 } from 'lucide-react'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { t } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { Checkbox } from '../../../components/form'
import { CardBadges, CardPropertyChips } from '../CardBadges'

export function CardFace({ card, color, cover, chipProperties, excludePropertyId, badges, density, description, rich = false, starred, pinned, children }: {
  card: ProjectCard
  color: string
  cover?: string | null
  chipProperties: readonly ProjectProperty[]
  excludePropertyId?: string
  badges: ProjectCardBadges
  density: 'compact' | 'comfortable' | 'spacious'
  description?: string
  rich?: boolean
  starred?: boolean
  pinned?: boolean
  children?: ReactNode
}): ReactElement {
  return (
    <>
      {cover && density !== 'compact' && <img src={cover} alt="" className="pv-card-cover" loading="lazy" />}
      <div className="pv-card-row">
        <span className="pv-card-dot" style={{ '--pv-card-color': color } as React.CSSProperties} aria-hidden="true" />
        {children}
      </div>
      {rich && description && <p className="pv-card-desc">{description}</p>}
      {density !== 'compact' && (
        <CardPropertyChips card={card} properties={chipProperties} excludePropertyId={excludePropertyId} max={rich ? 8 : 4} />
      )}
      <span className="flex items-center gap-1.5">
        <CardBadges badges={badges} />
        {pinned && <Pin size={11} role="img" aria-label={t('project.card.pin')} className="shrink-0 text-[var(--accent)]" />}
        {starred && <Star size={11} role="img" aria-label={t('project.card.favorite')} className="shrink-0 fill-[var(--warning)] text-[var(--warning)]" />}
      </span>
    </>
  )
}

export function CardGrip({ label, onPointerDown }: {
  label: string
  onPointerDown: (event: React.PointerEvent) => void
}): ReactElement {
  return (
    <button
      type="button"
      className="pv-card-grip"
      aria-label={label}
      data-drag-handle=""
      onPointerDown={onPointerDown}
      onClick={(event) => event.preventDefault()}
    >
      <GripVertical size={13} aria-hidden="true" />
    </button>
  )
}

export function SubtaskProgress({ done, total, color }: { done: number, total: number, color: string }): ReactElement {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="flex items-center gap-1.5" data-subtask-progress={`${done}/${total}`}>
      <ListTodo size={11} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
      <span
        className="pv-progress min-w-0 flex-1"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${done}/${total}`}
        aria-label={t('project.card.subtask_progress')}
      >
        <span className="pv-progress-fill" style={{ width: `${percent}%`, '--pv-card-color': color } as React.CSSProperties} />
      </span>
      <span className="shrink-0 text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">{done}/{total}</span>
    </div>
  )
}

export function SubtaskRows({ parentId, subtasks, properties, canEdit, onOpenCard, onToggleDone, onDelete, onAddSubtask, colorOf }: {
  parentId: string
  subtasks: readonly ProjectCard[]
  properties: readonly ProjectProperty[]
  canEdit: boolean
  onOpenCard: (id: string) => void
  onToggleDone: (card: ProjectCard, done: boolean) => void
  onDelete: (id: string) => void
  onAddSubtask?: (parentId: string) => Promise<void>
  colorOf: (card: ProjectCard) => string
}): ReactElement {
  return (
    <div className="mt-1 flex flex-col gap-1 border-l-2 border-[var(--border-subtle)] pl-2" data-subtasks={parentId}>
      {subtasks.map((subtask) => {
        const done = isProjectCardDone(subtask, properties)
        return (
          <div key={subtask.id} className="flex items-center gap-1.5" data-project-card={subtask.id}>
            <Checkbox
              ariaLabel={subtask.title || t('project.board.untitled_card')}
              checked={done}
              disabled={!canEdit}
              onChange={(checked) => onToggleDone(subtask, checked)}
            />
            <button
              type="button"
              className={`min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${done ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)] hover:text-[var(--accent)]'}`}
              style={{ borderLeft: `2px solid ${colorOf(subtask)}`, paddingLeft: '6px' }}
              onClick={() => onOpenCard(subtask.id)}
            >
              {subtask.title || t('project.board.untitled_card')}
            </button>
            {canEdit && (
              <IconButton label={t('project.board.delete_card')} size="sm" onClick={() => onDelete(subtask.id)}>
                <Trash2 size={12} />
              </IconButton>
            )}
          </div>
        )
      })}
      {canEdit && onAddSubtask && (
        <button
          type="button"
          className="flex items-center gap-1 self-start rounded-[var(--r-xs)] px-1 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          onClick={() => { void onAddSubtask(parentId) }}
        >
          <Plus size={11} aria-hidden="true" />
          {t('project.card.add_subtask')}
        </button>
      )}
    </div>
  )
}