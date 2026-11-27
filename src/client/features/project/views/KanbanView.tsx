/**
 * The board: one column per group option, cards dragged between and within them.
 *
 * Dragging is pointer-based (see use-drag-sort) so a finger works the same as a mouse, and the drop
 * writes two things: the card's group value when it crossed a column, and the view's manual card
 * order when it landed between two cards. The reference keeps those as one gesture; splitting them
 * made a reorder inside a column silently do nothing.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, EyeOff, GripVertical, MoreHorizontal, Palette, Pencil, Plus, Trash2 } from 'lucide-react'
import type { ProjectCalculation, ProjectCard, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import { isProjectCardDone, PROJECT_PROPERTY_CAPABILITIES } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { calculationOptionsFor, computeProjectCalculation } from '@shared/project/calculations'
import { projectCardColorResolver, projectOptionCssColor, PROJECT_OPTION_COLORS } from '@shared/project/option-color'
import { groupProjectCards, projectGroupLabel, projectKanbanDropOrder } from '@shared/project/view-eval'
import { t, useLocale } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Menu, prompt, submenuFor, type MenuItem } from '../../../components/overlay'
import { optionColorItems } from '../card-menu'
import { isImeComposing, isEnterKey } from '../../../lib/ime'
import { useEvent } from '../../../lib/hooks'
import { useProjectPeople } from '../people-context'
import { useToday } from '../use-today'
import { QuickAdd, ViewShell } from './shell'
import { CardFace, CardGrip, DropLine, SubtaskProgress, SubtaskRows } from './card-face'
import { useDragSort, type DragDropTarget, type DragGeometry, type DragOverStore } from './use-drag-sort'
import { useBandDrag } from './use-band-drag'
import { useVirtualList, VIRTUAL_LIST_THRESHOLD } from '../../list/virtual-list'

export interface KanbanProps {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  fields: ProjectViewFields
  badgesFor: (cardId: string) => ProjectCardBadges
  coverFor?: (cardId: string) => string | null
  subtasksByParent: Map<string, ProjectCard[]>
  canEdit: boolean
  selected: string[]
  onSelectClick: (event: MouseEvent, cardId: string) => void
  onOpenCard: (id: string) => void
  onDeleteCard: (id: string) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onPatchCards: (ids: readonly string[], values: Record<string, string | null>) => Promise<void>
  onDragCards: (patches: { id: string, patch: Record<string, unknown> }[], cardOrder: string[]) => Promise<void>
  onPatchFields: (fields: Partial<ProjectViewFields>) => void
  onAddCard: (title: string, optionId: string) => Promise<void>
  onAddGroupOption: (propertyId: string, value: string) => Promise<void>
  onRenameGroupOption: (propertyId: string, optionId: string, value: string) => Promise<void>
  onSetGroupOptionColor: (propertyId: string, optionId: string, color: string) => Promise<void>
  canMarkDone?: boolean
  starredCards: string[]
  pinnedCards: string[]
  descriptionFor: (cardId: string) => string
  onCardContextMenu: (event: MouseEvent, card: ProjectCard) => void
  onToggleCardDone: (card: ProjectCard, done: boolean) => Promise<void>
  onAddSubtask: (parentId: string) => Promise<void>
}

const KANBAN_CARD_GAP = 6

interface KanbanColumnGeometry {
  offsets: number[]
  cardIds: string[]
}

type KanbanColumnGeometryProvider = () => KanbanColumnGeometry

/** Column keys in the reader's order: the property's options, then any discovered value, then the ungrouped bucket. */
export function kanbanColumnKeys(property: ProjectProperty | undefined, fields: ProjectViewFields, discovered: readonly string[] = []): string[] {
  const options = property?.options.map((option) => option.id) ?? []
  const base = [...new Set([...options, ...discovered, ''])]
  const order = fields.columnOrder ?? []
  const rank = new Map(order.map((id, index) => [id, index]))
  const sorted = base.toSorted((left, right) => {
    const a = rank.get(left)
    const b = rank.get(right)
    if (a === undefined && b === undefined) return 0
    if (a === undefined) return 1
    if (b === undefined) return -1
    return a - b
  })
  return sorted.filter((key) => !fields.hiddenOptionIds.includes(key))
}

