/**
 * The board shell: the tab strip, the controls every view shares, and the one view that is active.
 *
 * Filtering, sorting and searching happen here once, so every view receives the same cards and a
 * reader who switches tabs is looking at the same set. What a view does with them — columns, cells,
 * bars, tiles — is the view's own business.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { ArrowUpDown, BarChart3, Calendar, CalendarRange, CheckSquare, Clock, Copy, Download, Eye, FileText, Filter, FolderOpen, LayoutDashboard, LayoutGrid, Link2, List, ListTodo, MoreHorizontal, Pencil, Plus, RotateCcw, SlidersHorizontal, SquareKanban, Table, Trash2, type LucideIcon } from 'lucide-react'
import type { ProjectBoardBundle, ProjectCard, ProjectCardLink, ProjectProperty, ProjectViewFields, ProjectViewPatch, ProjectViewType } from '@shared/project/model'
import { emptyProjectViewFields, isProjectCardDone, projectViewPropertyId, PROJECT_PROPERTY_CAPABILITIES } from '@shared/project/model'
import { projectCardBadges, type ProjectCardBadges } from '@shared/project/badges'
import { matchProjectFilterGroup, matchProjectViewSearch, orderProjectCards, sortProjectCards, sortProjectViewsAlphabetically } from '@shared/project/view-eval'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { Menu, prompt, submenuFor, type MenuItem } from '../../components/overlay'
import { PropertiesModal, SortModal } from './ViewSettingsModals'
import { FilterModal } from './FilterEditor'
import { optionDot } from './CardBadges'
import { batchDeleteProjectBoard, batchPatchProjectBoard, createProjectCard, duplicateProjectCard, fetchBoardLinks, projectBoardExportUrl, projectFileUrl } from './api'
import { KanbanView } from './views/KanbanView'
import { TableView } from './views/TableView'
import { GalleryView } from './views/GalleryView'
import { CalendarView } from './views/CalendarView'
import { ListView } from './views/ListView'
import { TimelineView } from './views/TimelineView'
import { GanttView } from './views/GanttView'
import { ChartView } from './views/ChartView'
import { DashboardView } from './views/DashboardView'
import { CollectionView } from './views/CollectionView'
import { ViewEmpty } from './views/shell'

const VIEW_LABEL: Record<string, Parameters<typeof t>[0]> = {
  board: 'project.view.board',
  table: 'project.view.table',
  gallery: 'project.view.gallery',
  calendar: 'project.view.calendar',
  list: 'project.view.list',
  timeline: 'project.view.timeline',
  gantt: 'project.view.gantt',
  chart: 'project.view.chart',
  dashboard: 'project.view.dashboard',
  collection: 'project.view.collection',
}

const VIEW_ICON: Record<string, LucideIcon> = {
  board: SquareKanban,
  table: Table,
  gallery: LayoutGrid,
  calendar: Calendar,
  list: List,
  timeline: Clock,
  gantt: CalendarRange,
  chart: BarChart3,
  dashboard: LayoutDashboard,
  collection: FolderOpen,
}

// Templates ship canonical English titles; treat them as defaults so a zh UI localizes them
// instead of mixing languages. A title the user actually typed is kept verbatim.
const VIEW_DEFAULT_TITLE: Record<string, string> = {
  board: 'Board', table: 'Table', gallery: 'Gallery', calendar: 'Calendar', list: 'List',
  timeline: 'Timeline', gantt: 'Gantt', chart: 'Chart', dashboard: 'Dashboard', collection: 'Collection',
}

function viewTabLabel(view: { title: string, viewType: string }): string {
  const localized = t(VIEW_LABEL[view.viewType] ?? 'project.view.table')
  return !view.title || view.title === VIEW_DEFAULT_TITLE[view.viewType] ? localized : view.title
}

// These surfaces carry their own "add the first card" affordance, so an empty board must still draw
// them: replacing them with a blank state leaves a new board with no way to start from that tab.
const EMPTY_CAPABLE_VIEWS = new Set(['board', 'gallery', 'list', 'calendar', 'chart', 'collection'])

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
  onRenameGroupOption: (propertyId: string, optionId: string, value: string) => Promise<void>
  onRefresh: () => Promise<void>
  /** A public reader has no session: the member-only reads and exports would answer 401, so they are not offered. */
  publicView?: boolean
}

