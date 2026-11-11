/**
 * The board: one column per group option, cards dragged between and within them.
 *
 * Dragging is pointer-based (see use-drag-sort) so a finger works the same as a mouse, and the drop
 * writes two things: the card's group value when it crossed a column, and the view's manual card
 * order when it landed between two cards. The reference keeps those as one gesture; splitting them
 * made a reorder inside a column silently do nothing.
 */
import { useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, EyeOff, MoreHorizontal, Palette, Pencil, Plus, Trash2 } from 'lucide-react'
import type { ProjectCalculation, ProjectCard, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { calculationOptionsFor, computeProjectCalculation } from '@shared/project/calculations'
import { projectCardColor, projectOptionCssColor, PROJECT_OPTION_COLORS } from '@shared/project/option-color'
import { groupProjectCards, projectKanbanDropOrder, projectOptionLabel } from '@shared/project/view-eval'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Menu, submenuFor, type MenuItem } from '../../../components/overlay'
import { optionColorItems } from '../card-menu'
import { isImeComposing } from '../../../lib/ime'
import { QuickAdd, ViewShell } from './shell'
import { CardFace, CardGrip, SubtaskProgress, SubtaskRows } from './card-face'
import { useDragSort, type DragDropTarget } from './use-drag-sort'

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
  onPatchFields: (fields: Partial<ProjectViewFields>) => void
  onAddCard: (title: string, optionId: string) => Promise<void>
  onAddGroupOption: (propertyId: string, value: string) => Promise<void>
  onRenameGroupOption: (propertyId: string, optionId: string, value: string) => Promise<void>
  onSetGroupOptionColor: (propertyId: string, optionId: string, color: string) => Promise<void>
  starredCards: string[]
  pinnedCards: string[]
  descriptionFor: (cardId: string) => string
  onCardContextMenu: (event: MouseEvent, card: ProjectCard) => void
  onToggleCardDone: (card: ProjectCard, done: boolean) => Promise<void>
  onAddSubtask: (parentId: string) => Promise<void>
}

