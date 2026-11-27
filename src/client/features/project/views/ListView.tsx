/**
 * The list: the whole board as a dense, checkable outline.
 *
 * It is the view for working through a board rather than looking at it, so the round check is first,
 * the title is one line, and the properties trail behind it. A double click renames in place and a
 * click on the priority chip walks it to the next level — the two edits the reference's task list
 * lets you make without opening anything. Rows drag to reorder within their group.
 */
import { memo, useCallback, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { Check, ChevronDown, ChevronRight, CornerDownRight, List, Plus, Trash2 } from 'lucide-react'
import type { ProjectCard, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { projectCardColorResolver, projectOptionCssColor } from '@shared/project/option-color'
import { projectPriorityProperty } from '@shared/project/stats'
import { projectCardDays } from '@shared/project/timeline-layout'
import { groupProjectCards, projectGroupKeys, projectGroupLabel, projectKanbanDropOrder, projectPropertyDisplayText } from '@shared/project/view-eval'
import { t, useLocale } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Menu, type MenuItem } from '../../../components/overlay'
import { isImeComposing, isEnterKey } from '../../../lib/ime'
import { useEvent } from '../../../lib/hooks'
import { CardBadges, OptionChip } from '../CardBadges'
import { useProjectPeople } from '../people-context'
import { useToday } from '../use-today'
import { CardGrip, DropLine } from './card-face'
import { QuickAdd, ViewHead, ViewShell } from './shell'
import { useDragSort, type DragGeometry } from './use-drag-sort'
import { useVirtualList, VIRTUAL_LIST_THRESHOLD } from '../../list/virtual-list'

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
  onDragCards: (patches: { id: string, patch: Record<string, unknown> }[], cardOrder: string[]) => Promise<void>
  onAddCard: (title: string, optionId: string) => Promise<void>
}

interface ListVirtualItem {
  key: string
  kind: 'header' | 'card' | 'empty' | 'add'
  zone: string
  card?: ProjectCard
  index: number
  count?: number
}

interface ListVirtualGroup {
  key: string
  start: number
  end: number
}

interface ListRowApi {
  children: Map<string, ProjectCard[]>
  canEdit: boolean
  canMarkDone: boolean
  properties: ProjectProperty[]
  priorityProperty: ProjectProperty | null
  colorOf: (card: ProjectCard) => string
  dateProperty: ProjectProperty | undefined
  shown: ProjectProperty[]
  today: number
  people: ReturnType<typeof useProjectPeople>
  locale: string
  badgesFor: (cardId: string) => ProjectCardBadges
  onDragStart: (event: React.PointerEvent, id: string) => void
  onDragKey: (event: React.KeyboardEvent, id: string) => void
  keyboardDragId: string | null
  onCardContextMenu: (event: MouseEvent, card: ProjectCard) => void
  onToggleCardDone: (card: ProjectCard, done: boolean) => Promise<void>
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onOpenCard: (id: string) => void
  onAddSubtask: (parentId: string) => Promise<void>
  onDeleteCard: (id: string) => void
  onToggleExpanded: (cardId: string) => void
  onOpenRename: (card: ProjectCard) => void
  onRenameChange: (cardId: string, value: string) => void
  onRenameCommit: () => Promise<void>
  onRenameCancel: () => void
  onCyclePriority: (card: ProjectCard) => void
}

interface ListRowProps {
  card: ProjectCard
  child: boolean
  api: ListRowApi
  expanded: Set<string>
  renaming: { id: string, value: string } | null
  draggingId: string | null
}