export function BoardViews({ bundle, canEdit, onDeleteCard, onCreateView, onOpenCard, onPatchView, onDeleteView, onDuplicateView, onActiveViewChange, onPatchCard, onAddGroupOption, onRenameGroupOption, onRefresh, publicView = false }: BoardViewsProps): ReactElement {
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
  const [selected, setSelected] = useState<string[]>([])
  const [batchPropertyId, setBatchPropertyId] = useState('')
  const [batchValue, setBatchValue] = useState('')
  const [contextPoint, setContextPoint] = useState<{ x: number, y: number } | null>(null)
  const [contextItems, setContextItems] = useState<MenuItem[]>([])
  const lastIndex = useRef<number | null>(null)

  useEffect(() => {
    if (publicView) return
    const controller = new AbortController()
    fetchBoardLinks(bundle.board.id, controller.signal).then(setLinks).catch(() => { if (!controller.signal.aborted) setLinks([]) })
    return () => controller.abort()
  }, [bundle.board.id, publicView])

  // C-23: tabs read alphabetically; the default view stays the board's first by position.
  const orderedViews = sortProjectViewsAlphabetically(bundle.views)
  const active = orderedViews.find((view) => view.id === activeId) ?? bundle.views[0] ?? null
  const fields = active?.fields ?? emptyProjectViewFields()
  const viewType = active?.viewType ?? 'table'
  useEffect(() => { onActiveViewChange(active?.id ?? '') }, [active?.id, onActiveViewChange])

  const patchFields = (patch: Partial<ProjectViewFields>): void => {
    if (active) void onPatchView(active.id, { fields: patch })
  }
  const filtered = useMemo(
    () => bundle.cards.filter((card) => matchProjectFilterGroup(card, fields.filter, bundle.properties) && matchProjectViewSearch(card, search, bundle.properties)),
    [bundle.cards, fields.filter, bundle.properties, search],
  )
  const sorted = useMemo(() => sortProjectCards(filtered, fields.sortOptions, bundle.properties), [filtered, fields.sortOptions, bundle.properties])
  // The board and the list are manual surfaces: a card the reader dropped stays where it was dropped.
  const cards = useMemo(
    () => (viewType === 'board' || viewType === 'list' ? orderProjectCards(sorted, fields.cardOrder) : sorted),
    [sorted, fields.cardOrder, viewType],
  )

  const badgesByCard = useMemo(() => {
    const contentsByCard = new Map<string, typeof bundle.contents>()
    for (const block of bundle.contents) {
      const list = contentsByCard.get(block.cardId)
      if (list) list.push(block)
      else contentsByCard.set(block.cardId, [block])
    }
    const commentsByCard = new Map<string, typeof bundle.comments>()
    for (const comment of bundle.comments) {
      const list = commentsByCard.get(comment.cardId)
      if (list) list.push(comment)
      else commentsByCard.set(comment.cardId, [comment])
    }
    const byCard = new Map<string, ProjectCardBadges>()
    for (const card of bundle.cards) {
      byCard.set(card.id, projectCardBadges(contentsByCard.get(card.id) ?? [], commentsByCard.get(card.id) ?? []))
    }
    return byCard
  }, [bundle.cards, bundle.contents, bundle.comments])

  const coverByCard = useMemo(() => {
    const map = new Map<string, string>()
    for (const block of bundle.contents) {
      if (block.type === 'image' && block.fields.attachmentId && !map.has(block.cardId)) map.set(block.cardId, projectFileUrl(block.fields.attachmentId))
    }
    return map
  }, [bundle.contents])

  const descriptionByCard = useMemo(() => {
    const map = new Map<string, string>()
    for (const block of bundle.contents) {
      if (block.type === 'text' && block.title.trim() && !map.has(block.cardId)) map.set(block.cardId, block.title.trim())
    }
    return map
  }, [bundle.contents])

  const subtasksByParent = useMemo(() => {
    const map = new Map<string, ProjectCard[]>()
    for (const card of bundle.cards) {
      if (!card.parentId) continue
      const list = map.get(card.parentId)
      if (list) list.push(card)
      else map.set(card.parentId, [card])
    }
    return map
  }, [bundle.cards])

  const badgesFor = (cardId: string): ProjectCardBadges => badgesByCard.get(cardId) ?? { description: false, comments: 0, checked: 0, checkboxes: 0 }
  const coverFor = publicView ? undefined : (cardId: string): string | null => coverByCard.get(cardId) ?? null

  const doneLabel = t('project.card.done_label').toLowerCase()
  const toggleCardDone = async (card: ProjectCard, checked: boolean): Promise<void> => {
    const statusProperty = bundle.properties.find((property) => property.type === 'select')
    if (statusProperty && statusProperty.options.length > 0) {
      const doneOption = statusProperty.options.find((entry) => {
        const value = entry.value.toLowerCase()
        return value === doneLabel || /done|complete|finished/i.test(value)
      })
      const todoOption = statusProperty.options.find((entry) => entry !== doneOption) ?? statusProperty.options[0]
      await onPatchCard(card.id, { values: { [statusProperty.id]: checked ? (doneOption?.id ?? null) : (todoOption?.id ?? null) } })
      return
    }
    const checkboxProperty = bundle.properties.find((property) => property.type === 'checkbox')
    if (checkboxProperty) await onPatchCard(card.id, { values: { [checkboxProperty.id]: checked ? 'true' : 'false' } })
  }

  const handleAddSubtask = async (parentCardId: string): Promise<void> => {
    const name = await prompt({ title: t('project.card.add_subtask'), confirmLabel: t('project.card.add_subtask') })
    if (name === null || !name.trim()) return
    await createProjectCard(bundle.board.id, { title: name.trim(), parentId: parentCardId })
    await onRefresh()
  }

  const addCardInColumn = async (title: string, optionId: string): Promise<void> => {
    const values = fields.groupById && optionId ? { [fields.groupById]: optionId } : {}
    await createProjectCard(bundle.board.id, { title, values })
    await onRefresh()
  }

  const handleCopyLink = async (cardId: string): Promise<void> => {
    const url = `${window.location.origin}/project/boards/${encodeURIComponent(bundle.board.id)}?card=${encodeURIComponent(cardId)}`
    try {
      await navigator.clipboard.writeText(url)
      useUi.getState().toast({ title: t('common.copied') })
    } catch {
      useUi.getState().toast({ title: t('project.card.copy_link_failed'), tone: 'danger' })
    }
  }

  const buildCardContextMenu = (card: ProjectCard): MenuItem[] => {
    const isDone = isProjectCardDone(card, bundle.properties)
    const groupProperty = bundle.properties.find((property) => property.id === fields.groupById)
    const items: MenuItem[] = [
      { id: 'open', label: t('project.card.open'), icon: <FileText size={14} />, onSelect: () => onOpenCard(card.id) },
      { id: 'toggle-done', label: isDone ? t('project.card.mark_undone') : t('project.card.mark_done'), icon: <CheckSquare size={14} />, disabled: !canEdit, onSelect: () => { void toggleCardDone(card, !isDone) } },
      { id: 'add-subtask', label: t('project.card.add_subtask'), icon: <ListTodo size={14} />, disabled: !canEdit, onSelect: () => { void handleAddSubtask(card.id) } },
    ]
    if (groupProperty && canEdit && groupProperty.options.length > 0) {
      const moveOptions: MenuItem[] = groupProperty.options.map((option) => ({
        id: `opt-${option.id}`,
        label: option.value,
        onSelect: () => { void onPatchCard(card.id, { values: { [groupProperty.id]: option.id } }) },
      }))
      items.push({ id: 'move-group', label: t('project.card.move_to_column'), icon: <SlidersHorizontal size={14} />, subItems: moveOptions, submenu: submenuFor(moveOptions) })
    }
    items.push({ id: 'duplicate', label: t('project.card.duplicate'), icon: <Copy size={14} />, separatorBefore: true, disabled: !canEdit, onSelect: () => { void duplicateProjectCard(card.id).then(onRefresh) } })
    items.push({ id: 'copy-link', label: t('project.card.copy_link'), icon: <Link2 size={14} />, disabled: publicView, onSelect: () => { void handleCopyLink(card.id) } })
    items.push({ id: 'delete', label: t('project.board.delete_card'), icon: <Trash2 size={14} />, separatorBefore: true, tone: 'danger', disabled: !canEdit, onSelect: () => onDeleteCard(card.id) })
    return items
  }

  const onCardContextMenu = (event: MouseEvent, card: ProjectCard): void => {
    event.preventDefault()
    event.stopPropagation()
    setContextItems(buildCardContextMenu(card))
    setContextPoint({ x: event.clientX, y: event.clientY })
  }

  const selectClick = (event: MouseEvent, cardId: string): void => {
    const ids = cards.map((card) => card.id)
    const index = ids.indexOf(cardId)
    if (event.shiftKey && lastIndex.current !== null) {
      const [a, b] = [lastIndex.current, index].sort((x, y) => x - y)
      setSelected(ids.slice(a, b + 1))
      return
    }
    if (event.ctrlKey || event.metaKey) {
      lastIndex.current = index
      setSelected((current) => (current.includes(cardId) ? current.filter((id) => id !== cardId) : [...current, cardId]))
      return
    }
    lastIndex.current = index
    setSelected([])
    onOpenCard(cardId)
  }

  const batchDelete = async (): Promise<void> => {
    await batchDeleteProjectBoard(bundle.board.id, { cardIds: selected })
    setSelected([])
    await onRefresh()
  }
  const batchApply = async (): Promise<void> => {
    if (!batchPropertyId) return
    await batchPatchProjectBoard(bundle.board.id, { cards: selected.map((id) => ({ id, patch: { values: { [batchPropertyId]: batchValue || null } } })) })
    setSelected([])
    await onRefresh()
  }
  const batchProperties = bundle.properties.filter((property) => property.type === 'select')
  const batchProperty = batchProperties.find((property) => property.id === batchPropertyId)

  const hiddenCount = bundle.cards.length - filtered.length
  const columns = fields.visiblePropertyIds.length
    ? fields.visiblePropertyIds.map((id) => bundle.properties.find((property) => property.id === id)).filter((property): property is ProjectProperty => Boolean(property))
    : bundle.properties
  const groupable = bundle.properties.filter((property) => PROJECT_PROPERTY_CAPABILITIES[property.type].canGroup)
  const dateProperties = bundle.properties.filter((property) => property.type === 'date')
  const showsDateDisplay = viewType === 'calendar' || viewType === 'timeline' || viewType === 'gantt' || viewType === 'dashboard'
  const showsGroupBy = viewType === 'board' || viewType === 'table' || viewType === 'gallery' || viewType === 'list'
  const density = fields.cardSize ?? 'comfortable'

  const renameView = (): void => {
    if (!active) return
    void prompt({ title: t('project.view.rename'), defaultValue: active.title, confirmLabel: t('common.save') }).then((name) => {
      if (name !== null) void onPatchView(active.id, { title: name.trim() })
    })
  }
  const viewMenu: MenuItem[] = active ? [
    { id: 'rename', label: t('project.view.rename'), icon: <Pencil size={15} />, disabled: !canEdit, onSelect: renameView },
    { id: 'duplicate', label: t('project.view.duplicate'), icon: <Copy size={15} />, disabled: !canEdit, onSelect: () => onDuplicateView(active.id) },
    { id: 'delete', label: t('project.view.delete'), icon: <Trash2 size={15} />, tone: 'danger', disabled: !canEdit || bundle.views.length <= 1, onSelect: () => onDeleteView(active.id) },
    ...(fields.cardOrder.length > 0 ? [{ id: 'reset-order', label: t('project.view.reset_order'), icon: <RotateCcw size={15} />, separatorBefore: true, disabled: !canEdit, onSelect: () => patchFields({ cardOrder: [] }) }] : []),
    { id: 'export-csv', label: t('project.view.export_csv'), icon: <Download size={15} />, separatorBefore: true, onSelect: () => { window.open(projectBoardExportUrl(bundle.board.id, 'csv'), '_blank') } },
    { id: 'export-archive', label: t('project.view.export_archive'), icon: <Download size={15} />, onSelect: () => { window.open(projectBoardExportUrl(bundle.board.id, 'archive'), '_blank') } },
  ] : []

  const kanbanProps = {
    properties: bundle.properties,
    fields,
    badgesFor,
    coverFor,
    subtasksByParent,
    canEdit,
    selected,
    onSelectClick: selectClick,
    onOpenCard,
    onDeleteCard,
    onPatchCard,
    onPatchFields: patchFields,
    onAddCard: addCardInColumn,
    onAddGroupOption,
    onRenameGroupOption,
    onCardContextMenu,
    onToggleCardDone: toggleCardDone,
    onAddSubtask: handleAddSubtask,
  }

  const renderView = (): ReactElement => {
    if (!active) return <ViewEmpty title={t('project.board.empty_cards')} />
    switch (viewType) {
      case 'collection':
        return <CollectionView boardId={bundle.board.id} canEdit={canEdit} onOpenCard={onOpenCard} />
      case 'dashboard':
        return <DashboardView boardId={bundle.board.id} cards={cards} properties={bundle.properties} datePropertyId={projectViewPropertyId(fields.dateDisplayPropertyId)} onOpenCard={onOpenCard} />
      case 'chart':
        return <ChartView cards={cards} properties={bundle.properties} fields={fields} canEdit={canEdit} onPatchFields={patchFields} />
      case 'calendar':
        return (
          <CalendarView
            cards={cards}
            boardId={bundle.board.id}
            properties={bundle.properties}
            datePropertyId={projectViewPropertyId(fields.dateDisplayPropertyId)}
            mode={fields.calendarMode ?? 'month'}
            onModeChange={(mode) => patchFields({ calendarMode: mode })}
            canEdit={canEdit}
            onOpenCard={onOpenCard}
            onPatchCard={onPatchCard}
            onRefresh={onRefresh}
            descriptionFor={(cardId) => descriptionByCard.get(cardId) ?? ''}
          />
        )
      case 'timeline':
        return <TimelineView cards={cards} properties={bundle.properties} links={links} fields={fields} subtasksByParent={subtasksByParent} canEdit={canEdit} onOpenCard={onOpenCard} onPatchFields={patchFields} />
      case 'gantt':
        return <GanttView cards={cards} boardId={bundle.board.id} properties={bundle.properties} links={links} fields={fields} subtasksByParent={subtasksByParent} canEdit={canEdit} onOpenCard={onOpenCard} onPatchCard={onPatchCard} onPatchFields={patchFields} onRefresh={onRefresh} />
      case 'gallery':
        return <GalleryView cards={cards} properties={bundle.properties} chipProperties={columns} fields={fields} badgesFor={badgesFor} coverFor={coverFor} canEdit={canEdit} onOpenCard={onOpenCard} onCardContextMenu={onCardContextMenu} onPatchFields={patchFields} onAddCard={addCardInColumn} />
      case 'list':
        return <ListView cards={cards} properties={bundle.properties} fields={fields} canEdit={canEdit} badgesFor={badgesFor} onOpenCard={onOpenCard} onCardContextMenu={onCardContextMenu} onAddSubtask={handleAddSubtask} onToggleCardDone={toggleCardDone} onDeleteCard={onDeleteCard} onPatchCard={onPatchCard} onPatchFields={patchFields} onAddCard={addCardInColumn} />
      case 'board':
        return fields.swimlaneBy
          ? <Swimlanes cards={cards} properties={bundle.properties} fields={fields} kanbanProps={kanbanProps} />
          : <KanbanView cards={cards} {...kanbanProps} />
      default:
        return (
          <TableView
            bundle={bundle}
            cards={cards}
            columns={columns}
            fields={fields}
            canEdit={canEdit}
            selected={selected}
            onSelected={setSelected}
            subtasksByParent={subtasksByParent}
            badgesFor={badgesFor}
            onSelectClick={selectClick}
            onDeleteCard={onDeleteCard}
            onPatchCard={onPatchCard}
            onPatchFields={patchFields}
            onAddCard={addCardInColumn}
            onCardContextMenu={onCardContextMenu}
          />
        )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)] px-3 py-1.5" role="tablist" aria-label={t('project.view.add')}>
        {orderedViews.map((view) => {
          const TabIcon = VIEW_ICON[view.viewType] ?? Table
          return (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={active?.id === view.id}
              className={`shrink-0 whitespace-nowrap rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-12)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${active?.id === view.id ? 'bg-[var(--bg-hover)] font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
              onClick={() => selectView(view.id)}
            >
              <span className="flex items-center gap-1.5">
                <TabIcon size={14} aria-hidden="true" />
                {viewTabLabel(view)}
              </span>
            </button>
          )
        })}
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
              items={(Object.keys(VIEW_LABEL) as ProjectViewType[]).map((type) => ({
                id: type,
                label: t(VIEW_LABEL[type]!),
                icon: (() => { const Icon = VIEW_ICON[type] ?? Table; return <Icon size={14} /> })(),
                onSelect: () => onCreateView(type),
              }))}
            />
          </>
        )}
        {active && !publicView && (
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
            <SelectMenu
              className="w-40"
              size="sm"
              value={fields.dateDisplayPropertyId ?? ''}
              label={t('project.view.display_by')}
              disabled={!canEdit}
              onChange={(value) => patchFields({ dateDisplayPropertyId: value })}
              options={[{ value: '', label: t('project.view.display_by') }, ...dateProperties.map((property) => ({ value: property.id, label: property.name }))]}
            />
          )}
          {showsGroupBy && (
            <SelectMenu
              className="w-40"
              size="sm"
              value={fields.groupById ?? ''}
              label={t('project.view.group_by')}
              disabled={!canEdit}
              onChange={(value) => patchFields({ groupById: value })}
              options={[{ value: '', label: t('project.view.group_by') }, ...groupable.map((property) => ({ value: property.id, label: property.name }))]}
            />
          )}
          {viewType === 'board' && (
            <SelectMenu
              className="w-36"
              size="sm"
              value={fields.swimlaneBy ?? ''}
              label={t('project.view.swimlane')}
              disabled={!canEdit}
              onChange={(value) => patchFields({ swimlaneBy: value })}
              options={[{ value: '', label: t('project.view.swimlane') }, ...groupable.map((property) => ({ value: property.id, label: property.name }))]}
            />
          )}
          <span className="ml-auto flex items-center gap-1">
            <SelectMenu
              className="w-28"
              size="sm"
              value={density}
              label={t('project.view.density')}
              disabled={!canEdit}
              onChange={(value) => patchFields({ cardSize: value as 'compact' | 'comfortable' | 'spacious' })}
              options={[
                { value: 'compact', label: t('project.view.density_compact') },
                { value: 'comfortable', label: t('project.view.density_comfortable') },
                { value: 'spacious', label: t('project.view.density_spacious') },
              ]}
            />
            {!publicView && (
              <>
                <IconButton label={t('project.view.sort')} size="sm" onClick={() => setSettings('sort')}><ArrowUpDown size={15} /></IconButton>
                <IconButton label={t('project.view.filter')} size="sm" onClick={() => setSettings('filter')}><Filter size={15} /></IconButton>
                <IconButton label={t('project.view.properties')} size="sm" onClick={() => setSettings('properties')}><Eye size={15} /></IconButton>
              </>
            )}
          </span>
        </div>
      )}
      {hiddenCount > 0 && (
        <p className="shrink-0 px-3 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]" role="status">
          {t('project.view.hidden_count', { count: hiddenCount })}
        </p>
      )}
      {canEdit && selected.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--accent-softer)] px-3 py-1.5" role="toolbar" aria-label={t('project.view.selected_count', { count: selected.length })}>
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('project.view.selected_count', { count: selected.length })}</span>
          <Button size="sm" variant="ghost" onClick={() => void batchDelete()}>{t('project.view.delete_selected')}</Button>
          <SelectMenu className="w-32" size="sm" value={batchPropertyId} label={t('project.view.set_property')} onChange={(value) => { setBatchPropertyId(value); setBatchValue('') }} options={[{ value: '', label: t('project.view.set_property') }, ...batchProperties.map((property) => ({ value: property.id, label: property.name }))]} />
          {batchProperty && (
            <SelectMenu className="w-32" size="sm" value={batchValue} label={t('project.view.filter_value')} onChange={setBatchValue} options={[{ value: '', label: '—' }, ...batchProperty.options.map((option) => ({ value: option.id, label: option.value, icon: optionDot(option.color) }))]} />
          )}
          <Button size="sm" disabled={!batchPropertyId} onClick={() => void batchApply()}>{t('common.save')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>{t('project.view.clear_selection')}</Button>
        </div>
      )}
      {cards.length === 0 && !EMPTY_CAPABLE_VIEWS.has(viewType)
        ? <ViewEmpty title={t('project.board.empty_cards')} hint={t('project.view.empty_hint')} />
        : renderView()}
      {active && settings === 'sort' && <SortModal view={active} properties={bundle.properties} onClose={() => setSettings(null)} onPatch={(next) => onPatchView(active.id, { fields: next })} />}
      {active && settings === 'filter' && <FilterModal view={active} properties={bundle.properties} members={bundle.members} canEdit={canEdit} onClose={() => setSettings(null)} onPatch={(next) => onPatchView(active.id, { fields: next })} />}
      {active && settings === 'properties' && <PropertiesModal view={active} properties={bundle.properties} onClose={() => setSettings(null)} onPatch={(next) => onPatchView(active.id, { fields: next })} />}
      {contextPoint && <Menu anchor={contextPoint} open onClose={() => setContextPoint(null)} items={contextItems} />}
    </div>
  )
}

/** Swimlanes stack one board per option of a second property, each with its own columns. */
function Swimlanes({ cards, properties, fields, kanbanProps }: {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  fields: ProjectViewFields
  kanbanProps: Omit<Parameters<typeof KanbanView>[0], 'cards'>
}): ReactElement {
  const laneProperty = properties.find((property) => property.id === fields.swimlaneBy)
  const keys = laneProperty ? [...laneProperty.options.map((option) => option.id), ''] : ['']
  const buckets = new Map<string, ProjectCard[]>()
  for (const card of cards) {
    const key = (laneProperty ? card.values[laneProperty.id] : '') ?? ''
    const list = buckets.get(key)
    if (list) list.push(card)
    else buckets.set(key, [card])
  }
  return (
    <div className="pv-scroll min-h-0 flex-1 overflow-y-auto">
      {keys.map((key) => {
        const laneCards = buckets.get(key) ?? []
        const option = laneProperty?.options.find((entry) => entry.id === key)
        return (
          <section key={key || 'none'} className="pv-lane" data-swimlane={key}>
            <h3 className="pv-lane-head">
              <span className="min-w-0 flex-1 truncate">{option?.value ?? t('project.view.no_value')}</span>
              <span className="pv-head-count">{laneCards.length}</span>
            </h3>
            <div className="flex h-[420px]">
              <KanbanView cards={laneCards} {...kanbanProps} />
            </div>
          </section>
        )
      })}
    </div>
  )
}