export function KanbanView(props: KanbanProps): ReactElement {
  const { cards, properties, fields, canEdit, selected } = props
  const groupProperty = properties.find((property) => property.id === fields.groupById)
  const writableGroup = Boolean(groupProperty && !PROJECT_PROPERTY_CAPABILITIES[groupProperty.type].readOnly)
  const groups = useMemo(() => groupProjectCards(cards, fields.groupById, properties), [cards, fields.groupById, properties])
  const keys = useMemo(
    () => kanbanColumnKeys(groupProperty, fields, [...groups.keys()].filter((key) => key !== '')),
    [groupProperty, fields, groups],
  )
  const allIds = useMemo(() => new Set(cards.map((card) => card.id)), [cards])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const starredSet = useMemo(() => new Set(props.starredCards), [props.starredCards])
  const pinnedSet = useMemo(() => new Set(props.pinnedCards), [props.pinnedCards])
  const columns = useMemo(() => keys.map((key) => {
    const bucket = groups.get(key) ?? []
    const roots = bucket.filter((card) => !card.parentId || !allIds.has(card.parentId))
    // A pinned card leads its column without leaving it: the pin is a marker, not a second bucket.
    const pinned = roots.filter((card) => pinnedSet.has(card.id))
    return { key, cards: [...pinned, ...roots.filter((card) => !pinnedSet.has(card.id))] }
  }), [keys, groups, allIds, pinnedSet])
  const chipProperties = useMemo(() => (fields.visiblePropertyIds.length
    ? fields.visiblePropertyIds.map((id) => properties.find((property) => property.id === id)).filter((property): property is ProjectProperty => Boolean(property))
    : properties), [fields.visiblePropertyIds, properties])
  const colorOf = useMemo(() => projectCardColorResolver(properties), [properties])
  const todayStamp = useToday()
  const boardRef = useRef<HTMLDivElement>(null)
  const columnGeometry = useRef(new Map<string, KanbanColumnGeometryProvider>())
  const registerColumnGeometry = useCallback((key: string, provider: KanbanColumnGeometryProvider | null): (() => void) => {
    if (provider) columnGeometry.current.set(key, provider)
    else columnGeometry.current.delete(key)
    return () => {
      if (columnGeometry.current.get(key) === provider) columnGeometry.current.delete(key)
    }
  }, [])
  const hasVirtualColumns = columns.some((column) => column.cards.length > VIRTUAL_LIST_THRESHOLD)
  const dragGeometry = useCallback((): DragGeometry => {
    const root = boardRef.current
    if (!root) return { zones: [], items: new Map(), viewport: true }
    const zones: DragGeometry['zones'][number][] = []
    const items = new Map<string, { id: string, top: number, height: number }[]>()
    for (const column of columns) {
      const node = [...root.querySelectorAll<HTMLElement>('[data-kanban-column]')].find((entry) => entry.dataset.kanbanColumn === column.key)
      const body = node?.querySelector<HTMLElement>('[data-drag-zone]')
      if (!body) continue
      const rect = body.getBoundingClientRect()
      const paddingTop = Number.parseFloat(getComputedStyle(body).paddingTop) || 0
      zones.push({ key: column.key, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
      const provided = columnGeometry.current.get(column.key)?.()
      if (provided) {
        items.set(column.key, provided.cardIds.map((id, index) => ({
          id,
          top: rect.top + paddingTop - body.scrollTop + (provided.offsets[index] ?? 0),
          height: (provided.offsets[index + 1] ?? 0) - (provided.offsets[index] ?? 0),
        })))
      } else {
        items.set(column.key, [...body.querySelectorAll<HTMLElement>('[data-drag-item]:not([data-child="true"])')].map((entry) => {
          const cardRect = entry.getBoundingClientRect()
          return { id: entry.dataset.dragId ?? '', top: cardRect.top, height: cardRect.height }
        }))
      }
    }
    return { zones, items, viewport: true }
  }, [columns])

  const onDrop = (cardId: string, target: DragDropTarget): void => {
    const bulk = selected.length > 1 && selectedSet.has(cardId)
    const draggedIds = bulk ? cards.filter((card) => selectedSet.has(card.id)).map((card) => card.id) : [cardId]
    const moving = writableGroup && groupProperty
      ? draggedIds.filter((id) => {
          const card = cards.find((entry) => entry.id === id)
          return card && (card.values[groupProperty.id] ?? '') !== target.zone
        })
      : []
    const wipLimit = fields.wipLimits?.[target.zone]
    if (wipLimit !== undefined) {
      const targetCount = columns.find((column) => column.key === target.zone)?.cards.length ?? 0
      if (targetCount + moving.length > wipLimit) {
        useUi.getState().toast({ title: t('project.view.wip_limit_reached'), tone: 'danger' })
        return
      }
    }
    const order = projectKanbanDropOrder({
      columns: columns.map((column) => ({ key: column.key, cardIds: column.cards.map((card) => card.id) })),
      cardOrder: fields.cardOrder,
      draggedIds,
      target,
    })
    const values = writableGroup && groupProperty ? { [groupProperty.id]: target.zone === '' ? null : target.zone } : {}
    const patches = moving.map((id) => ({ id, patch: { values } }))
    void props.onDragCards(patches, order)
  }
  const drag = useDragSort({
    enabled: canEdit,
    geometry: hasVirtualColumns ? dragGeometry : undefined,
    groupOf: (id) => (selected.length > 1 && selectedSet.has(id) ? selected : [id]),
    onDrop,
  })

  const addGroup = (): void => {
    if (!groupProperty) return
    setAddingGroup(true)
  }
  const [addingGroup, setAddingGroup] = useState(false)
  const moveColumn = (source: string, target: string): void => {
    if (source === target) return
    // Dragging rightwards lands the column after the one it was dropped on; leftwards, before it.
    // Inserting always before would make a one-step drag to the right a no-op.
    const forwards = keys.indexOf(source) < keys.indexOf(target)
    const without = keys.filter((key) => key !== source)
    const at = without.indexOf(target) + (forwards ? 1 : 0)
    props.onPatchFields({ columnOrder: [...without.slice(0, at), source, ...without.slice(at)] })
  }
  const columnDrag = useBandDrag({
    enabled: canEdit,
    axis: 'x',
    measure: () => [...(boardRef.current?.querySelectorAll<HTMLElement>('[data-kanban-column]') ?? [])].map((node) => {
      const rect = node.getBoundingClientRect()
      return { id: node.dataset.kanbanColumn ?? '', from: rect.left, to: rect.right }
    }),
    onDrop: moveColumn,
  })
  const [groupDraft, setGroupDraft] = useState('')
  const submitGroup = async (): Promise<void> => {
    const value = groupDraft.trim()
    setAddingGroup(false)
    setGroupDraft('')
    if (value && groupProperty) await props.onAddGroupOption(groupProperty.id, value)
  }

  return (
    <ViewShell data-view="board">
    <div ref={boardRef} className="pv-board pv-scroll" data-drag-root="" data-kanban="">
      {columns.map((column) => (
        <KanbanColumn
          key={column.key || 'none'}
          registerColumnGeometry={registerColumnGeometry}
          {...props}
          columnKey={column.key}
          cards={column.cards}
          groupProperty={groupProperty}
          chipProperties={chipProperties}
          colorOf={colorOf}
          todayStamp={todayStamp}
          drag={drag}
          dragColumn={columnDrag.draggingId === column.key ? column.key : null}
          keyboardColumn={columnDrag.keyboardDragId === column.key ? column.key : null}
          overColumn={columnDrag.overId}
          onColumnDragStart={(event) => columnDrag.start(event, column.key)}
          onColumnKeyDown={(event) => columnDrag.onKeyDown(event, column.key)}
          selectedSet={selectedSet}
          starredSet={starredSet}
          pinnedSet={pinnedSet}
        />
      ))}
      {canEdit && groupProperty && (
        <div className="flex w-44 shrink-0 flex-col gap-2 pt-1">
          {addingGroup
            ? (
              <form onSubmit={(event) => { event.preventDefault(); void submitGroup() }}>
                <Input
                  className="w-full"
                  autoFocus
                  value={groupDraft}
                  aria-label={t('project.view.add_group')}
                  onChange={(event) => setGroupDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Escape' && !isImeComposing(event)) { setAddingGroup(false); setGroupDraft('') } }}
                  onBlur={() => { void submitGroup() }}
                />
              </form>
            )
            : <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={addGroup}>{t('project.view.add_group')}</Button>}
          {fields.hiddenOptionIds.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => props.onPatchFields({ hiddenOptionIds: [] })}>
              {t('project.view.show_hidden_columns')}
            </Button>
          )}
        </div>
      )}
    </div>
    </ViewShell>
  )
}

function KanbanColumn({ columnKey, cards, groupProperty, properties, chipProperties, fields, colorOf, todayStamp, drag, dragColumn, keyboardColumn, overColumn, onColumnDragStart, onColumnKeyDown, registerColumnGeometry, ...props }: KanbanProps & {
  columnKey: string
  cards: ProjectCard[]
  groupProperty: ProjectProperty | undefined
  chipProperties: readonly ProjectProperty[]
  colorOf: (card: ProjectCard) => string
  todayStamp: number
  drag: ReturnType<typeof useDragSort>
  dragColumn: string | null
  keyboardColumn: string | null
  overColumn: string | null
  onColumnDragStart: (event: React.PointerEvent) => void
  onColumnKeyDown: (event: React.KeyboardEvent) => void
  registerColumnGeometry: (key: string, provider: KanbanColumnGeometryProvider | null) => () => void
  selectedSet: ReadonlySet<string>
  starredSet: ReadonlySet<string>
  pinnedSet: ReadonlySet<string>
}): ReactElement {
  const { canEdit, subtasksByParent, selectedSet, starredSet, pinnedSet, canMarkDone = true } = props
  const people = useProjectPeople()
  const locale = useLocale()
  const label = columnKey === '' ? t('project.view.no_value') : projectGroupLabel(groupProperty, columnKey, people, locale)
  const color = (groupProperty && columnKey !== ''
    ? projectOptionCssColor(groupProperty.options.find((option) => option.id === columnKey)?.color ?? '')
    : null) ?? 'var(--text-quaternary)'
  const collapsed = fields.collapsedOptionIds.includes(columnKey)
  const calc = fields.kanbanCalculations[columnKey]?.calculation ?? 'count'
  const calcProperty = groupProperty ?? properties[0]
  const wip = fields.wipLimits?.[columnKey]
  const count = calcProperty ? computeProjectCalculation(cards, calcProperty, calc) : cards.length
  const virtualized = cards.length > VIRTUAL_LIST_THRESHOLD
  const estimateCard = useCallback((): number => (fields.boardLayout === 'card' ? 188 : fields.cardSize === 'compact' ? 72 : fields.cardSize === 'spacious' ? 128 : 96) + KANBAN_CARD_GAP, [fields.boardLayout, fields.cardSize])
  const virtual = useVirtualList(virtualized ? cards.length : 0, estimateCard, virtualized ? `${columnKey}:${cards.length}:${fields.boardLayout}:${fields.cardSize}` : 'kanban')
  useEffect(() => registerColumnGeometry(columnKey, virtualized ? () => ({
    offsets: virtual.offsets,
    cardIds: cards.map((card) => card.id),
  }) : null), [registerColumnGeometry, columnKey, virtualized, virtual.offsets, cards])
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(label)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [columnMenu, setColumnMenu] = useState<{ x: number, y: number } | null>(null)
  const toggleExpanded = useEvent((cardId: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  })
  const colorOptions = optionColorItems(['', ...PROJECT_OPTION_COLORS], groupProperty?.options.find((option) => option.id === columnKey)?.color ?? '', (next) => {
    setColumnMenu(null)
    if (groupProperty && columnKey !== '') void props.onSetGroupOptionColor(groupProperty.id, columnKey, next)
  })
  const columnMenuItems: MenuItem[] = [
    {
      id: 'new', label: t('project.view.new_card_here'), icon: <Plus size={14} />,
      onSelect: () => {
        setColumnMenu(null)
        void prompt({ title: t('project.view.new_card_here'), confirmLabel: t('common.save') }).then((name) => {
          if (name && name.trim()) void props.onAddCard(name.trim(), columnKey)
        })
      },
    },
    { id: 'rename', label: t('project.view.rename_group'), icon: <Pencil size={14} />, onSelect: () => { setColumnMenu(null); setDraft(label); setRenaming(true) } },
    { id: 'color', label: t('project.view.column_color'), icon: <Palette size={14} />, subItems: colorOptions, submenu: submenuFor(colorOptions) },
    { id: 'collapse', label: t('project.view.collapse_column'), icon: <ChevronRight size={14} />, separatorBefore: true, onSelect: () => { setColumnMenu(null); toggleCollapse() } },
    { id: 'hide', label: t('project.view.hide_column'), icon: <EyeOff size={14} />, onSelect: () => { setColumnMenu(null); props.onPatchFields({ hiddenOptionIds: [...fields.hiddenOptionIds, columnKey] }) } },
  ]

  const toggleCollapse = (): void => {
    props.onPatchFields({
      collapsedOptionIds: collapsed
        ? fields.collapsedOptionIds.filter((entry) => entry !== columnKey)
        : [...fields.collapsedOptionIds, columnKey],
    })
  }
  const commitRename = async (): Promise<void> => {
    setRenaming(false)
    const value = draft.trim()
    if (value && value !== label && groupProperty && columnKey !== '') await props.onRenameGroupOption(groupProperty.id, columnKey, value)
  }
  const renderCard = (card: ProjectCard, index: number): ReactElement => (
    <KanbanCard
      key={card.id}
      card={card}
      index={index}
      columnKey={columnKey}
      overStore={drag.overStore}
      fields={fields}
      properties={properties}
      chipProperties={chipProperties}
      colorOf={colorOf}
      todayStamp={todayStamp}
      subtasksByParent={subtasksByParent}
      selected={selectedSet.has(card.id)}
      starred={starredSet.has(card.id)}
      pinned={pinnedSet.has(card.id)}
      dragging={drag.draggingId === card.id}
      keyboardDragging={drag.keyboardDragId === card.id}
      isOpen={expanded.has(card.id)}
      canEdit={canEdit}
      canMarkDone={canMarkDone}
      badges={props.badgesFor(card.id)}
      cover={props.coverFor?.(card.id) ?? null}
      description={props.descriptionFor(card.id)}
      onSelectClick={props.onSelectClick}
      onDeleteCard={props.onDeleteCard}
      onCardContextMenu={props.onCardContextMenu}
      onOpenCard={props.onOpenCard}
      onToggleCardDone={props.onToggleCardDone}
      onAddSubtask={props.onAddSubtask}
      onToggleExpanded={toggleExpanded}
      onDragStart={drag.start}
      onDragKey={drag.onKeyDown}
    />
  )

  return (
    <section
      className="pv-col"
      style={{ '--pv-col-color': color } as React.CSSProperties}
      data-kanban-column={columnKey}
      data-collapsed={collapsed}
      aria-label={label}
      onContextMenu={(event) => {
        if (!canEdit || !groupProperty || columnKey === '') return
        event.preventDefault()
        event.stopPropagation()
        setColumnMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <span className="pv-col-band" aria-hidden="true" />
      {collapsed
        ? (
          <button type="button" className="pv-col-vertical" onClick={toggleCollapse} aria-expanded={false}>
            <ChevronRight size={13} aria-hidden="true" />
            <span className="truncate">{label}</span>
            <span className="pv-col-count">{cards.length}</span>
          </button>
        )
        : (
          <>
            <ColumnHead
              label={label}
              count={count}
              overLimit={wip !== undefined && cards.length > wip}
              color={color}
              canEdit={canEdit && Boolean(groupProperty) && columnKey !== ''}
              hideable={canEdit && Boolean(groupProperty) && columnKey !== ''}
              dragging={dragColumn === columnKey || keyboardColumn === columnKey}
              dropTarget={overColumn === columnKey && dragColumn !== columnKey && keyboardColumn !== columnKey}
              onGripDown={onColumnDragStart}
              onGripKey={onColumnKeyDown}
              calc={calc}
              calcOptions={calcProperty ? calculationOptionsFor(calcProperty) : []}
              wip={wip}
              renaming={renaming}
              draft={draft}
              onDraft={setDraft}
              onRename={() => { setDraft(label); setRenaming(true) }}
              onCommit={() => { void commitRename() }}
              onCancelRename={() => setRenaming(false)}
              onCollapse={toggleCollapse}
              onCalc={(next) => { if (calcProperty) props.onPatchFields({ kanbanCalculations: { ...fields.kanbanCalculations, [columnKey]: { calculation: next, propertyId: calcProperty.id } } }) }}
              onWip={(next) => {
                const limits = { ...fields.wipLimits }
                if (next === null) delete limits[columnKey]
                else limits[columnKey] = next
                props.onPatchFields({ wipLimits: limits })
              }}
              onHide={() => props.onPatchFields({ hiddenOptionIds: [...fields.hiddenOptionIds, columnKey] })}
            />
            {canEdit && (
              <div className="pv-quickadd">
                <QuickAdd alwaysOpen label={t('project.board.new_card')} placeholder={t('project.view.add_card_inline')} onAdd={(title) => props.onAddCard(title, columnKey)} />
              </div>
            )}
            <div ref={virtual.containerRef} className="pv-col-body pv-scroll" data-drag-zone={columnKey}>
              {virtualized ? (
                <div className="relative shrink-0" style={{ height: virtual.total }}>
                  {cards.slice(virtual.start, virtual.end).map((card, sliceIndex) => {
                    const index = virtual.start + sliceIndex
                    return (
                      <div
                        key={card.id}
                        data-virtual-index={index}
                        className="absolute inset-x-0"
                        style={{ top: virtual.offsets[index], paddingBottom: index === cards.length - 1 ? undefined : 'var(--sp-1-5)' }}
                      >
                        {renderCard(card, index)}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <>
                  {cards.length === 0 && <p className="pv-col-empty">{t('project.view.drop_here')}</p>}
                  {cards.map(renderCard)}
                </>
              )}
              <DropLine store={drag.overStore} zone={columnKey} index={cards.length} />
            </div>
          </>
        )}
      {columnMenu && (
        <Menu anchor={columnMenu} open onClose={() => setColumnMenu(null)} items={columnMenuItems} label={label} />
      )}
    </section>
  )
}

interface KanbanCardProps {
  card: ProjectCard
  index: number
  columnKey: string
  overStore: DragOverStore
  fields: ProjectViewFields
  properties: ProjectProperty[]
  chipProperties: readonly ProjectProperty[]
  colorOf: (card: ProjectCard) => string
  todayStamp: number
  subtasksByParent: Map<string, ProjectCard[]>
  selected: boolean
  starred: boolean
  pinned: boolean
  dragging: boolean
  isOpen: boolean
  canEdit: boolean
  canMarkDone: boolean
  badges: ProjectCardBadges
  cover: string | null
  description: string
  onSelectClick: (event: MouseEvent, cardId: string) => void
  onDeleteCard: (id: string) => void
  onCardContextMenu: (event: MouseEvent, card: ProjectCard) => void
  onOpenCard: (id: string) => void
  onToggleCardDone: (card: ProjectCard, done: boolean) => Promise<void>
  onAddSubtask: (parentId: string) => Promise<void>
  onToggleExpanded: (cardId: string) => void
  onDragStart: (event: React.PointerEvent, id: string) => void
  onDragKey: (event: React.KeyboardEvent, id: string) => void
  keyboardDragging: boolean
}

const KanbanCard = memo(function KanbanCard({ card, index, columnKey, overStore, fields, properties, chipProperties, colorOf, todayStamp, subtasksByParent, selected, starred, pinned, dragging, keyboardDragging, isOpen, canEdit, canMarkDone, badges, cover, description, onSelectClick, onDeleteCard, onCardContextMenu, onOpenCard, onToggleCardDone, onAddSubtask, onToggleExpanded, onDragStart, onDragKey }: KanbanCardProps): ReactElement {
  const subtasks = subtasksByParent.get(card.id) ?? []
  const done = subtasks.filter((entry) => isProjectCardDone(entry, properties)).length
  const layout = fields.boardLayout ?? 'compact'
  return (
    <div className="contents">
      <DropLine store={overStore} zone={columnKey} index={index} />
      <article
        className="pv-card group"
        data-drag-item=""
        data-drag-id={card.id}
        data-project-card={card.id}
        data-density={fields.cardSize ?? 'comfortable'}
        data-layout={layout}
        data-selected={selected}
        data-done={isProjectCardDone(card, properties)}
        data-dragging={dragging}
        style={{ '--pv-card-color': colorOf(card) } as React.CSSProperties}
        onContextMenu={(event) => onCardContextMenu(event, card)}
      >
        <CardFace
          card={card}
          color={colorOf(card)}
          cover={cover}
          chipProperties={chipProperties}
          excludePropertyId={fields.groupById}
          badges={badges}
          density={fields.cardSize ?? 'comfortable'}
          todayStamp={todayStamp}
          rich={layout === 'card'}
          description={description}
          starred={starred}
          pinned={pinned}
        >
          <button
            type="button"
            className="pv-card-title"
            onClick={(event) => onSelectClick(event, card.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }))
            }}
          >
            {card.icon && <span className="mr-1" aria-hidden="true">{card.icon}</span>}
            {card.title || t('project.board.untitled_card')}
          </button>
          {canEdit && (
            <IconButton label={t('project.board.delete_card')} size="sm" className="opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100" data-touch-reveal="" onClick={() => onDeleteCard(card.id)}>
              <Trash2 size={12} />
            </IconButton>
          )}
          {canEdit && <CardGrip label={t('project.view.drag_card', { title: card.title || t('project.board.untitled_card') })} onPointerDown={(event) => onDragStart(event, card.id)} onKeyDown={(event) => onDragKey(event, card.id)} dragging={keyboardDragging} />}
        </CardFace>
        {subtasks.length > 0 && (
          <>
            <SubtaskProgress done={done} total={subtasks.length} color={colorOf(card)} />
            <button
              type="button"
              className="flex items-center gap-1 self-start text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              aria-expanded={isOpen}
              aria-label={isOpen ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
              onClick={() => onToggleExpanded(card.id)}
            >
              {isOpen ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
              {isOpen ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
            </button>
            {isOpen && (
              <SubtaskRows
                parentId={card.id}
                subtasks={subtasks}
                properties={properties}
                canEdit={canEdit && canMarkDone}
                colorOf={colorOf}
                onOpenCard={onOpenCard}
                onToggleDone={(entry, checked) => { void onToggleCardDone(entry, checked) }}
                onDelete={onDeleteCard}
                onAddSubtask={onAddSubtask}
              />
            )}
          </>
        )}
      </article>
    </div>
  )
})

/**
 * The column's title row: name, summary and one menu.
 *
 * The name is a button so a double click renames the option itself — the column and every card wearing
 * that option change together, which is what renaming a status means.
 */
function ColumnHead({ label, count, overLimit, color, canEdit, hideable, calc, calcOptions, wip, renaming, draft, dragging, dropTarget, onGripDown, onGripKey, onDraft, onRename, onCommit, onCancelRename, onCollapse, onCalc, onWip, onHide }: {
  label: string
  count: string | number
  overLimit: boolean
  color: string
  canEdit: boolean
  hideable: boolean
  calc: ProjectCalculation
  calcOptions: readonly ProjectCalculation[]
  wip: number | undefined
  renaming: boolean
  draft: string
  dragging: boolean
  dropTarget: boolean
  onGripDown: (event: React.PointerEvent) => void
  onGripKey: (event: React.KeyboardEvent) => void
  onDraft: (value: string) => void
  onRename: () => void
  onCommit: () => void
  onCancelRename: () => void
  onCollapse: () => void
  onCalc: (next: ProjectCalculation) => void
  onWip: (next: number | null) => void
  onHide: () => void
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [wipDraft, setWipDraft] = useState('')
  const items: MenuItem[] = [
    ...calcOptions.map((option) => ({
      id: `calc-${option}`,
      label: t(`project.calc.${option.toLowerCase()}` as Parameters<typeof t>[0]),
      checked: option === calc,
      onSelect: () => { setOpen(false); onCalc(option) },
    })),
    { id: 'collapse', label: t('project.view.collapse_column'), icon: <ChevronRight size={14} />, separatorBefore: true, onSelect: () => { setOpen(false); onCollapse() } },
    ...(hideable ? [{ id: 'hide', label: t('project.view.hide_column'), icon: <EyeOff size={14} />, onSelect: () => { setOpen(false); onHide() } }] : []),
  ]
  return (
    <header
      className="pv-col-head"
      data-dragging={dragging}
      data-drop-target={dropTarget}
    >
      {canEdit && (
        <button
          type="button"
          className="pv-col-grip"
          data-column-grip={label}
          aria-label={t('project.view.drag_column', { title: label })}
          aria-pressed={dragging}
          onPointerDown={onGripDown}
          onKeyDown={onGripKey}
        >
          <GripVertical size={12} aria-hidden="true" />
          <span className="sr-only">{t('project.view.keyboard_drag_help')}</span>
        </button>
      )}
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      {renaming
        ? (
          <Input
            className="h-6 min-w-0 flex-1"
            autoFocus
            value={draft}
            aria-label={t('project.view.rename_group')}
            onChange={(event) => onDraft(event.target.value)}
            onBlur={onCommit}
            onKeyDown={(event) => {
              if (isEnterKey(event) && !isImeComposing(event)) { event.preventDefault(); onCommit() }
              else if (event.key === 'Escape' && !isImeComposing(event)) { event.preventDefault(); onCancelRename() }
            }}
          />
        )
        : canEdit
          ? (
            <button
              type="button"
              className="pv-col-name"
              title={t('project.view.rename_group_hint')}
              onDoubleClick={onRename}
            >
              {label}
            </button>
          )
          : <span className="pv-col-name">{label}</span>}
      <span className="pv-col-count" data-over-limit={overLimit}>{count}</span>
      <IconButton label={t('project.view.collapse_column')} size="sm" aria-expanded={true} onClick={onCollapse}>
        <ChevronDown size={14} />
      </IconButton>
      <IconButton ref={anchor} label={`${label} ${t('project.view.menu')}`} size="sm" onClick={() => { setWipDraft(wip === undefined ? '' : String(wip)); setOpen(true) }}>
        <MoreHorizontal size={14} />
      </IconButton>
      <Menu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        align="end"
        label={label}
        header={
          <label className="flex items-center gap-2 px-2 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)]">
            <span className="shrink-0">{t('project.view.wip_limit')}</span>
            <Input
              type="number"
              className="h-7 min-w-0 flex-1"
              value={wipDraft}
              aria-label={`${label} ${t('project.view.wip_limit')}`}
              onChange={(event) => setWipDraft(event.target.value)}
              onBlur={() => {
                const raw = wipDraft.trim()
                onWip(raw === '' ? null : Math.max(0, Math.round(Number(raw))))
              }}
            />
          </label>
        }
      />
    </header>
  )
}