const ListRow = memo(function ListRow({ card, child, api, expanded, renaming, draggingId }: ListRowProps): ReactElement {
  const subtasks = api.children.get(card.id) ?? []
  const isOpen = expanded.has(card.id)
  const isRenaming = renaming?.id === card.id
  const done = isProjectCardDone(card, api.properties)
  const doneCount = subtasks.filter((entry) => isProjectCardDone(entry, api.properties)).length
  const range = api.dateProperty ? projectCardDays(card, api.dateProperty.id) : null
  const overdue = Boolean(range && range.end < api.today && !done)
  return (
    <div>
      <div
        className="pv-list-row group"
        data-drag-item={child ? undefined : ''}
        data-drag-id={child ? undefined : card.id}
        data-project-card={card.id}
        data-child={child}
        data-done={done}
        data-dragging={draggingId === card.id}
        style={{ paddingLeft: child ? '36px' : undefined }}
        onContextMenu={(event) => api.onCardContextMenu(event, card)}
      >
        {!child && api.canEdit && <CardGrip label={t('project.view.drag_card', { title: card.title || t('project.board.untitled_card') })} onPointerDown={(event) => api.onDragStart(event, card.id)} onKeyDown={(event) => api.onDragKey(event, card.id)} dragging={api.keyboardDragId === card.id} />}
        {!child && subtasks.length > 0
          ? (
            <IconButton
              label={isOpen ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
              size="sm"
              aria-expanded={isOpen}
              onClick={() => api.onToggleExpanded(card.id)}
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
          disabled={!api.canEdit || !api.canMarkDone}
          title={api.canMarkDone ? undefined : t('project.card.no_done_field')}
          onClick={() => { void api.onToggleCardDone(card, !done) }}
        >
          {done && <Check size={11} aria-hidden="true" />}
        </button>
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: api.colorOf(card) }} aria-hidden="true" />
        {isRenaming
          ? (
            <Input
              className="pv-list-edit"
              autoFocus
              value={renaming?.value ?? ''}
              aria-label={t('project.view.rename_card')}
              onChange={(event) => api.onRenameChange(card.id, event.target.value)}
              onBlur={() => { void api.onRenameCommit() }}
              onKeyDown={(event) => {
                if (isEnterKey(event) && !isImeComposing(event)) { event.preventDefault(); void api.onRenameCommit() }
                else if (event.key === 'Escape' && !isImeComposing(event)) { event.preventDefault(); api.onRenameCancel() }
              }}
            />
          )
          : (
            <button
              type="button"
              className="pv-list-title"
              title={api.canEdit ? t('project.view.rename_hint') : undefined}
              onClick={() => api.onOpenCard(card.id)}
              onDoubleClick={() => { if (api.canEdit) api.onOpenRename(card) }}
              onKeyDown={(event) => {
                if (api.canEdit && event.key === 'F2') { event.preventDefault(); api.onOpenRename(card) }
                else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }))
                }
              }}
            >
              {card.icon && <span className="mr-1" aria-hidden="true">{card.icon}</span>}
              {card.title || t('project.board.untitled_card')}
            </button>
          )}
        <CardBadges badges={api.badgesFor(card.id)} subtaskCount={subtasks.length} subtaskDone={doneCount} />
        {api.shown.map((property) => {
          if (property.id === api.priorityProperty?.id && card.values[property.id]) {
            const option = property.options.find((entry) => entry.id === card.values[property.id])
            return (
              <button
                key={property.id}
                type="button"
                className="pv-prio"
                data-priority-cycle={card.id}
                disabled={!api.canEdit}
                title={t('project.view.cycle_priority')}
                style={{ '--pv-prio-color': projectOptionCssColor(option?.color ?? '') ?? 'var(--text-tertiary)' } as React.CSSProperties}
                onClick={() => api.onCyclePriority(card)}
              >
                {option?.value}
              </button>
            )
          }
          if (property.type === 'date' && range) {
            return (
              <span key={property.id} className="shrink-0 text-[length:var(--text-11)] tabular" data-overdue={overdue} title={overdue ? t('project.card.overdue') : undefined} style={{ color: overdue ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                {projectPropertyDisplayText(card, property, api.people, api.locale)}
                {overdue && <span className="sr-only"> {t('project.card.overdue')}</span>}
              </span>
            )
          }
          return (
            <span key={property.id} className="hidden shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)] sm:inline">
              {property.type === 'select' && card.values[property.id]
                ? <OptionChip property={property} value={card.values[property.id]!} />
                : projectPropertyDisplayText(card, property, api.people, api.locale)}
            </span>
          )
        })}
        {api.canEdit && (
          <>
            <IconButton label={t('project.card.add_subtask')} size="sm" className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" data-touch-reveal="" onClick={() => { void api.onAddSubtask(card.id) }}>
              <Plus size={13} />
            </IconButton>
            <IconButton label={t('project.board.delete_card')} size="sm" className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" data-touch-reveal="" onClick={() => api.onDeleteCard(card.id)}>
              <Trash2 size={13} />
            </IconButton>
          </>
        )}
      </div>
      {isOpen && subtasks.map((subtask) => <ListRow key={subtask.id} card={subtask} child api={api} expanded={expanded} renaming={renaming} draggingId={draggingId} />)}
    </div>
  )
}, (prev, next) => (
  prev.card === next.card
  && prev.child === next.child
  && prev.api === next.api
  && prev.expanded.has(prev.card.id) === next.expanded.has(next.card.id)
  && (prev.draggingId === prev.card.id) === (next.draggingId === next.card.id)
  && (prev.renaming?.id === prev.card.id) === (next.renaming?.id === next.card.id)
  && (next.renaming?.id !== next.card.id || prev.renaming?.value === next.renaming?.value)
))