/** Column keys in the reader's order: the property's options, then the ungrouped bucket. */
export function kanbanColumnKeys(property: ProjectProperty | undefined, fields: ProjectViewFields): string[] {
  const base = property && property.options.length > 0 ? [...property.options.map((option) => option.id), ''] : ['']
  const order = fields.columnOrder ?? []
  const rank = new Map(order.map((id, index) => [id, index]))
  const sorted = [...base].sort((left, right) => {
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
  const { cards, properties, fields, canEdit } = props
  const groupProperty = properties.find((property) => property.id === fields.groupById)
  const keys = kanbanColumnKeys(groupProperty, fields)
  const groups = useMemo(() => groupProjectCards(cards, fields.groupById, properties), [cards, fields.groupById, properties])
  const allIds = useMemo(() => new Set(cards.map((card) => card.id)), [cards])
  const columns = keys.map((key) => {
    const bucket = groups.get(key) ?? []
    const roots = bucket.filter((card) => !card.parentId || !allIds.has(card.parentId))
    // A pinned card leads its column without leaving it: the pin is a marker, not a second bucket.
    const pinned = roots.filter((card) => props.pinnedCards.includes(card.id))
    return { key, cards: [...pinned, ...roots.filter((card) => !props.pinnedCards.includes(card.id))] }
  })
  const chipProperties = fields.visiblePropertyIds.length
    ? fields.visiblePropertyIds.map((id) => properties.find((property) => property.id === id)).filter((property): property is ProjectProperty => Boolean(property))
    : properties
  const colorOf = (card: ProjectCard): string => projectCardColor(card, properties)

  const onDrop = (cardId: string, target: DragDropTarget): void => {
    const order = projectKanbanDropOrder({
      columns: columns.map((column) => ({ key: column.key, cardIds: column.cards.map((card) => card.id) })),
      cardOrder: fields.cardOrder,
      draggedId: cardId,
      target,
    })
    props.onPatchFields({ cardOrder: order })
    const card = cards.find((entry) => entry.id === cardId)
    if (groupProperty && card && (card.values[groupProperty.id] ?? '') !== target.zone) {
      void props.onPatchCard(cardId, { values: { [groupProperty.id]: target.zone === '' ? null : target.zone } })
    }
  }
  const drag = useDragSort({ enabled: canEdit, onDrop })

  const addGroup = (): void => {
    if (!groupProperty) return
    setAddingGroup(true)
  }
  const [addingGroup, setAddingGroup] = useState(false)
  const [dragColumn, setDragColumn] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<string | null>(null)
  const moveColumn = (source: string, target: string): void => {
    if (source === target) return
    // Dragging rightwards lands the column after the one it was dropped on; leftwards, before it.
    // Inserting always before would make a one-step drag to the right a no-op.
    const forwards = keys.indexOf(source) < keys.indexOf(target)
    const without = keys.filter((key) => key !== source)
    const at = without.indexOf(target) + (forwards ? 1 : 0)
    props.onPatchFields({ columnOrder: [...without.slice(0, at), source, ...without.slice(at)] })
  }
  const [groupDraft, setGroupDraft] = useState('')
  const submitGroup = async (): Promise<void> => {
    const value = groupDraft.trim()
    setAddingGroup(false)
    setGroupDraft('')
    if (value && groupProperty) await props.onAddGroupOption(groupProperty.id, value)
  }

  return (
    <ViewShell data-view="board">
    <div className="pv-board pv-scroll" data-drag-root="" data-kanban="">
      {columns.map((column) => (
        <KanbanColumn
          key={column.key || 'none'}
          {...props}
          columnKey={column.key}
          cards={column.cards}
          groupProperty={groupProperty}
          chipProperties={chipProperties}
          colorOf={colorOf}
          drag={drag}
          dragColumn={dragColumn}
          overColumn={overColumn}
          onColumnDragStart={setDragColumn}
          onColumnDragOver={setOverColumn}
          onColumnDrop={(target) => { if (dragColumn) moveColumn(dragColumn, target); setDragColumn(null); setOverColumn(null) }}
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

function KanbanColumn({ columnKey, cards, groupProperty, properties, chipProperties, fields, colorOf, drag, dragColumn, overColumn, onColumnDragStart, onColumnDragOver, onColumnDrop, ...props }: KanbanProps & {
  columnKey: string
  cards: ProjectCard[]
  groupProperty: ProjectProperty | undefined
  chipProperties: readonly ProjectProperty[]
  colorOf: (card: ProjectCard) => string
  drag: ReturnType<typeof useDragSort>
  dragColumn: string | null
  overColumn: string | null
  onColumnDragStart: (key: string | null) => void
  onColumnDragOver: (key: string | null) => void
  onColumnDrop: (key: string) => void
}): ReactElement {
  const { canEdit, subtasksByParent, selected } = props
  const label = columnKey === '' ? t('project.view.no_value') : projectOptionLabel(groupProperty!, columnKey)
  const color = (groupProperty && columnKey !== ''
    ? projectOptionCssColor(groupProperty.options.find((option) => option.id === columnKey)?.color ?? '')
    : null) ?? 'var(--text-quaternary)'
  const collapsed = fields.collapsedOptionIds.includes(columnKey)
  const calc = fields.kanbanCalculations[columnKey]?.calculation ?? 'count'
  const calcProperty = groupProperty ?? properties[0]
  const wip = fields.wipLimits?.[columnKey]
  const count = calcProperty ? computeProjectCalculation(cards, calcProperty, calc) : cards.length
  const over = drag.over?.zone === columnKey
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(label)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [columnMenu, setColumnMenu] = useState<{ x: number, y: number } | null>(null)
  const layout = fields.boardLayout ?? 'compact'
  const colorOptions = optionColorItems(['', ...PROJECT_OPTION_COLORS], groupProperty?.options.find((option) => option.id === columnKey)?.color ?? '', (next) => {
    setColumnMenu(null)
    if (groupProperty && columnKey !== '') void props.onSetGroupOptionColor(groupProperty.id, columnKey, next)
  })
  const columnMenuItems: MenuItem[] = [
    { id: 'new', label: t('project.view.new_card_here'), icon: <Plus size={14} />, onSelect: () => { setColumnMenu(null); void props.onAddCard(t('project.board.untitled_card'), columnKey) } },
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

  return (
    <section
      className="pv-col"
      style={{ '--pv-col-color': color } as React.CSSProperties}
      data-kanban-column={columnKey}
      data-collapsed={collapsed}
      data-over={over && !collapsed}
      aria-label={label}
      onDragOver={(event) => { if (dragColumn) { event.preventDefault(); onColumnDragOver(columnKey) } }}
      onDragLeave={() => { if (overColumn === columnKey) onColumnDragOver(null) }}
      onDrop={(event) => { if (dragColumn) { event.preventDefault(); onColumnDrop(columnKey) } }}
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
              dragging={dragColumn === columnKey}
              dropTarget={overColumn === columnKey && dragColumn !== columnKey}
              onDragStart={() => onColumnDragStart(columnKey)}
              onDragEnd={() => { onColumnDragStart(null); onColumnDragOver(null) }}
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
            <div className="pv-col-body pv-scroll" data-drag-zone={columnKey}>
              {cards.length === 0 && <p className="pv-col-empty">{t('project.view.drop_here')}</p>}
              {cards.map((card, index) => {
                const subtasks = subtasksByParent.get(card.id) ?? []
                const done = subtasks.filter((entry) => isProjectCardDone(entry, properties)).length
                const isOpen = expanded.has(card.id)
                return (
                  <div key={card.id} className="contents">
                    {over && drag.over?.index === index && <div className="pv-drop-line" data-drop-line={columnKey} />}
                    <article
                      className="pv-card group"
                      data-drag-item=""
                      data-drag-id={card.id}
                      data-project-card={card.id}
                      data-density={fields.cardSize ?? 'comfortable'}
                      data-layout={layout}
                      data-selected={selected.includes(card.id)}
                      data-done={isProjectCardDone(card, properties)}
                      data-dragging={drag.draggingId === card.id}
                      style={{ '--pv-card-color': colorOf(card) } as React.CSSProperties}
                      onContextMenu={(event) => props.onCardContextMenu(event, card)}
                    >
                      <CardFace
                        card={card}
                        color={colorOf(card)}
                        cover={props.coverFor?.(card.id)}
                        chipProperties={chipProperties}
                        excludePropertyId={fields.groupById}
                        badges={props.badgesFor(card.id)}
                        density={fields.cardSize ?? 'comfortable'}
                        rich={layout === 'card'}
                        description={props.descriptionFor(card.id)}
                        starred={props.starredCards.includes(card.id)}
                        pinned={props.pinnedCards.includes(card.id)}
                      >
                        <button
                          type="button"
                          className="pv-card-title"
                          onClick={(event) => props.onSelectClick(event, card.id)}
                        >
                          {card.icon && <span className="mr-1" aria-hidden="true">{card.icon}</span>}
                          {card.title || t('project.board.untitled_card')}
                        </button>
                        {canEdit && (
                          <IconButton label={t('project.board.delete_card')} size="sm" className="opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100" onClick={() => props.onDeleteCard(card.id)}>
                            <Trash2 size={12} />
                          </IconButton>
                        )}
                        {canEdit && <CardGrip label={t('project.view.drag_card', { title: card.title || t('project.board.untitled_card') })} onPointerDown={(event) => drag.start(event, card.id)} />}
                      </CardFace>
                      {subtasks.length > 0 && (
                        <>
                          <SubtaskProgress done={done} total={subtasks.length} color={colorOf(card)} />
                          <button
                            type="button"
                            className="flex items-center gap-1 self-start text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
                            onClick={() => setExpanded((current) => {
                              const next = new Set(current)
                              if (next.has(card.id)) next.delete(card.id)
                              else next.add(card.id)
                              return next
                            })}
                          >
                            {isOpen ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
                            {isOpen ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
                          </button>
                          {isOpen && (
                            <SubtaskRows
                              parentId={card.id}
                              subtasks={subtasks}
                              properties={properties}
                              canEdit={canEdit}
                              colorOf={colorOf}
                              onOpenCard={props.onOpenCard}
                              onToggleDone={(entry, checked) => { void props.onToggleCardDone(entry, checked) }}
                              onDelete={props.onDeleteCard}
                              onAddSubtask={props.onAddSubtask}
                            />
                          )}
                        </>
                      )}
                    </article>
                  </div>
                )
              })}
              {over && drag.over?.index === cards.length && <div className="pv-drop-line" data-drop-line={columnKey} />}
            </div>
          </>
        )}
      {columnMenu && (
        <Menu anchor={columnMenu} open onClose={() => setColumnMenu(null)} items={columnMenuItems} label={label} />
      )}
    </section>
  )
}
/**
 * The column's title row: name, summary and one menu.
 *
 * The name is a button so a double click renames the option itself — the column and every card wearing
 * that option change together, which is what renaming a status means.
 */
function ColumnHead({ label, count, overLimit, color, canEdit, hideable, calc, calcOptions, wip, renaming, draft, dragging, dropTarget, onDragStart, onDragEnd, onDraft, onRename, onCommit, onCancelRename, onCollapse, onCalc, onWip, onHide }: {
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
  onDragStart: () => void
  onDragEnd: () => void
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
      draggable={canEdit}
      onDragStart={(event) => { event.dataTransfer.setData('text/plain', `column:${label}`); onDragStart() }}
      onDragEnd={onDragEnd}
    >
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
              if (event.key === 'Enter' && !isImeComposing(event)) { event.preventDefault(); onCommit() }
              else if (event.key === 'Escape' && !isImeComposing(event)) { event.preventDefault(); onCancelRename() }
            }}
          />
        )
        : (
          <button
            type="button"
            className="pv-col-name"
            title={canEdit ? t('project.view.rename_group_hint') : label}
            onClick={() => { if (canEdit) onRename() }}
          >
            {label}
          </button>
        )}
      <span className="pv-col-count" data-over-limit={overLimit}>{count}</span>
      <IconButton label={t('project.view.collapse_column')} size="sm" onClick={onCollapse}>
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
