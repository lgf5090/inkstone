/**
 * The table: every property in a column, edited where it is read.
 *
 * The head and the title column are both frozen, so a wide board keeps its bearings while it scrolls
 * sideways. A cell is a button until it is clicked, then it is the editor for that property type —
 * one click to edit rather than a mode the reader has to discover.
 */
import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, CornerDownRight, Trash2 } from 'lucide-react'
import type { ProjectBoardBundle, ProjectCalculation, ProjectCard, ProjectProperty, ProjectViewFields } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import { calculationOptionsFor, computeProjectCalculation } from '@shared/project/calculations'
import { groupProjectCards, projectOptionLabel, projectPropertyDisplayText } from '@shared/project/view-eval'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { CardBadges, OptionChip } from '../CardBadges'
import { PropertyValueEditor } from '../PropertyValueEditor'
import { QuickAdd } from './shell'

const PAGE = 200

export interface TableProps {
  bundle: ProjectBoardBundle
  cards: ProjectCard[]
  columns: ProjectProperty[]
  fields: ProjectViewFields
  canEdit: boolean
  selected: string[]
  onSelected: (ids: string[]) => void
  subtasksByParent: Map<string, ProjectCard[]>
  badgesFor: (cardId: string) => import('@shared/project/badges').ProjectCardBadges
  onSelectClick: (event: MouseEvent, cardId: string) => void
  onDeleteCard: (id: string) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onPatchFields: (fields: Partial<ProjectViewFields>) => void
  onAddCard: (title: string, optionId: string) => Promise<void>
  onCardContextMenu: (event: MouseEvent, card: ProjectCard) => void
}

