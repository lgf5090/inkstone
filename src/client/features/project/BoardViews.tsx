import { useRef, useState, useEffect, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { ArrowUpDown, Copy, Download, Eye, EyeOff, Filter, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import type { ProjectBoardBundle, ProjectCalculation, ProjectCard, ProjectCardLink, ProjectComment, ProjectContent, ProjectProperty, ProjectViewFields, ProjectViewPatch, ProjectViewType } from '@shared/project/model'
import { emptyProjectViewFields, PROJECT_PROPERTY_CAPABILITIES } from '@shared/project/model'
import { projectCardBadges } from '@shared/project/badges'
import { groupProjectCards, matchProjectFilterGroup, matchProjectViewSearch, projectOptionLabel, projectPropertyDisplayText, sortProjectCards, sortProjectViewsAlphabetically } from '@shared/project/view-eval'
import { calculationOptionsFor, computeProjectCalculation } from '@shared/project/calculations'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Input, Select } from '../../components/form'
import { Menu, prompt, type MenuItem } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { PropertiesModal, SortModal } from './ViewSettingsModals'
import { FilterModal } from './FilterEditor'
import { CalendarView, GalleryView } from './GalleryCalendar'
import { CardBadges } from './CardBadges'
import { ChartView, ListView, TimelineView } from './ExtraViews'
import { fetchBoardLinks, projectBoardExportUrl } from './api'

const VIEW_LABEL: Record<string, Parameters<typeof t>[0]> = {
  board: 'project.view.board',
  table: 'project.view.table',
  gallery: 'project.view.gallery',
  calendar: 'project.view.calendar',
  list: 'project.view.list',
  timeline: 'project.view.timeline',
  gantt: 'project.view.gantt',
  chart: 'project.view.chart',
}

const LAST_VIEW_KEY = 'inkstone.project.lastView.'

function readLastViewId(boardId: string): string | null {
  try {
    return localStorage.getItem(LAST_VIEW_KEY + boardId)
  } catch { /* storage unavailable (private mode): fall back to the first view */
    return null
  }
}

function writeLastViewId(boardId: string, viewId: string): void {
  try {
    localStorage.setItem(LAST_VIEW_KEY + boardId, viewId)
  } catch { /* best-effort: remembering the last view is optional */
  }
}

interface BoardViewsProps {
  bundle: ProjectBoardBundle
  canEdit: boolean
  onDeleteCard: (id: string) => void
  onCreateView: (type: ProjectViewType) => void
  onOpenCard: (id: string) => void
  onPatchView: (viewId: string, patch: ProjectViewPatch) => Promise<void>
  onDeleteView: (id: string) => void
  onDuplicateView: (id: string) => void
  onActiveViewChange: (id: string) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onAddGroupOption: (propertyId: string, value: string) => Promise<void>
}

export function BoardViews({ bundle, canEdit, onDeleteCard, onCreateView, onOpenCard, onPatchView, onDeleteView, onDuplicateView, onActiveViewChange, onPatchCard, onAddGroupOption }: BoardViewsProps): ReactElement {
  const [activeId, setActiveId] = useState<string | null>(() => readLastViewId(bundle.board.id))
  useEffect(() => { setActiveId(readLastViewId(bundle.board.id)) }, [bundle.board.id])
  const selectView = (id: string): void => {
    setActiveId(id)
    writeLastViewId(bundle.board.id, id)
  }
  const addAnchor = useRef<HTMLButtonElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const viewAnchor = useRef<HTMLButtonElement>(null)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [settings, setSettings] = useState<'sort' | 'filter' | 'properties' | null>(null)
  const [search, setSearch] = useState('')
  const [links, setLinks] = useState<ProjectCardLink[]>([])
  useEffect(() => {
    const controller = new AbortController()
    fetchBoardLinks(bundle.board.id, controller.signal).then(setLinks).catch(() => { if (!controller.signal.aborted) setLinks([]) })
    return () => controller.abort()
  }, [bundle.board.id])
  // C-23: tabs read alphabetically; the default view stays the board's first by position.
  const orderedViews = sortProjectViewsAlphabetically(bundle.views)
  const active = orderedViews.find((view) => view.id === activeId) ?? bundle.views[0] ?? null
  const fields = active?.fields ?? emptyProjectViewFields()
  const viewType = active?.viewType ?? 'table'
  useEffect(() => { onActiveViewChange(active?.id ?? '') }, [active?.id, onActiveViewChange])
  const filtered = bundle.cards.filter((card) => matchProjectFilterGroup(card, fields.filter, bundle.properties) && matchProjectViewSearch(card, search, bundle.properties))
  const sorted = sortProjectCards(filtered, fields.sortOptions, bundle.properties)
  const hiddenCount = bundle.cards.length - filtered.length
  const [resizing, setResizing] = useState<{ id: string, width: number } | null>(null)
  const dragRef = useRef<{ id: string, startX: number, startWidth: number } | null>(null)
  const commitWidth = (id: string, width: number) => {
    if (active) void onPatchView(active.id, { fields: { columnWidths: { ...fields.columnWidths, [id]: Math.max(80, Math.round(width)) } } })
  }
  const onGripKey = (event: KeyboardEvent, id: string) => {
    const current = fields.columnWidths[id] ?? 160
    if (event.key === 'ArrowLeft') { event.preventDefault(); commitWidth(id, current - 16) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); commitWidth(id, current + 16) }
  }
  const onGripDown = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    dragRef.current = { id, startX: event.clientX, startWidth: fields.columnWidths[id] ?? 160 }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onGripMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setResizing({ id: drag.id, width: Math.max(80, drag.startWidth + (event.clientX - drag.startX)) })
  }
  const onGripUp = () => {
    const drag = dragRef.current
    if (drag && resizing) commitWidth(drag.id, resizing.width)
    dragRef.current = null
    setResizing(null)
  }
  const density = fields.cardSize ?? 'comfortable'
  const rowPad = density === 'compact' ? 'py-0.5' : density === 'spacious' ? 'py-3' : 'py-2'
  const columns = fields.visiblePropertyIds.length
    ? fields.visiblePropertyIds.map((id) => bundle.properties.find((p) => p.id === id)).filter((p): p is ProjectProperty => Boolean(p))
    : bundle.properties
  const groupable = bundle.properties.filter((property) => PROJECT_PROPERTY_CAPABILITIES[property.type].canGroup)
  const dateProperties = bundle.properties.filter((property) => property.type === 'date')
  const showsDateDisplay = viewType === 'calendar' || viewType === 'timeline' || viewType === 'gantt'

  const renameView = () => {
    if (!active) return
    void prompt({ title: t('project.view.rename'), defaultValue: active.title, confirmLabel: t('common.save') }).then((name) => {
      if (name !== null) void onPatchView(active.id, { title: name.trim() })
    })
  }
  const viewMenu: MenuItem[] = active ? [
    { id: 'rename', label: t('project.view.rename'), icon: <Pencil size={15} />, disabled: !canEdit, onSelect: renameView },
    { id: 'duplicate', label: t('project.view.duplicate'), icon: <Copy size={15} />, disabled: !canEdit, onSelect: () => onDuplicateView(active.id) },
    { id: 'delete', label: t('project.view.delete'), icon: <Trash2 size={15} />, tone: 'danger', disabled: !canEdit || bundle.views.length <= 1, onSelect: () => onDeleteView(active.id) },
    { id: 'export-csv', label: t('project.view.export_csv'), icon: <Download size={15} />, separatorBefore: true, onSelect: () => { window.open(projectBoardExportUrl(bundle.board.id, 'csv'), '_blank') } },
    { id: 'export-archive', label: t('project.view.export_archive'), icon: <Download size={15} />, onSelect: () => { window.open(projectBoardExportUrl(bundle.board.id, 'archive'), '_blank') } },
  ] : []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)] px-3 py-1.5" role="tablist" aria-label={t('project.view.add')}>
        {orderedViews.map((view) => (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={active?.id === view.id}
            className={`shrink-0 whitespace-nowrap rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-12)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${active?.id === view.id ? 'bg-[var(--bg-hover)] font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
            onClick={() => selectView(view.id)}
          >
            {view.title || t(VIEW_LABEL[view.viewType] ?? 'project.view.table')}
          </button>
        ))}
        {canEdit && (
          <>
            <IconButton ref={addAnchor} label={t('project.view.add')} size="sm" onClick={() => setAddOpen(true)}>
              <Plus size={15} />
            </IconButton>
            <Menu
              anchor={addAnchor}
              open={addOpen}
              onClose={() => setAddOpen(false)}
              label={t('project.view.add')}
              items={([['table', 'project.view.table'], ['board', 'project.view.board'], ['gallery', 'project.view.gallery'], ['calendar', 'project.view.calendar'], ['list', 'project.view.list'], ['timeline', 'project.view.timeline'], ['gantt', 'project.view.gantt'], ['chart', 'project.view.chart']] as const).map(([type, key]) => ({
                id: type,
                label: t(key),
                onSelect: () => onCreateView(type),
              })) as MenuItem[]}
            />
          </>
        )}
        {active && (
          <>
            <IconButton ref={viewAnchor} label={t('project.view.menu')} size="sm" onClick={() => setViewMenuOpen(true)}>
              <MoreHorizontal size={15} />
            </IconButton>
            <Menu anchor={viewAnchor} open={viewMenuOpen} onClose={() => setViewMenuOpen(false)} items={viewMenu} align="end" label={t('project.view.menu')} />
          </>
        )}
      </div>
      {active && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
          <Input
            className="w-44 min-w-0"
            value={search}
            placeholder={t('project.view.search')}
            aria-label={t('project.view.search')}
            onChange={(event) => setSearch(event.target.value)}
          />
          {showsDateDisplay && (
            <Select
              className="w-36"
              value={fields.dateDisplayPropertyId ?? ''}
              aria-label={t('project.view.display_by')}
              disabled={!canEdit}
              onChange={(event) => onPatchView(active.id, { fields: { dateDisplayPropertyId: event.target.value || undefined } })}
            >
              <option value="">{t('project.view.display_by')}</option>
              {dateProperties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
            </Select>
          )}
          {(viewType === 'board' || viewType === 'table') && (
            <Select
              className="w-36"
              value={fields.groupById ?? ''}
              aria-label={t('project.view.group_by')}
              disabled={!canEdit}
              onChange={(event) => onPatchView(active.id, { fields: { groupById: event.target.value || undefined } })}
            >
              <option value="">{t('project.view.group_by')}</option>
              {groupable.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
            </Select>
          )}
          {viewType === 'board' && (
            <Select
              className="w-32"
              value={fields.swimlaneBy ?? ''}
              aria-label={t('project.view.swimlane')}
              disabled={!canEdit}
              onChange={(event) => onPatchView(active.id, { fields: { swimlaneBy: event.target.value || undefined } })}
            >
              <option value="">{t('project.view.swimlane')}</option>
              {groupable.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
            </Select>
          )}
          <span className="ml-auto flex items-center gap-1">
            <Select
              className="w-28"
              value={density}
              aria-label={t('project.view.density')}
              disabled={!canEdit}
              onChange={(event) => onPatchView(active.id, { fields: { cardSize: event.target.value as 'compact' | 'comfortable' | 'spacious' } })}
            >
              <option value="compact">{t('project.view.density_compact')}</option>
              <option value="comfortable">{t('project.view.density_comfortable')}</option>
              <option value="spacious">{t('project.view.density_spacious')}</option>
            </Select>
            <IconButton label={t('project.view.sort')} size="sm" onClick={() => setSettings('sort')}><ArrowUpDown size={15} /></IconButton>
            <IconButton label={t('project.view.filter')} size="sm" onClick={() => setSettings('filter')}><Filter size={15} /></IconButton>
            <IconButton label={t('project.view.properties')} size="sm" onClick={() => setSettings('properties')}><Eye size={15} /></IconButton>
          </span>
        </div>
      )}
      {hiddenCount > 0 && (
        <p className="shrink-0 px-3 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]" role="status">
          {t('project.view.hidden_count', { count: hiddenCount })}
        </p>
      )}
      {viewType === 'calendar'
        ? <CalendarView cards={sorted} properties={bundle.properties} datePropertyId={fields.dateDisplayPropertyId} canEdit={canEdit} onOpenCard={onOpenCard} onPatchCard={onPatchCard} />
        : sorted.length === 0
          ? <Empty art="folder" title={t('project.board.empty_cards')} />
          : viewType === 'board'
            ? (fields.swimlaneBy
              ? <Swimlanes cards={sorted} fields={fields} properties={bundle.properties} contents={bundle.contents} comments={bundle.comments} canEdit={canEdit} onDeleteCard={onDeleteCard} onOpenCard={onOpenCard} density={density} onPatch={(f) => { if (active) onPatchView(active.id, { fields: f }) }} onPatchCard={onPatchCard} onAddGroupOption={onAddGroupOption} />
              : <BoardColumns cards={sorted} groupById={fields.groupById} properties={bundle.properties} contents={bundle.contents} comments={bundle.comments} canEdit={canEdit} onDeleteCard={onDeleteCard} onOpenCard={onOpenCard} fields={fields} density={density} onPatch={(f) => { if (active) onPatchView(active.id, { fields: f }) }} onPatchCard={onPatchCard} onAddGroupOption={onAddGroupOption} />)
            : viewType === 'gallery'
              ? <GalleryView cards={sorted} contents={bundle.contents} comments={bundle.comments} onOpenCard={onOpenCard} />
              : viewType === 'list'
                ? <ListView cards={sorted} properties={bundle.properties} onOpenCard={onOpenCard} />
                : viewType === 'timeline' || viewType === 'gantt'
                  ? <TimelineView cards={sorted} properties={bundle.properties} datePropertyId={fields.dateDisplayPropertyId} links={links} gantt={viewType === 'gantt'} onOpenCard={onOpenCard} />
                  : viewType === 'chart'
                    ? <ChartView cards={sorted} properties={bundle.properties} />
                    : (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full border-collapse text-[length:var(--text-13)]">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] text-left text-[length:var(--text-12)] text-[var(--text-secondary)]">
                      <th scope="col" className="px-3 py-2 font-medium">{t('project.board.title_column')}</th>
                      {columns.map((property) => (
                        <th key={property.id} scope="col" className="relative px-3 py-2 font-medium" style={{ width: resizing?.id === property.id ? resizing.width : fields.columnWidths[property.id] }}>
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
                              className="absolute right-0 top-0 h-full w-1 cursor-col-resize focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                              onKeyDown={(event) => onGripKey(event, property.id)}
                              onPointerDown={(event) => onGripDown(event, property.id)}
                              onPointerMove={onGripMove}
                              onPointerUp={onGripUp}
                            />
                          )}
                        </th>
                      ))}
                      {canEdit && <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">{t('project.board.delete_card')}</span></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((card) => (
                      <tr key={card.id} className={`border-b border-[var(--border-subtle)] ${rowPad}`} data-project-card={card.id}>
                        <td className="px-3 py-2 text-[var(--text-primary)]">
                          <button type="button" className="min-w-0 truncate text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => onOpenCard(card.id)}>
                            {card.title || t('project.board.untitled_card')}
                          </button>
                        </td>
                        {columns.map((property) => <td key={property.id} className="px-3 py-2 text-[var(--text-secondary)]">{projectPropertyDisplayText(card, property)}</td>)}
                        {canEdit && (
                          <td className="px-2 py-1">
                            <IconButton label={t('project.board.delete_card')} size="sm" onClick={() => onDeleteCard(card.id)}>
                              <Trash2 size={15} />
                            </IconButton>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  {active && (
                    <tfoot>
                      <tr className="border-t border-[var(--border-subtle)] text-[length:var(--text-12)] text-[var(--text-secondary)]">
                        <td className="px-3 py-1">{t('project.view.summary')}</td>
                        {columns.map((property) => {
                          const calc = fields.columnCalculations[property.id] ?? 'count'
                          return (
                            <td key={property.id} className="px-3 py-1">
                              <span className="mr-2">{computeProjectCalculation(sorted, property, calc)}</span>
                              <Select
                                className="w-28"
                                value={calc}
                                aria-label={property.name}
                                disabled={!canEdit}
                                onChange={(event) => onPatchView(active.id, { fields: { columnCalculations: { ...fields.columnCalculations, [property.id]: event.target.value as typeof calc } } })}
                              >
                                {calculationOptionsFor(property).map((option) => <option key={option} value={option}>{option}</option>)}
                              </Select>
                            </td>
                          )
                        })}
                        {canEdit && <td />}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
      {active && settings === 'sort' && <SortModal view={active} properties={bundle.properties} onClose={() => setSettings(null)} onPatch={(fields) => onPatchView(active.id, { fields })} />}
      {active && settings === 'filter' && <FilterModal view={active} properties={bundle.properties} members={bundle.members} canEdit={canEdit} onClose={() => setSettings(null)} onPatch={(fields) => onPatchView(active.id, { fields })} />}
      {active && settings === 'properties' && <PropertiesModal view={active} properties={bundle.properties} onClose={() => setSettings(null)} onPatch={(fields) => onPatchView(active.id, { fields })} />}
    </div>
  )
}

function BoardColumns({ cards, groupById, properties, contents, comments, canEdit, onDeleteCard, onOpenCard, fields, density, onPatch, onPatchCard, onAddGroupOption }: {
  cards: ProjectCard[]
  groupById?: string
  properties: ProjectProperty[]
  contents: ProjectContent[]
  comments: ProjectComment[]
  canEdit: boolean
  onDeleteCard: (id: string) => void
  onOpenCard: (id: string) => void
  fields: ProjectViewFields
  density: 'compact' | 'comfortable' | 'spacious'
  onPatch: (fields: Partial<ProjectViewFields>) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onAddGroupOption: (propertyId: string, value: string) => Promise<void>
}): ReactElement {
  const cardPad = density === 'compact' ? 'px-2 py-1' : density === 'spacious' ? 'px-3 py-3' : 'px-2 py-2'
  const groupProperty = properties.find((property) => property.id === groupById)
  const groups = groupProjectCards(cards, groupById, properties)
  const columnKeys = (groupProperty && groupProperty.options.length
    ? [...groupProperty.options.map((option) => option.id), '']
    : ['']).filter((key) => !fields.hiddenOptionIds.includes(key))
  const addGroup = () => {
    if (!groupProperty) return
    void prompt({ title: t('project.view.add_group'), confirmLabel: t('common.save') }).then((value) => {
      if (value !== null && value.trim()) void onAddGroupOption(groupProperty.id, value.trim())
    })
  }
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
      {columnKeys.map((key) => {
        const bucket = groups.get(key) ?? []
        const label = key === '' ? t('project.view.no_value') : projectOptionLabel(groupProperty!, key)
        const calc = fields.kanbanCalculations[key]?.calculation ?? 'count'
        const calcProperty = groupProperty ?? properties[0]
        return (
          <section
            key={key || 'empty'}
            className="flex w-64 shrink-0 flex-col rounded-[var(--r-md)] bg-[var(--bg-sunken)]"
            aria-label={label}
            onDragOver={(event) => { if (canEdit && groupProperty) event.preventDefault() }}
            onDrop={(event) => {
              if (!canEdit || !groupProperty) return
              event.preventDefault()
              const cardId = event.dataTransfer.getData('text/plain')
              if (cardId) void onPatchCard(cardId, { values: { [groupProperty.id]: key === '' ? null : key } })
            }}
          >
            <header className="flex items-center gap-2 px-3 py-2 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {canEdit && groupProperty && key !== '' && (
                <IconButton label={t('project.view.hide_column')} size="sm" onClick={() => onPatch({ hiddenOptionIds: [...fields.hiddenOptionIds, key] })}>
                  <EyeOff size={13} />
                </IconButton>
              )}
              {calcProperty && (
                <Select
                  className="w-24"
                  value={calc}
                  aria-label={label}
                  disabled={!canEdit}
                  onChange={(event) => onPatch({ kanbanCalculations: { ...fields.kanbanCalculations, [key]: { calculation: event.target.value as ProjectCalculation, propertyId: calcProperty.id } } })}
                >
                  {calculationOptionsFor(calcProperty).map((option) => <option key={option} value={option}>{option}</option>)}
                </Select>
              )}
              <span className={fields.wipLimits?.[key] !== undefined && bucket.length > fields.wipLimits[key]! ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]'}>{calcProperty ? computeProjectCalculation(bucket, calcProperty, calc) : bucket.length}</span>
              {canEdit && groupProperty && (
                <Input
                  type="number"
                  className="w-14"
                  value={fields.wipLimits?.[key] ?? ''}
                  placeholder="WIP"
                  aria-label={`${label} WIP`}
                  onChange={(event) => {
                    const raw = event.target.value
                    const next = { ...fields.wipLimits }
                    if (raw === '') delete next[key]
                    else next[key] = Number(raw)
                    onPatch({ wipLimits: next })
                  }}
                />
              )}
            </header>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {bucket.length === 0 && <li className="px-1 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.view.empty_column')}</li>}
              {bucket.map((card) => (
                <li
                  key={card.id}
                  className={`flex items-center gap-2 rounded-[var(--r-sm)] bg-[var(--bg-base)] shadow-[var(--shadow-sm)] ${cardPad}`}
                  data-project-card={card.id}
                  draggable={canEdit}
                  onDragStart={(event) => { event.dataTransfer.setData('text/plain', card.id) }}
                >
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-[length:var(--text-13)] text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => onOpenCard(card.id)}>
                    {card.title || t('project.board.untitled_card')}
                  </button>
                  <CardBadges badges={projectCardBadges(contents.filter((block) => block.cardId === card.id), comments.filter((comment) => comment.cardId === card.id))} />
                  {canEdit && (
                    <IconButton label={t('project.board.delete_card')} size="sm" onClick={() => onDeleteCard(card.id)}>
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {canEdit && groupProperty && (
        <div className="flex w-40 shrink-0 flex-col gap-2">
          <Button size="sm" icon={<Plus size={14} />} onClick={addGroup}>{t('project.view.add_group')}</Button>
          {fields.hiddenOptionIds.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => onPatch({ hiddenOptionIds: [] })}>{t('project.view.show_hidden_columns')}</Button>
          )}
        </div>
      )}
    </div>
  )
}

function Swimlanes({ cards, fields, properties, contents, comments, canEdit, onDeleteCard, onOpenCard, density, onPatch, onPatchCard, onAddGroupOption }: {
  cards: ProjectCard[]
  fields: ProjectViewFields
  properties: ProjectProperty[]
  contents: ProjectContent[]
  comments: ProjectComment[]
  canEdit: boolean
  onDeleteCard: (id: string) => void
  onOpenCard: (id: string) => void
  density: 'compact' | 'comfortable' | 'spacious'
  onPatch: (fields: Partial<ProjectViewFields>) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onAddGroupOption: (propertyId: string, value: string) => Promise<void>
}) {
  const laneProperty = properties.find((property) => property.id === fields.swimlaneBy)
  const lanes = groupProjectCards(cards, fields.swimlaneBy, properties)
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {[...lanes.entries()].map(([key, laneCards]) => (
        <section key={key || 'empty'}>
          <h3 className="mb-1 px-1 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {key === '' ? t('project.view.no_value') : laneProperty?.options.find((o) => o.id === key)?.value ?? key}
          </h3>
          <BoardColumns cards={laneCards} groupById={fields.groupById} properties={properties} contents={contents} comments={comments} canEdit={canEdit} onDeleteCard={onDeleteCard} onOpenCard={onOpenCard} fields={fields} density={density} onPatch={onPatch} onPatchCard={onPatchCard} onAddGroupOption={onAddGroupOption} />
        </section>
      ))}
    </div>
  )
}