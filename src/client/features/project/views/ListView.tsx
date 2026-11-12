/**
 * The list: the whole board as a dense, checkable outline.
 *
 * It is the view for working through a board rather than looking at it, so the round check is first,
 * the title is one line, and the properties trail behind it. A double click renames in place and a
 * click on the priority chip walks it to the next level — the two edits the reference's task list
 * lets you make without opening anything. Rows drag to reorder within their group.
 */
import { useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { Check, ChevronDown, ChevronRight, CornerDownRight, List, Plus, Trash2 } from 'lucide-react'
import type { ProjectCard, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { projectCardColor, projectOptionCssColor } from '@shared/project/option-color'
import { projectPriorityProperty } from '@shared/project/stats'
import { projectCardDays } from '@shared/project/timeline-layout'
import { groupProjectCards, projectKanbanDropOrder, projectOptionLabel, projectPropertyDisplayText } from '@shared/project/view-eval'
import { t } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { Menu, type MenuItem } from '../../../components/overlay'
import { isImeComposing } from '../../../lib/ime'
import { CardBadges, OptionChip } from '../CardBadges'
import { CardGrip } from './card-face'
import { QuickAdd, ViewHead, ViewShell } from './shell'
import { useDragSort } from './use-drag-sort'

export interface ListProps {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  fields: ProjectViewFields
  canEdit: boolean
  canMarkDone?: boolean
  badgesFor: (cardId: string) => ProjectCardBadges
  onOpenCard: (id: string) => void
  onCardContextMenu: (event: MouseEvent, card: ProjectCard) => void
  onAddSubtask: (parentId: string) => Promise<void>
  onToggleCardDone: (card: ProjectCard, done: boolean) => Promise<void>
  onDeleteCard: (id: string) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onPatchFields: (fields: Partial<ProjectViewFields>) => void
  onAddCard: (title: string, optionId: string) => Promise<void>
}

export function ListView(props: ListProps): ReactElement {
  const { cards, properties, fields, canEdit, canMarkDone = true } = props
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [renaming, setRenaming] = useState<{ id: string, value: string } | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const columnsAnchor = useRef<HTMLButtonElement>(null)
  const today = useMemo(() => { const day = new Date(); day.setHours(0, 0, 0, 0); return day.getTime() }, [])
  const priorityProperty = useMemo(() => projectPriorityProperty(properties), [properties])
  const dateProperty = useMemo(() => properties.find((property) => property.type === 'date'), [properties])
  const shown = useMemo(() => {
    const picked = fields.visiblePropertyIds.map((id) => properties.find((property) => property.id === id)).filter((property): property is ProjectProperty => Boolean(property))
    return picked.length > 0 ? picked : properties.slice(0, 3)
  }, [fields.visiblePropertyIds, properties])

  const ids = useMemo(() => new Set(cards.map((card) => card.id)), [cards])
  const children = useMemo(() => {
    const map = new Map<string, ProjectCard[]>()
    for (const card of cards) {
      if (!card.parentId || !ids.has(card.parentId)) continue
      const list = map.get(card.parentId)
      if (list) list.push(card)
      else map.set(card.parentId, [card])
    }
    return map
  }, [cards, ids])
  const roots = cards.filter((card) => !card.parentId || !ids.has(card.parentId))
  const groupProperty = properties.find((property) => property.id === fields.groupById)
  const groups = groupProjectCards(roots, fields.groupById, properties)
  const entries: [string, ProjectCard[]][] = groupProperty
    ? [...groupProperty.options.map((option) => option.id), ''].map((key) => [key, groups.get(key) ?? []])
    : [...groups.entries()]

  const drag = useDragSort({
    enabled: canEdit,
    onDrop: (cardId, target) => {
      props.onPatchFields({
        cardOrder: projectKanbanDropOrder({
          columns: entries.map(([key, list]) => ({ key, cardIds: list.map((card) => card.id) })),
          cardOrder: fields.cardOrder,
          draggedId: cardId,
          target,
        }),
      })
      if (groupProperty) {
        const card = cards.find((entry) => entry.id === cardId)
        if (card && (card.values[groupProperty.id] ?? '') !== target.zone) {
          void props.onPatchCard(cardId, { values: { [groupProperty.id]: target.zone === '' ? null : target.zone } })
        }
      }
    },
  })

  const commitRename = async (): Promise<void> => {
    const current = renaming
    setRenaming(null)
    if (!current) return
    const value = current.value.trim()
    if (!value) return
    await props.onPatchCard(current.id, { title: value })
  }

  /** The reference walks low → medium → high → low on a click; here it walks the option order. */
  const cyclePriority = (card: ProjectCard): void => {
    if (!priorityProperty || priorityProperty.options.length === 0) return
    const at = priorityProperty.options.findIndex((option) => option.id === card.values[priorityProperty.id])
    const next = priorityProperty.options[(at + 1) % priorityProperty.options.length]!
    void props.onPatchCard(card.id, { values: { [priorityProperty.id]: next.id } })
  }

  const columnItems: MenuItem[] = properties.map((property) => ({
    id: property.id,
    label: property.name,
    checked: shown.some((entry) => entry.id === property.id),
    onSelect: () => {
      const current = shown.map((entry) => entry.id)
      const next = current.includes(property.id) ? current.filter((id) => id !== property.id) : [...current, property.id]
      props.onPatchFields({ visiblePropertyIds: next })
    },
  }))

  const renderRow = (card: ProjectCard, child: boolean): ReactElement => {
    const subtasks = children.get(card.id) ?? []
    const isOpen = expanded.has(card.id)
    const done = isProjectCardDone(card, properties)
    const doneCount = subtasks.filter((entry) => isProjectCardDone(entry, properties)).length
    const range = dateProperty ? projectCardDays(card, dateProperty.id) : null
    const overdue = Boolean(range && range.end < today && !done)
    return (
      <div key={card.id}>
        <div
          className="pv-list-row group"
          data-drag-item=""
          data-drag-id={card.id}
          data-project-card={card.id}
          data-child={child}
          data-done={done}
          data-dragging={drag.draggingId === card.id}
          style={{ paddingLeft: child ? '36px' : undefined }}
          onContextMenu={(event) => props.onCardContextMenu(event, card)}
        >
          {canEdit && <CardGrip label={t('project.view.drag_card', { title: card.title || t('project.board.untitled_card') })} onPointerDown={(event) => drag.start(event, card.id)} />}
          {!child && subtasks.length > 0
            ? (
              <IconButton
                label={isOpen ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
                size="sm"
                aria-expanded={isOpen}
                onClick={() => setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(card.id)) next.delete(card.id)
                  else next.add(card.id)
                  return next
                })}
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </IconButton>
            )
            : child
              ? <CornerDownRight size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
              : <span className="size-6 shrink-0" aria-hidden="true" />}
          <button
            type="button"
            className="pv-check"
            role="checkbox"
            aria-checked={done}
            aria-label={card.title || t('project.board.untitled_card')}
            disabled={!canEdit || !canMarkDone}
            title={canMarkDone ? undefined : t('project.card.no_done_field')}
            onClick={() => { void props.onToggleCardDone(card, !done) }}
          >
            {done && <Check size={11} aria-hidden="true" />}
          </button>
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: projectCardColor(card, properties) }} aria-hidden="true" />
          {renaming?.id === card.id
            ? (
              <input
                className="pv-list-edit"
                autoFocus
                value={renaming.value}
                aria-label={t('project.view.rename_card')}
                onChange={(event) => setRenaming({ id: card.id, value: event.target.value })}
                onBlur={() => { void commitRename() }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isImeComposing(event)) { event.preventDefault(); void commitRename() }
                  else if (event.key === 'Escape' && !isImeComposing(event)) { event.preventDefault(); setRenaming(null) }
                }}
              />
            )
            : (
              <button
                type="button"
                className="pv-list-title"
                onClick={() => props.onOpenCard(card.id)}
                onDoubleClick={() => { if (canEdit) setRenaming({ id: card.id, value: card.title }) }}
              >
                {card.icon && <span className="mr-1" aria-hidden="true">{card.icon}</span>}
                {card.title || t('project.board.untitled_card')}
              </button>
            )}
          <CardBadges badges={props.badgesFor(card.id)} subtaskCount={subtasks.length} subtaskDone={doneCount} />
          {shown.map((property) => {
            if (property.id === priorityProperty?.id && card.values[property.id]) {
              const option = property.options.find((entry) => entry.id === card.values[property.id])
              return (
                <button
                  key={property.id}
                  type="button"
                  className="pv-prio"
                  data-priority-cycle={card.id}
                  disabled={!canEdit}
                  title={t('project.view.cycle_priority')}
                  style={{ '--pv-prio-color': projectOptionCssColor(option?.color ?? '') ?? 'var(--text-tertiary)' } as React.CSSProperties}
                  onClick={() => cyclePriority(card)}
                >
                  {option?.value}
                </button>
              )
            }
            if (property.type === 'date' && range) {
              return (
                <span key={property.id} className="shrink-0 text-[length:var(--text-11)] tabular" data-overdue={overdue} style={{ color: overdue ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                  {projectPropertyDisplayText(card, property)}
                </span>
              )
            }
            return (
              <span key={property.id} className="hidden shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)] sm:inline">
                {property.type === 'select' && card.values[property.id]
                  ? <OptionChip property={property} value={card.values[property.id]!} />
                  : projectPropertyDisplayText(card, property)}
              </span>
            )
          })}
          {canEdit && (
            <>
              <IconButton label={t('project.card.add_subtask')} size="sm" className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" onClick={() => { void props.onAddSubtask(card.id) }}>
                <Plus size={13} />
              </IconButton>
              <IconButton label={t('project.board.delete_card')} size="sm" className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" onClick={() => props.onDeleteCard(card.id)}>
                <Trash2 size={13} />
              </IconButton>
            </>
          )}
        </div>
        {isOpen && subtasks.map((subtask) => renderRow(subtask, true))}
      </div>
    )
  }

  return (
    <ViewShell data-view="list">
      <ViewHead icon={<List size={15} aria-hidden="true" />} title={t('project.view.list')} count={cards.length}>
        <IconButton ref={columnsAnchor} label={t('project.view.list_columns')} size="sm" onClick={() => setColumnsOpen(true)}>
          <Plus size={15} />
        </IconButton>
        <Menu anchor={columnsAnchor} open={columnsOpen} onClose={() => setColumnsOpen(false)} items={columnItems} align="end" label={t('project.view.list_columns')} />
      </ViewHead>
      <div className="pv-list pv-scroll" data-drag-root="" data-list="">
        {entries.map(([key, list]) => (
          <section key={key || 'all'} data-drag-zone={key}>
            {fields.groupById && (
              <h3 className="pv-list-group">
                {groupProperty && key !== '' ? <OptionChip property={groupProperty} value={key} /> : <span>{key === '' ? t('project.view.no_value') : projectOptionLabel(groupProperty!, key)}</span>}
                <span className="pv-head-count">{list.length}</span>
              </h3>
            )}
            {drag.over?.zone === key && drag.over.index === 0 && <div className="pv-drop-line" data-drop-line={key} />}
            {list.map((card, index) => (
              <div key={card.id} className="contents">
                {renderRow(card, false)}
                {drag.over?.zone === key && drag.over.index === index + 1 && <div className="pv-drop-line" data-drop-line={key} />}
              </div>
            ))}
            {list.length === 0 && <p className="px-3 py-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.view.empty_column')}</p>}
            {canEdit && (
              <div className="px-3 py-1">
                <QuickAdd label={t('project.view.add_row')} onAdd={(title) => props.onAddCard(title, key)} />
              </div>
            )}
          </section>
        ))}
      </div>
    </ViewShell>
  )
}