export function TableView(props: TableProps): ReactElement {
  const { bundle, cards, columns, fields, canEdit, selected, subtasksByParent } = props
  const [limit, setLimit] = useState(PAGE)
  const [editing, setEditing] = useState<{ cardId: string, propertyId: string } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [resizing, setResizing] = useState<{ id: string, width: number } | null>(null)
  const grip = useRef<{ id: string, startX: number, startWidth: number } | null>(null)
  const density = fields.cardSize ?? 'comfortable'
  const rowPad = density === 'compact' ? 'py-0.5' : density === 'spacious' ? 'py-3' : 'py-1.5'

  const page = cards.slice(0, limit)
  const groups: [string, ProjectCard[]][] = fields.groupById
    ? [...groupProjectCards(page, fields.groupById, bundle.properties).entries()]
    : [['', page]]
  const allIds = useMemo(() => new Set(cards.map((card) => card.id)), [cards])

  const commitWidth = (id: string, width: number): void => {
    props.onPatchFields({ columnWidths: { ...fields.columnWidths, [id]: Math.max(80, Math.round(width)) } })
  }
  const onGripDown = (event: PointerEvent<HTMLButtonElement>, id: string): void => {
    grip.current = { id, startX: event.clientX, startWidth: fields.columnWidths[id] ?? 160 }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onGripMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = grip.current
    if (!active) return
    setResizing({ id: active.id, width: Math.max(80, active.startWidth + (event.clientX - active.startX)) })
  }
  const onGripUp = (): void => {
    const active = grip.current
    if (active && resizing) commitWidth(active.id, resizing.width)
    grip.current = null
    setResizing(null)
  }
  const onGripKey = (event: KeyboardEvent, id: string): void => {
    const current = fields.columnWidths[id] ?? 160
    if (event.key === 'ArrowLeft') { event.preventDefault(); commitWidth(id, current - 16) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); commitWidth(id, current + 16) }
  }
  const reorderColumn = (sourceId: string, targetId: string): void => {
    if (!canEdit || sourceId === targetId) return
    const ids = columns.map((property) => property.id).filter((id) => id !== sourceId)
    const at = ids.indexOf(targetId)
    props.onPatchFields({ visiblePropertyIds: [...ids.slice(0, at), sourceId, ...ids.slice(at)] })
  }
  const toggleGroup = (key: string): void => {
    props.onPatchFields({
      collapsedOptionIds: fields.collapsedOptionIds.includes(key)
        ? fields.collapsedOptionIds.filter((entry) => entry !== key)
        : [...fields.collapsedOptionIds, key],
    })
  }

  const cellDisplay = (card: ProjectCard, property: ProjectProperty): ReactElement | string => {
    if (property.type === 'select' && card.values[property.id]) return <OptionChip property={property} value={card.values[property.id]!} />
    if (property.type === 'multiSelect' && card.values[property.id]) {
      try {
        const ids = JSON.parse(card.values[property.id]!) as string[]
        if (Array.isArray(ids) && ids.length > 0) {
          return <span className="flex flex-wrap gap-1">{ids.map((id) => <OptionChip key={id} property={property} value={id} />)}</span>
        }
      } catch { /* a stored value that is not a JSON array reads as plain text below */ }
    }
    return projectPropertyDisplayText(card, property) || '—'
  }

  const renderRow = (card: ProjectCard, index: number, child: boolean): ReactElement => {
    const subtasks = subtasksByParent.get(card.id) ?? []
    const isOpen = expanded.has(card.id)
    const doneCount = subtasks.filter((entry) => isProjectCardDone(entry, bundle.properties)).length
    return (
      <Fragment key={card.id}>
        <tr
          data-project-card={card.id}
          data-selected={selected.includes(card.id)}
          data-child={child}
          className={rowPad}
          onContextMenu={(event) => props.onCardContextMenu(event, card)}
        >
          {canEdit && (
            <td className="w-9 px-2">
              <Checkbox
                ariaLabel={card.title || t('project.board.untitled_card')}
                checked={selected.includes(card.id)}
                onChange={(checked) => props.onSelected(checked ? [...selected, card.id] : selected.filter((id) => id !== card.id))}
              />
            </td>
          )}
          <td className="pv-table-title px-3 text-[var(--text-primary)]">
            <div className="flex items-center gap-1" style={{ paddingLeft: child ? '20px' : undefined }}>
              {!child && <span aria-hidden="true" className="w-5 shrink-0 text-right text-[length:var(--text-11)] text-[var(--text-quaternary)] tabular">{index + 1}</span>}
              {child && <CornerDownRight size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />}
              {!child && (subtasks.length > 0
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
                : <span className="w-6 shrink-0" aria-hidden="true" />)}
              <button
                type="button"
                className={`min-w-0 truncate text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${isProjectCardDone(card, bundle.properties) ? 'text-[var(--text-tertiary)] line-through' : ''}`}
                onClick={(event) => props.onSelectClick(event, card.id)}
              >
                {card.icon && <span className="mr-1" aria-hidden="true">{card.icon}</span>}
                {card.title || t('project.board.untitled_card')}
              </button>
              <CardBadges badges={props.badgesFor(card.id)} subtaskCount={subtasks.length} subtaskDone={doneCount} />
            </div>
          </td>
          {columns.map((property) => (
            <td key={property.id} className="px-3">
              {editing?.cardId === card.id && editing.propertyId === property.id
                ? (
                  <PropertyValueEditor
                    property={property}
                    card={card}
                    value={card.values[property.id] ?? ''}
                    members={bundle.members}
                    disabled={false}
                    onChange={(value) => { void props.onPatchCard(card.id, { values: { [property.id]: value } }); setEditing(null) }}
                  />
                )
                : canEdit
                  ? <button type="button" className="pv-cell-btn" onClick={() => setEditing({ cardId: card.id, propertyId: property.id })}>{cellDisplay(card, property)}</button>
                  : cellDisplay(card, property)}
            </td>
          ))}
          {canEdit && (
            <td className="w-10 px-2">
              <IconButton label={t('project.board.delete_card')} size="sm" onClick={() => props.onDeleteCard(card.id)}>
                <Trash2 size={14} />
              </IconButton>
            </td>
          )}
        </tr>
        {isOpen && subtasks.map((subtask) => renderRow(subtask, index, true))}
      </Fragment>
    )
  }
  const span = columns.length + 1 + (canEdit ? 2 : 0)
  return (
    <div className="pv-table-wrap pv-scroll" data-table="">
      <table className="pv-table">
        <thead>
          <tr>
            {canEdit && (
              <th scope="col" className="w-9 px-2">
                <Checkbox
                  ariaLabel={t('project.view.select_all')}
                  checked={cards.length > 0 && cards.every((card) => selected.includes(card.id))}
                  onChange={(checked) => props.onSelected(checked ? cards.map((card) => card.id) : [])}
                />
              </th>
            )}
            <th scope="col" className="pv-table-title px-3">{t('project.board.title_column')}</th>
            {columns.map((property) => (
              <th
                key={property.id}
                scope="col"
                className="relative px-3"
                style={{ width: resizing?.id === property.id ? resizing.width : fields.columnWidths[property.id] }}
                draggable={canEdit}
                onDragStart={(event) => { event.dataTransfer.setData('text/plain', property.id) }}
                onDragOver={(event) => { if (canEdit) event.preventDefault() }}
                onDrop={(event) => {
                  if (!canEdit) return
                  event.preventDefault()
                  const source = event.dataTransfer.getData('text/plain')
                  if (source) reorderColumn(source, property.id)
                }}
              >
                {property.name}
                {canEdit && (
                  <button
                    type="button"
                    role="separator"
                    aria-orientation="vertical"
                    aria-valuenow={resizing?.id === property.id ? resizing.width : (fields.columnWidths[property.id] ?? 160)}
                    aria-valuemin={80}
                    aria-valuemax={640}
                    aria-label={t('project.view.resize_column')}
                    className="pv-table-grip"
                    onKeyDown={(event) => onGripKey(event, property.id)}
                    onPointerDown={(event) => onGripDown(event, property.id)}
                    onPointerMove={onGripMove}
                    onPointerUp={onGripUp}
                  />
                )}
              </th>
            ))}
            {canEdit && <th scope="col" className="w-10 px-2"><span className="sr-only">{t('project.board.delete_card')}</span></th>}
          </tr>
        </thead>
        {groups.map(([key, groupCards]) => {
          const ids = new Set(groupCards.map((card) => card.id))
          const roots = groupCards.filter((card) => !card.parentId || !ids.has(card.parentId) || !allIds.has(card.parentId))
          return (
            <tbody key={key || 'all'}>
              {fields.groupById && (
                <tr className="pv-table-group">
                  <td colSpan={span}>
                    <button
                      type="button"
                      className="flex items-center gap-1 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                      aria-expanded={!fields.collapsedOptionIds.includes(key)}
                      onClick={() => toggleGroup(key)}
                    >
                      {fields.collapsedOptionIds.includes(key) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      {key === '' ? t('project.view.no_value') : projectOptionLabel(bundle.properties.find((property) => property.id === fields.groupById)!, key)}
                      <span className="pv-head-count">{groupCards.length}</span>
                    </button>
                  </td>
                </tr>
              )}
              {!fields.collapsedOptionIds.includes(key) && roots.map((card, index) => renderRow(card, index, false))}
            </tbody>
          )
        })}
        {canEdit && (
          <tbody>
            <tr>
              <td colSpan={span} className="px-2 py-1">
                <QuickAdd label={t('project.view.add_row')} onAdd={(title) => props.onAddCard(title, '')} />
              </td>
            </tr>
          </tbody>
        )}
        {cards.length > limit && (
          <tbody>
            <tr>
              <td colSpan={span} className="px-3 py-2">
                <Button size="sm" variant="ghost" onClick={() => setLimit((current) => current + PAGE)}>
                  {t('project.view.show_more', { count: cards.length - limit })}
                </Button>
              </td>
            </tr>
          </tbody>
        )}
        <tfoot>
          <tr className="pv-table-foot">
            {canEdit && <td />}
            <td className="pv-table-title px-3">{t('project.view.summary')}</td>
            {columns.map((property) => {
              const calc = fields.columnCalculations[property.id] ?? 'count'
              return (
                <td key={property.id} className="px-3">
                  <span className="mr-2 font-semibold text-[var(--text-primary)]">{computeProjectCalculation(cards, property, calc)}</span>
                  <SelectMenu
                    className="w-24"
                    size="sm"
                    value={calc}
                    label={property.name}
                    disabled={!canEdit}
                    onChange={(value) => props.onPatchFields({ columnCalculations: { ...fields.columnCalculations, [property.id]: value as ProjectCalculation } })}
                    options={calculationOptionsFor(property).map((option) => ({ value: option, label: t(`project.calc.${option.toLowerCase()}` as Parameters<typeof t>[0]) }))}
                  />
                </td>
              )
            })}
            {canEdit && <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