export function ListView(props: ListProps): ReactElement {
  const { cards, properties, fields, canEdit, canMarkDone = true } = props
  const people = useProjectPeople()
  const locale = useLocale()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [renaming, setRenaming] = useState<{ id: string, value: string } | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const columnsAnchor = useRef<HTMLButtonElement>(null)
  const today = useToday()
  const priorityProperty = useMemo(() => projectPriorityProperty(properties), [properties])
  const colorOf = useMemo(() => projectCardColorResolver(properties), [properties])
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
  const roots = useMemo(() => cards.filter((card) => !card.parentId || !ids.has(card.parentId)), [cards, ids])
  const groupProperty = properties.find((property) => property.id === fields.groupById)
  const groups = useMemo(() => groupProjectCards(roots, fields.groupById, properties), [roots, fields.groupById, properties])
  const entries = useMemo<[string, ProjectCard[]][]>(() => groupProperty
    ? projectGroupKeys(roots, fields.groupById, properties).map((key) => [key, groups.get(key) ?? []])
    : [...groups.entries()], [groupProperty, groups, roots, fields.groupById, properties])
  const { items: virtualItems, groups: virtualGroups } = useMemo(() => {
    const items: ListVirtualItem[] = []
    const groups: ListVirtualGroup[] = []
    for (const [key, list] of entries) {
      const start = items.length
      if (fields.groupById) items.push({ key: `${key}:header`, kind: 'header', zone: key, index: 0, count: list.length })
      for (const [index, card] of list.entries()) items.push({ key: card.id, kind: 'card', zone: key, card, index })
      if (!list.length) items.push({ key: `${key}:empty`, kind: 'empty', zone: key, index: 0 })
      if (canEdit) items.push({ key: `${key}:add`, kind: 'add', zone: key, index: list.length })
      groups.push({ key, start, end: items.length })
    }
    return { items, groups }
  }, [entries, fields.groupById, canEdit])
  const virtualized = virtualItems.length > VIRTUAL_LIST_THRESHOLD
  const estimateRow = useCallback((index: number): number => {
    const kind = virtualItems[index]?.kind
    return kind === 'header' ? 36 : kind === 'add' ? 52 : kind === 'empty' ? 64 : 56
  }, [virtualItems])
  const virtualResetKey = `${fields.groupById}:${entries.map(([key, list]) => `${key}:${list.length}`).join('|')}`
  const virtual = useVirtualList(virtualized ? virtualItems.length : 0, estimateRow, virtualized ? virtualResetKey : 'list')
  const dragGeometry = useCallback((): DragGeometry => {
    const root = virtual.containerRef.current
    if (!root) return { zones: [], items: new Map(), viewport: true }
    const rect = root.getBoundingClientRect()
    const zones = virtualGroups.map((group) => ({
      key: group.key,
      left: rect.left,
      right: rect.right,
      top: rect.top + (virtual.offsets[group.start] ?? 0) - root.scrollTop,
      bottom: rect.top + (virtual.offsets[group.end] ?? 0) - root.scrollTop,
    }))
    const items = new Map<string, { id: string, top: number, height: number }[]>()
    for (const group of virtualGroups) {
      const entriesForGroup: { id: string, top: number, height: number }[] = []
      for (let index = group.start; index < group.end; index += 1) {
        const item = virtualItems[index]
        if (item?.kind !== 'card' || !item.card) continue
        entriesForGroup.push({
          id: item.card.id,
          top: rect.top + (virtual.offsets[index] ?? 0) - root.scrollTop,
          height: (virtual.offsets[index + 1] ?? 0) - (virtual.offsets[index] ?? 0),
        })
      }
      items.set(group.key, entriesForGroup)
    }
    return { zones, items, viewport: true }
  }, [virtual.containerRef, virtual.offsets, virtualGroups, virtualItems])

  const drag = useDragSort({
    enabled: canEdit,
    geometry: virtualized ? dragGeometry : undefined,
    onDrop: (cardId, target) => {
      const cardOrder = projectKanbanDropOrder({
        columns: entries.map(([key, list]) => ({ key, cardIds: list.map((card) => card.id) })),
        cardOrder: fields.cardOrder,
        draggedIds: [cardId],
        target,
      })
      const card = cards.find((entry) => entry.id === cardId)
      const patches = groupProperty && card && (card.values[groupProperty.id] ?? '') !== target.zone
        ? [{ id: cardId, patch: { values: { [groupProperty.id]: target.zone === '' ? null : target.zone } } }]
        : []
      void props.onDragCards(patches, cardOrder)
    },
  })

  const commitRename = useEvent(async (): Promise<void> => {
    const current = renaming
    setRenaming(null)
    if (!current) return
    const value = current.value.trim()
    if (!value) return
    await props.onPatchCard(current.id, { title: value })
  })

  /** The reference walks low → medium → high → low on a click; here it walks the option order. */
  const cyclePriority = useEvent((card: ProjectCard): void => {
    if (!priorityProperty || priorityProperty.options.length === 0) return
    const at = priorityProperty.options.findIndex((option) => option.id === card.values[priorityProperty.id])
    const next = priorityProperty.options[(at + 1) % priorityProperty.options.length]!
    void props.onPatchCard(card.id, { values: { [priorityProperty.id]: next.id } })
  })
  const toggleExpanded = useEvent((cardId: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  })
  const openRename = useEvent((card: ProjectCard) => setRenaming({ id: card.id, value: card.title }))
  const changeRename = useEvent((cardId: string, value: string) => setRenaming({ id: cardId, value }))
  const cancelRename = useEvent(() => setRenaming(null))
  const rowApi = useMemo<ListRowApi>(() => ({
    children, canEdit, canMarkDone, properties, priorityProperty, colorOf, dateProperty, shown, today, people, locale,
    badgesFor: props.badgesFor,
    onDragStart: drag.start,
    onDragKey: drag.onKeyDown,
    keyboardDragId: drag.keyboardDragId,
    onCardContextMenu: props.onCardContextMenu,
    onToggleCardDone: props.onToggleCardDone,
    onPatchCard: props.onPatchCard,
    onOpenCard: props.onOpenCard,
    onAddSubtask: props.onAddSubtask,
    onDeleteCard: props.onDeleteCard,
    onToggleExpanded: toggleExpanded,
    onOpenRename: openRename,
    onRenameChange: changeRename,
    onRenameCommit: commitRename,
    onRenameCancel: cancelRename,
    onCyclePriority: cyclePriority,
  }), [children, canEdit, canMarkDone, properties, priorityProperty, colorOf, dateProperty, shown, today, people, locale, props.badgesFor, drag.start, drag.onKeyDown, drag.keyboardDragId, props.onCardContextMenu, props.onToggleCardDone, props.onPatchCard, props.onOpenCard, props.onAddSubtask, props.onDeleteCard, toggleExpanded, openRename, changeRename, commitRename, cancelRename, cyclePriority])

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

  const renderVirtualItem = (item: ListVirtualItem): ReactElement => {
    if (item.kind === 'header') return (
      <h3 className="pv-list-group">
        {groupProperty && item.zone !== '' && (groupProperty.type === 'select' || groupProperty.type === 'multiSelect')
          ? <OptionChip property={groupProperty} value={item.zone} />
          : <span>{item.zone === '' ? t('project.view.no_value') : projectGroupLabel(groupProperty, item.zone, people, locale)}</span>}
        <span className="pv-head-count">{item.count}</span>
      </h3>
    )
    if (item.kind === 'empty') return (
      <>
        <DropLine store={drag.overStore} zone={item.zone} index={0} />
        <p className="px-3 py-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.view.empty_column')}</p>
      </>
    )
    if (item.kind === 'add') return (
      <div className="px-3 py-1">
        <QuickAdd label={t('project.view.add_row')} onAdd={(title) => props.onAddCard(title, item.zone)} />
      </div>
    )
    return (
      <>
        <ListRow card={item.card!} child={false} api={rowApi} expanded={expanded} renaming={renaming} draggingId={drag.draggingId} />
        <DropLine store={drag.overStore} zone={item.zone} index={item.index + 1} />
      </>
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
      <div ref={virtual.containerRef} className="pv-list pv-scroll" data-drag-root="" data-list="">
        {virtualized ? (
          <div className="relative" style={{ height: virtual.total }}>
            {virtualGroups.filter((group) => group.end > virtual.start && group.start < virtual.end).map((group) => (
              <section
                key={group.key || 'all'}
                data-drag-zone={group.key}
                className="absolute inset-x-0"
                style={{ top: virtual.offsets[group.start], height: (virtual.offsets[group.end] ?? 0) - (virtual.offsets[group.start] ?? 0) }}
              >
                {virtualItems.slice(Math.max(group.start, virtual.start), Math.min(group.end, virtual.end)).map((item, sliceIndex) => {
                  const index = Math.max(group.start, virtual.start) + sliceIndex
                  return (
                    <div
                      key={item.key}
                      data-virtual-index={index}
                      className="absolute inset-x-0"
                      style={{ top: (virtual.offsets[index] ?? 0) - (virtual.offsets[group.start] ?? 0) }}
                    >
                      {renderVirtualItem(item)}
                    </div>
                  )
                })}
              </section>
            ))}
          </div>
        ) : entries.map(([key, list]) => (
          <section key={key || 'all'} data-drag-zone={key}>
            {fields.groupById && (
              <h3 className="pv-list-group">
                {groupProperty && key !== '' && (groupProperty.type === 'select' || groupProperty.type === 'multiSelect')
                  ? <OptionChip property={groupProperty} value={key} />
                  : <span>{key === '' ? t('project.view.no_value') : projectGroupLabel(groupProperty, key, people, locale)}</span>}
                <span className="pv-head-count">{list.length}</span>
              </h3>
            )}
            <DropLine store={drag.overStore} zone={key} index={0} />
            {list.map((card, index) => (
              <div key={card.id} className="contents">
                <ListRow card={card} child={false} api={rowApi} expanded={expanded} renaming={renaming} draggingId={drag.draggingId} />
                <DropLine store={drag.overStore} zone={key} index={index + 1} />
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
