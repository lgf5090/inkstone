import { Fragment, useRef, useState, useEffect, useMemo, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement } from 'react'
import { ArrowUpDown, BarChart3, Calendar, CalendarRange, CheckSquare, ChevronDown, ChevronRight, Clock, Copy, CornerDownRight, Download, Eye, EyeOff, FileText, Filter, FolderOpen, LayoutDashboard, LayoutGrid, Link2, List, ListTodo, MoreHorizontal, Pencil, Plus, SlidersHorizontal, SquareKanban, Table, Trash2, type LucideIcon } from 'lucide-react'
import type { ProjectBoardBundle, ProjectCalculation, ProjectCard, ProjectCardLink, ProjectProperty, ProjectViewFields, ProjectViewPatch, ProjectViewType } from '@shared/project/model'
import { emptyProjectViewFields, isProjectCardDone, PROJECT_PROPERTY_CAPABILITIES } from '@shared/project/model'
import { projectCardBadges, type ProjectCardBadges } from '@shared/project/badges'
import { groupProjectCards, matchProjectFilterGroup, matchProjectViewSearch, projectOptionLabel, projectPropertyDisplayText, sortProjectCards, sortProjectViewsAlphabetically } from '@shared/project/view-eval'
import { calculationOptionsFor, computeProjectCalculation } from '@shared/project/calculations'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { Menu, prompt, submenuFor, type MenuItem } from '../../components/overlay'
import { Empty } from '../../components/feedback'
import { PropertiesModal, SortModal } from './ViewSettingsModals'
import { FilterModal } from './FilterEditor'
import { PropertyValueEditor } from './PropertyValueEditor'
import { CalendarView, GalleryView } from './GalleryCalendar'
import { CardBadges, CardPropertyChips, OptionChip, optionDot } from './CardBadges'
import { ChartView, ListView, TimelineView } from './ExtraViews'
import { CollectionView, DashboardView } from './BoardInsights'
import { batchDeleteProjectBoard, batchPatchProjectBoard, createProjectCard, duplicateProjectCard, fetchBoardLinks, projectBoardExportUrl, projectFileUrl } from './api'

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
  board: 'Board',
  table: 'Table',
  gallery: 'Gallery',
  calendar: 'Calendar',
  list: 'List',
  timeline: 'Timeline',
  gantt: 'Gantt',
  chart: 'Chart',
  dashboard: 'Dashboard',
  collection: 'Collection',
}

function viewTabLabel(view: { title: string, viewType: string }): string {
  const localized = t(VIEW_LABEL[view.viewType] ?? 'project.view.table')
  return !view.title || view.title === VIEW_DEFAULT_TITLE[view.viewType] ? localized : view.title
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
  onRefresh: () => Promise<void>
  /** A public reader has no session: the member-only reads and exports would answer 401, so they are not offered. */
  publicView?: boolean
}

export function BoardViews({ bundle, canEdit, onDeleteCard, onCreateView, onOpenCard, onPatchView, onDeleteView, onDuplicateView, onActiveViewChange, onPatchCard, onAddGroupOption, onRefresh, publicView = false }: BoardViewsProps): ReactElement {
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
  const filtered = useMemo(() => bundle.cards.filter((card) => matchProjectFilterGroup(card, fields.filter, bundle.properties) && matchProjectViewSearch(card, search, bundle.properties)), [bundle.cards, fields.filter, bundle.properties, search])
  const sorted = useMemo(() => sortProjectCards(filtered, fields.sortOptions, bundle.properties), [filtered, fields.sortOptions, bundle.properties])
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
  const badgesFor = (cardId: string): ProjectCardBadges => badgesByCard.get(cardId) ?? { description: false, comments: 0, checked: 0, checkboxes: 0 }
  const cellDisplay = (card: ProjectCard, property: ProjectProperty): ReactElement | string => {
    if (property.type === 'select' && card.values[property.id]) {
      return <OptionChip property={property} value={card.values[property.id]!} />
    }
    if (property.type === 'multiSelect' && card.values[property.id]) {
      try {
        const optionIds = JSON.parse(card.values[property.id]!) as string[]
        if (Array.isArray(optionIds) && optionIds.length > 0) {
          return (
            <div className="flex flex-wrap gap-1">
              {optionIds.map((optId) => <OptionChip key={optId} property={property} value={optId} />)}
            </div>
          )
        }
      } catch { /* a stored value that is not a JSON array reads as plain text below */ }
    }
    return projectPropertyDisplayText(card, property) || '—'
  }

  const [contextPoint, setContextPoint] = useState<{ x: number, y: number } | null>(null)
  const [contextItems, setContextItems] = useState<MenuItem[]>([])

  const doneLabel = t('project.card.done_label').toLowerCase()
  const toggleCardDone = async (card: ProjectCard, checked: boolean) => {
    const statusProperty = bundle.properties.find((p) => p.type === 'select')
    if (statusProperty && statusProperty.options.length > 0) {
      const doneOption = statusProperty.options.find((entry) => {
        const value = entry.value.toLowerCase()
        return value === doneLabel || /done|complete|finished/i.test(value)
      })
      const todoOption = statusProperty.options.find((entry) => entry !== doneOption) ?? statusProperty.options[0]
      await onPatchCard(card.id, { values: { [statusProperty.id]: checked ? (doneOption?.id ?? null) : (todoOption?.id ?? null) } })
      return
    }
    const checkboxProperty = bundle.properties.find((p) => p.type === 'checkbox')
    if (checkboxProperty) {
      await onPatchCard(card.id, { values: { [checkboxProperty.id]: checked ? 'true' : 'false' } })
    }
  }

  const handleAddSubtask = async (parentCardId: string) => {
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

  const handleDuplicate = async (cardId: string) => {
    await duplicateProjectCard(cardId)
    await onRefresh()
  }

  const handleCopyLink = async (cardId: string) => {
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
    const groupProperty = bundle.properties.find((p) => p.id === fields.groupById)
    const items: MenuItem[] = [
      {
        id: 'open',
        label: t('project.card.open'),
        icon: <FileText size={14} />,
        onSelect: () => onOpenCard(card.id),
      },
      {
        id: 'toggle-done',
        label: isDone ? t('project.card.mark_undone') : t('project.card.mark_done'),
        icon: <CheckSquare size={14} />,
        disabled: !canEdit,
        onSelect: () => { void toggleCardDone(card, !isDone) },
      },
      {
        id: 'add-subtask',
        label: t('project.card.add_subtask'),
        icon: <ListTodo size={14} />,
        disabled: !canEdit,
        onSelect: () => { void handleAddSubtask(card.id) },
      },
    ]

    if (groupProperty && canEdit && groupProperty.options.length > 0) {
      const moveOptions: MenuItem[] = groupProperty.options.map((opt) => ({
        id: `opt-${opt.id}`,
        label: opt.value,
        onSelect: () => {
          void onPatchCard(card.id, { values: { [groupProperty.id]: opt.id } })
        },
      }))
      items.push({
        id: 'move-group',
        label: t('project.card.move_to_column'),
        icon: <SlidersHorizontal size={14} />,
        subItems: moveOptions,
        submenu: submenuFor(moveOptions),
      })
    }

    items.push({
      id: 'duplicate',
      label: t('project.card.duplicate'),
      icon: <Copy size={14} />,
      separatorBefore: true,
      disabled: !canEdit,
      onSelect: () => { void handleDuplicate(card.id) },
    })
    items.push({
      id: 'copy-link',
      label: t('project.card.copy_link'),
      icon: <Link2 size={14} />,
      disabled: publicView,
      onSelect: () => { void handleCopyLink(card.id) },
    })
    items.push({
      id: 'delete',
      label: t('project.board.delete_card'),
      icon: <Trash2 size={14} />,
      separatorBefore: true,
      tone: 'danger',
      disabled: !canEdit,
      onSelect: () => onDeleteCard(card.id),
    })

    return items
  }

  const onCardContextMenu = (event: MouseEvent, card: ProjectCard) => {
    event.preventDefault()
    event.stopPropagation()
    setContextItems(buildCardContextMenu(card))
    setContextPoint({ x: event.clientX, y: event.clientY })
  }
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
  const [editingCell, setEditingCell] = useState<{ cardId: string, propertyId: string } | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [batchPropertyId, setBatchPropertyId] = useState('')
  const [batchValue, setBatchValue] = useState('')
  const [expandedCards, setExpandedCards] = useState<Set<string>>(() => new Set())
  const toggleExpandCard = (cardId: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }

  const allCardsById = useMemo(() => new Set(bundle.cards.map((c) => c.id)), [bundle.cards])
  const subtasksByParent = useMemo(() => {
    const map = new Map<string, ProjectCard[]>()
    for (const card of bundle.cards) {
      if (card.parentId) {
        const list = map.get(card.parentId)
        if (list) list.push(card)
        else map.set(card.parentId, [card])
      }
    }
    return map
  }, [bundle.cards])

  const subtaskProgressByParent = useMemo(() => {
    const map = new Map<string, { total: number, done: number }>()
    for (const [parentId, subtasks] of subtasksByParent) {
      const done = subtasks.filter((s) => isProjectCardDone(s, bundle.properties)).length
      map.set(parentId, { total: subtasks.length, done })
    }
    return map
  }, [subtasksByParent, bundle.properties])
  const lastIndex = useRef<number | null>(null)
  const selectClick = (event: MouseEvent, cardId: string) => {
    const ids = sorted.map((card) => card.id)
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
  const batchDelete = async () => {
    await batchDeleteProjectBoard(bundle.board.id, { cardIds: selected })
    setSelected([])
    await onRefresh()
  }
  const batchApply = async () => {
    if (!batchPropertyId) return
    await batchPatchProjectBoard(bundle.board.id, { cards: selected.map((id) => ({ id, patch: { values: { [batchPropertyId]: batchValue || null } } })) })
    setSelected([])
    await onRefresh()
  }
  const batchProperties = bundle.properties.filter((property) => property.type === 'select')
  const batchProperty = batchProperties.find((property) => property.id === batchPropertyId)
  const tableGroups: [string, ProjectCard[]][] = fields.groupById
    ? [...groupProjectCards(sorted, fields.groupById, bundle.properties).entries()]
    : [['', sorted]]
  const toggleGroup = (key: string) => {
    if (!active) return
    const collapsed = fields.collapsedOptionIds.includes(key)
    void onPatchView(active.id, { fields: { collapsedOptionIds: collapsed ? fields.collapsedOptionIds.filter((entry) => entry !== key) : [...fields.collapsedOptionIds, key] } })
  }
  const reorderColumn = (sourceId: string, targetId: string) => {
    if (!active || sourceId === targetId) return
    const ids = columns.map((property) => property.id)
    const without = ids.filter((id) => id !== sourceId)
    const at = without.indexOf(targetId)
    void onPatchView(active.id, { fields: { visiblePropertyIds: [...without.slice(0, at), sourceId, ...without.slice(at)] } })
  }
  const density = fields.cardSize ?? 'comfortable'
  const rowPad = density === 'compact' ? 'py-0.5' : density === 'spacious' ? 'py-3' : 'py-2'
  const columns = fields.visiblePropertyIds.length
    ? fields.visiblePropertyIds.map((id) => bundle.properties.find((p) => p.id === id)).filter((p): p is ProjectProperty => Boolean(p))
    : bundle.properties
  const groupable = bundle.properties.filter((property) => PROJECT_PROPERTY_CAPABILITIES[property.type].canGroup)
  const dateProperties = bundle.properties.filter((property) => property.type === 'date')
  const showsDateDisplay = viewType === 'calendar' || viewType === 'timeline' || viewType === 'gantt' || viewType === 'dashboard'

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
        {orderedViews.map((view) => {
          const TabIcon = VIEW_ICON[view.viewType] ?? Table
          return (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={active?.id === view.id}
            className={`shrink-0 whitespace-nowrap rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-12)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${active?.id === view.id ? 'bg-[var(--bg-hover)] font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
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
              items={([['table', 'project.view.table'], ['board', 'project.view.board'], ['gallery', 'project.view.gallery'], ['calendar', 'project.view.calendar'], ['list', 'project.view.list'], ['timeline', 'project.view.timeline'], ['gantt', 'project.view.gantt'], ['chart', 'project.view.chart'], ['dashboard', 'project.view.dashboard'], ['collection', 'project.view.collection']] as const).map(([type, key]) => ({
                id: type,
                label: t(key),
                onSelect: () => onCreateView(type),
              })) as MenuItem[]}
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
              className="w-36"
              size="sm"
              value={fields.dateDisplayPropertyId ?? ''}
              label={t('project.view.display_by')}
              disabled={!canEdit}
              onChange={(value) => onPatchView(active.id, { fields: { dateDisplayPropertyId: value || undefined } })}
              options={[{ value: '', label: t('project.view.display_by') }, ...dateProperties.map((property) => ({ value: property.id, label: property.name }))]}
            />
          )}
          {(viewType === 'board' || viewType === 'table' || viewType === 'gallery') && (
            <SelectMenu
              className="w-36"
              size="sm"
              value={fields.groupById ?? ''}
              label={t('project.view.group_by')}
              disabled={!canEdit}
              onChange={(value) => onPatchView(active.id, { fields: { groupById: value || undefined } })}
              options={[{ value: '', label: t('project.view.group_by') }, ...groupable.map((property) => ({ value: property.id, label: property.name }))]}
            />
          )}
          {viewType === 'board' && (
            <SelectMenu
              className="w-32"
              size="sm"
              value={fields.swimlaneBy ?? ''}
              label={t('project.view.swimlane')}
              disabled={!canEdit}
              onChange={(value) => onPatchView(active.id, { fields: { swimlaneBy: value || undefined } })}
              options={[{ value: '', label: t('project.view.swimlane') }, ...groupable.map((property) => ({ value: property.id, label: property.name }))]}
            />
          )}
          {viewType === 'gallery' && active && (
            <span className="flex items-center gap-2">
              <Checkbox label={t('project.view.gallery_title')} checked={fields.galleryShowTitle !== false} disabled={!canEdit} onChange={(checked) => onPatchView(active.id, { fields: { galleryShowTitle: checked } })} />
              <Checkbox label={t('project.view.gallery_badges')} checked={fields.galleryShowBadges !== false} disabled={!canEdit} onChange={(checked) => onPatchView(active.id, { fields: { galleryShowBadges: checked } })} />
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            <SelectMenu
              className="w-28"
              size="sm"
              value={density}
              label={t('project.view.density')}
              disabled={!canEdit}
              onChange={(value) => onPatchView(active.id, { fields: { cardSize: value as 'compact' | 'comfortable' | 'spacious' } })}
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
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5" role="toolbar" aria-label={t('project.view.selected_count', { count: selected.length })}>
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('project.view.selected_count', { count: selected.length })}</span>
          <Button size="sm" variant="ghost" onClick={() => void batchDelete()}>{t('project.view.delete_selected')}</Button>
          <SelectMenu className="w-32" size="sm" value={batchPropertyId} label={t('project.view.set_property')} onChange={(value) => { setBatchPropertyId(value); setBatchValue('') }} options={[{ value: '', label: t('project.view.set_property') }, ...batchProperties.map((property) => ({ value: property.id, label: property.name }))]} />
          {batchProperty && (
            <SelectMenu className="w-32" size="sm" value={batchValue} label={t('project.view.filter_value')} onChange={setBatchValue} options={[{ value: '', label: '—' }, ...batchProperty.options.map((option) => ({ value: option.id, label: option.value, icon: optionDot(option.color) }))]} />
          )}
          <Button size="sm" disabled={!batchPropertyId} onClick={() => void batchApply()}>{t('common.save')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>{t('project.view.clear_selection')}</Button>
        </div>
      )}
      {viewType === 'collection'
        ? <CollectionView boardId={bundle.board.id} canEdit={canEdit} onOpenCard={onOpenCard} />
        : viewType === 'dashboard'
          ? <DashboardView boardId={bundle.board.id} cards={sorted} properties={bundle.properties} datePropertyId={fields.dateDisplayPropertyId} onOpenCard={onOpenCard} />
        : viewType === 'calendar'
        ? <CalendarView cards={sorted} boardId={bundle.board.id} properties={bundle.properties} datePropertyId={fields.dateDisplayPropertyId} canEdit={canEdit} onOpenCard={onOpenCard} onPatchCard={onPatchCard} onRefresh={onRefresh} />
        : sorted.length === 0 && viewType !== 'board'
          ? <Empty art="folder" title={t('project.board.empty_cards')} />
          : viewType === 'board'
            ? (fields.swimlaneBy
              ? <Swimlanes cards={sorted} fields={fields} properties={bundle.properties} badgesFor={badgesFor} canEdit={canEdit} onDeleteCard={onDeleteCard} density={density} onPatch={(f) => { if (active) onPatchView(active.id, { fields: f }) }} onPatchCard={onPatchCard} onAddGroupOption={onAddGroupOption} selected={selected} onSelectClick={selectClick} allCardsById={allCardsById} subtasksByParent={subtasksByParent} subtaskProgressByParent={subtaskProgressByParent} expandedCards={expandedCards} onToggleExpand={toggleExpandCard} onCardContextMenu={onCardContextMenu} onAddSubtask={handleAddSubtask} onToggleCardDone={toggleCardDone} onOpenCard={onOpenCard} onAddCard={addCardInColumn} />
              : <BoardColumns cards={sorted} groupById={fields.groupById} properties={bundle.properties} badgesFor={badgesFor} canEdit={canEdit} onDeleteCard={onDeleteCard} fields={fields} density={density} onPatch={(f) => { if (active) onPatchView(active.id, { fields: f }) }} onPatchCard={onPatchCard} onAddGroupOption={onAddGroupOption} selected={selected} onSelectClick={selectClick} allCardsById={allCardsById} subtasksByParent={subtasksByParent} subtaskProgressByParent={subtaskProgressByParent} expandedCards={expandedCards} onToggleExpand={toggleExpandCard} onCardContextMenu={onCardContextMenu} onAddSubtask={handleAddSubtask} onToggleCardDone={toggleCardDone} onOpenCard={onOpenCard} onAddCard={addCardInColumn} />)
            : viewType === 'gallery'
              ? (
                <GalleryView
                  cards={sorted}
                  badgesFor={badgesFor}
                  properties={columns}
                  showTitle={fields.galleryShowTitle !== false}
                  showBadges={fields.galleryShowBadges !== false}
                  onOpenCard={onOpenCard}
                  onCardContextMenu={onCardContextMenu}
                  groupById={fields.groupById}
                  allProperties={bundle.properties}
                  collapsedOptionIds={fields.collapsedOptionIds}
                  onToggleGroup={toggleGroup}
                  canEdit={canEdit}
                  onAddCard={addCardInColumn}
                  coverFor={publicView ? undefined : (cardId) => coverByCard.get(cardId) ?? null}
                />
              )
              : viewType === 'list'
                ? (
                  <ListView
                    cards={sorted}
                    properties={bundle.properties}
                    canEdit={canEdit}
                    badgesFor={badgesFor}
                    onOpenCard={onOpenCard}
                    onCardContextMenu={onCardContextMenu}
                    onAddSubtask={handleAddSubtask}
                    onToggleCardDone={toggleCardDone}
                    onDeleteCard={onDeleteCard}
                  />
                )
                : viewType === 'timeline' || viewType === 'gantt'
                  ? <TimelineView cards={sorted} properties={bundle.properties} datePropertyId={fields.dateDisplayPropertyId} links={links} gantt={viewType === 'gantt'} onOpenCard={onOpenCard} />
                  : viewType === 'chart'
                    ? <ChartView cards={sorted} properties={bundle.properties} />
                    : (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full border-collapse text-[length:var(--text-13)]">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] text-left text-[length:var(--text-12)] text-[var(--text-secondary)]">
                      {canEdit && (
                        <th scope="col" className="w-9 px-2 py-2">
                          <Checkbox
                            ariaLabel={t('project.view.select_all')}
                            checked={sorted.length > 0 && sorted.every((card) => selected.includes(card.id))}
                            onChange={(checked) => setSelected(checked ? sorted.map((card) => card.id) : [])}
                          />
                        </th>
                      )}
                      <th scope="col" className="px-3 py-2 font-medium">{t('project.board.title_column')}</th>
                      {columns.map((property) => (
                        <th
                          key={property.id}
                          scope="col"
                          className="relative px-3 py-2 font-medium"
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
                  {tableGroups.map(([groupKey, groupCards]) => (
                    <tbody key={groupKey || 'all'}>
                      {fields.groupById && (
                        <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
                          <td colSpan={columns.length + 1 + (canEdit ? 2 : 0)} className="px-3 py-1">
                            <button
                              type="button"
                              className="flex items-center gap-1 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                              aria-expanded={!fields.collapsedOptionIds.includes(groupKey)}
                              onClick={() => toggleGroup(groupKey)}
                            >
                              {fields.collapsedOptionIds.includes(groupKey) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                              {groupKey === '' ? t('project.view.no_value') : projectOptionLabel(bundle.properties.find((property) => property.id === fields.groupById)!, groupKey)}
                              <span className="text-[var(--text-tertiary)]">{groupCards.length}</span>
                            </button>
                          </td>
                        </tr>
                      )}
                      {!fields.collapsedOptionIds.includes(groupKey) && (() => {
                        const groupCardIds = new Set(groupCards.map((c) => c.id))
                        const rootCards = groupCards.filter((c) => !c.parentId || !groupCardIds.has(c.parentId))
                        return rootCards.map((card, rowIndex) => {
                          const cardSubtasks = subtasksByParent.get(card.id) ?? []
                          const hasSubtasks = cardSubtasks.length > 0
                          const isExpanded = expandedCards.has(card.id)
                          return (
                            <Fragment key={card.id}>
                              <tr className={`border-b border-[var(--border-subtle)] ${rowPad} ${selected.includes(card.id) ? 'bg-[var(--accent-soft)]' : ''}`} data-project-card={card.id} onContextMenu={(event) => onCardContextMenu(event, card)}>
                                {canEdit && (
                                  <td className="px-2 py-2">
                                    <Checkbox
                                      ariaLabel={card.title || t('project.board.untitled_card')}
                                      checked={selected.includes(card.id)}
                                      onChange={(checked) => setSelected((current) => checked ? [...current, card.id] : current.filter((id) => id !== card.id))}
                                    />
                                  </td>
                                )}
                                <td className="px-3 py-2 text-[var(--text-primary)]">
                                  <div className="flex items-center gap-1">
                                    <span aria-hidden="true" className="w-5 shrink-0 text-right text-[length:var(--text-11)] text-[var(--text-quaternary)] tabular">{rowIndex + 1}</span>
                                    {hasSubtasks ? (
                                      <button
                                        type="button"
                                        aria-label={isExpanded ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
                                        aria-expanded={isExpanded}
                                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                                        onClick={() => toggleExpandCard(card.id)}
                                      >
                                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                      </button>
                                    ) : (
                                      <span className="w-5 shrink-0" aria-hidden="true" />
                                    )}
                                    <button type="button" className="min-w-0 truncate text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={(event) => selectClick(event, card.id)}>
                                      {card.title || t('project.board.untitled_card')}
                                    </button>
                                    {hasSubtasks && (
                                      <span className="shrink-0 rounded bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
                                        {cardSubtasks.filter((s) => isProjectCardDone(s, bundle.properties)).length}/{cardSubtasks.length}
                                      </span>
                                    )}
                                  </div>
                                </td>
                                {columns.map((property) => (
                                  <td key={property.id} className="px-3 py-2 text-[var(--text-secondary)]">
                                    {editingCell?.cardId === card.id && editingCell.propertyId === property.id
                                      ? (
                                        <PropertyValueEditor
                                          property={property}
                                          card={card}
                                          value={card.values[property.id] ?? ''}
                                          members={bundle.members}
                                          disabled={false}
                                          onChange={(value) => { void onPatchCard(card.id, { values: { [property.id]: value } }); setEditingCell(null) }}
                                        />
                                      )
                                      : canEdit
                                        ? (
                                          <button type="button" className="w-full truncate text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => setEditingCell({ cardId: card.id, propertyId: property.id })}>
                                            {cellDisplay(card, property)}
                                          </button>
                                        )
                                        : cellDisplay(card, property)}
                                  </td>
                                ))}
                                {canEdit && (
                                  <td className="px-2 py-1">
                                    <IconButton label={t('project.board.delete_card')} size="sm" onClick={() => onDeleteCard(card.id)}>
                                      <Trash2 size={15} />
                                    </IconButton>
                                  </td>
                                )}
                              </tr>
                              {hasSubtasks && isExpanded && cardSubtasks.map((subtask) => (
                                <tr key={subtask.id} className={`border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)]/40 ${rowPad} ${selected.includes(subtask.id) ? 'bg-[var(--accent-soft)]' : ''}`} data-project-card={subtask.id} onContextMenu={(event) => onCardContextMenu(event, subtask)}>
                                  {canEdit && (
                                    <td className="px-2 py-2">
                                      <Checkbox
                                        ariaLabel={subtask.title || t('project.board.untitled_card')}
                                        checked={selected.includes(subtask.id)}
                                        onChange={(checked) => setSelected((current) => checked ? [...current, subtask.id] : current.filter((id) => id !== subtask.id))}
                                      />
                                    </td>
                                  )}
                                  <td className="px-3 py-2 text-[var(--text-primary)]">
                                    <div className="flex items-center gap-1.5 pl-6">
                                      <CornerDownRight size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                                      <button type="button" className="min-w-0 truncate text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={(event) => selectClick(event, subtask.id)}>
                                        {subtask.title || t('project.board.untitled_card')}
                                      </button>
                                    </div>
                                  </td>
                                  {columns.map((property) => (
                                    <td key={property.id} className="px-3 py-2 text-[var(--text-secondary)]">
                                      {editingCell?.cardId === subtask.id && editingCell.propertyId === property.id
                                        ? (
                                          <PropertyValueEditor
                                            property={property}
                                            card={subtask}
                                            value={subtask.values[property.id] ?? ''}
                                            members={bundle.members}
                                            disabled={false}
                                            onChange={(value) => { void onPatchCard(subtask.id, { values: { [property.id]: value } }); setEditingCell(null) }}
                                          />
                                        )
                                        : canEdit
                                          ? (
                                            <button type="button" className="w-full truncate text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => setEditingCell({ cardId: subtask.id, propertyId: property.id })}>
                                              {cellDisplay(subtask, property)}
                                            </button>
                                          )
                                          : cellDisplay(subtask, property)}
                                    </td>
                                  ))}
                                  {canEdit && (
                                    <td className="px-2 py-1">
                                      <IconButton label={t('project.board.delete_card')} size="sm" onClick={() => onDeleteCard(subtask.id)}>
                                        <Trash2 size={15} />
                                      </IconButton>
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </Fragment>
                          )
                        })
                      })()}
                    </tbody>
                  ))}
                  {canEdit && (
                    <tbody>
                      <tr className="border-b border-[var(--border-subtle)]">
                        <td colSpan={columns.length + 1 + (canEdit ? 2 : 0)} className="px-2 py-1">
                          <ColumnAddTask label={t('project.view.add_row')} onAdd={(title) => addCardInColumn(title, '')} />
                        </td>
                      </tr>
                    </tbody>
                  )}
                  {active && (
                    <tfoot>
                      <tr className="border-t border-[var(--border-subtle)] text-[length:var(--text-12)] text-[var(--text-secondary)]">
                        {canEdit && <td />}
                        <td className="px-3 py-1">{t('project.view.summary')}</td>
                        {columns.map((property) => {
                          const calc = fields.columnCalculations[property.id] ?? 'count'
                          return (
                            <td key={property.id} className="px-3 py-1">
                              <span className="mr-2">{computeProjectCalculation(sorted, property, calc)}</span>
                              <SelectMenu
                                className="w-28"
                                size="sm"
                                value={calc}
                                label={property.name}
                                disabled={!canEdit}
                                onChange={(value) => onPatchView(active.id, { fields: { columnCalculations: { ...fields.columnCalculations, [property.id]: value as typeof calc } } })}
                                options={calculationOptionsFor(property).map((option) => ({ value: option, label: t(`project.calc.${option.toLowerCase()}` as Parameters<typeof t>[0]) }))}
                              />
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
      {contextPoint && (
        <Menu
          anchor={contextPoint}
          open={Boolean(contextPoint)}
          onClose={() => setContextPoint(null)}
          items={contextItems}
        />
      )}
    </div>
  )
}

function BoardColumns({
  cards,
  groupById,
  properties,
  badgesFor,
  canEdit,
  onDeleteCard,
  fields,
  density,
  onPatch,
  onPatchCard,
  onAddGroupOption,
  selected,
  onSelectClick,
  allCardsById,
  subtasksByParent,
  subtaskProgressByParent,
  expandedCards,
  onToggleExpand,
  onCardContextMenu,
  onAddSubtask,
  onToggleCardDone,
  onOpenCard,
  onAddCard,
}: {
  cards: ProjectCard[]
  groupById?: string
  properties: ProjectProperty[]
  badgesFor: (cardId: string) => ProjectCardBadges
  canEdit: boolean
  onDeleteCard: (id: string) => void
  fields: ProjectViewFields
  density: 'compact' | 'comfortable' | 'spacious'
  onPatch: (fields: Partial<ProjectViewFields>) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onAddGroupOption: (propertyId: string, value: string) => Promise<void>
  selected: string[]
  onSelectClick: (event: MouseEvent, id: string) => void
  allCardsById?: Set<string>
  subtasksByParent?: Map<string, ProjectCard[]>
  subtaskProgressByParent?: Map<string, { total: number, done: number }>
  expandedCards?: Set<string>
  onToggleExpand?: (id: string) => void
  onCardContextMenu?: (event: MouseEvent, card: ProjectCard) => void
  onAddSubtask?: (parentCardId: string) => Promise<void>
  onToggleCardDone?: (card: ProjectCard, checked: boolean) => Promise<void>
  onOpenCard?: (id: string) => void
  onAddCard?: (title: string, optionId: string) => Promise<void>
}): ReactElement {
  const cardPad = density === 'compact' ? 'px-2 py-1' : density === 'spacious' ? 'px-3 py-3' : 'px-2 py-2'
  const chipProperties = fields.visiblePropertyIds.length
    ? fields.visiblePropertyIds.map((id) => properties.find((property) => property.id === id)).filter((property): property is ProjectProperty => Boolean(property))
    : properties
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
        const rootCards = allCardsById ? bucket.filter((c) => !c.parentId || !allCardsById.has(c.parentId)) : bucket
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
            <header className="group/col flex items-center gap-2 px-3 py-2 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {groupProperty && key !== '' ? <span className="min-w-0 shrink-0"><OptionChip property={groupProperty} value={key} /></span> : <span className="truncate">{label}</span>}
              </span>
              {canEdit && groupProperty && key !== '' && (
                <IconButton label={t('project.view.hide_column')} size="sm" onClick={() => onPatch({ hiddenOptionIds: [...fields.hiddenOptionIds, key] })}>
                  <EyeOff size={13} />
                </IconButton>
              )}
              {calcProperty && (
                <SelectMenu
                  className="w-24 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/col:opacity-100"
                  size="sm"
                  value={calc}
                  label={label}
                  disabled={!canEdit}
                  onChange={(value) => onPatch({ kanbanCalculations: { ...fields.kanbanCalculations, [key]: { calculation: value as ProjectCalculation, propertyId: calcProperty.id } } })}
                  options={calculationOptionsFor(calcProperty).map((option) => ({ value: option, label: t(`project.calc.${option.toLowerCase()}` as Parameters<typeof t>[0]) }))}
                />
              )}
              <span className={fields.wipLimits?.[key] !== undefined && rootCards.length > fields.wipLimits[key]! ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]'}>{calcProperty ? computeProjectCalculation(rootCards, calcProperty, calc) : rootCards.length}</span>
              {canEdit && groupProperty && (
                <Input
                  type="number"
                  className="w-14 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/col:opacity-100"
                  value={fields.wipLimits?.[key] ?? ''}
                  placeholder={t('project.view.wip_limit')}
                  aria-label={`${label} ${t('project.view.wip_limit')}`}
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
              {rootCards.length === 0 && <li className="px-1 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.view.empty_column')}</li>}
              {rootCards.map((card) => {
                const cardSubtasks = subtasksByParent?.get(card.id) ?? []
                const progress = subtaskProgressByParent?.get(card.id)
                const hasSubtasks = cardSubtasks.length > 0
                const isExpanded = expandedCards?.has(card.id) ?? false
                return (
                  <li
                    key={card.id}
                    className={`group/card flex flex-col rounded-[var(--r-sm)] bg-[var(--bg-base)] shadow-[var(--shadow-sm)] border border-[var(--border-subtle)] ${cardPad} ${selected.includes(card.id) ? 'ring-2 ring-[var(--accent)]' : ''}`}
                    data-project-card={card.id}
                    draggable={canEdit}
                    onDragStart={(event) => { event.dataTransfer.setData('text/plain', card.id) }}
                    onContextMenu={(event) => onCardContextMenu?.(event, card)}
                  >
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-[length:var(--text-13)] font-medium text-[var(--text-primary)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                        onClick={(event) => onSelectClick(event, card.id)}
                      >
                        {card.title || t('project.board.untitled_card')}
                      </button>
                      <CardBadges badges={badgesFor(card.id)} />
                      {hasSubtasks && onToggleExpand ? (
                        <button
                          type="button"
                          aria-label={isExpanded ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
                          aria-expanded={isExpanded}
                          className={`inline-flex items-center gap-1 rounded-[var(--r-full)] border px-1.5 py-0.5 text-[length:var(--text-11)] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
                            isExpanded
                              ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                              : 'border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[var(--text-secondary)] hover:border-[var(--border-default)]'
                          }`}
                          onClick={(e) => { e.stopPropagation(); onToggleExpand(card.id) }}
                        >
                          <ListTodo size={11} className="shrink-0" />
                          <span>{progress?.done ?? 0}/{progress?.total ?? cardSubtasks.length}</span>
                          {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        </button>
                      ) : canEdit && onAddSubtask ? (
                        <button
                          type="button"
                          aria-label={t('project.card.add_subtask')}
                          className="opacity-0 group-hover/card:opacity-100 rounded p-0.5 text-[var(--text-quaternary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-opacity focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                          onClick={(e) => { e.stopPropagation(); void onAddSubtask(card.id) }}
                        >
                          <Plus size={13} />
                        </button>
                      ) : null}
                      {canEdit && (
                        <IconButton label={t('project.board.delete_card')} size="sm" className="opacity-0 group-hover/card:opacity-100 transition-opacity" onClick={() => onDeleteCard(card.id)}>
                          <Trash2 size={13} />
                        </IconButton>
                      )}
                    </div>
                    <CardPropertyChips card={card} properties={chipProperties} excludePropertyId={groupById} />
                    {hasSubtasks && isExpanded && (
                      <div className="mt-2 space-y-1.5 border-l-2 border-[var(--border-subtle)] ml-2 pl-2">
                        {cardSubtasks.map((subtask) => {
                          const isDone = isProjectCardDone(subtask, properties)
                          const subtaskBadges = badgesFor(subtask.id)
                          return (
                            <div
                              key={subtask.id}
                              className={`group/subtask flex items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1 shadow-[var(--shadow-xs)] hover:border-[var(--border-default)] transition-colors ${selected.includes(subtask.id) ? 'ring-2 ring-[var(--accent)]' : ''}`}
                              data-project-card={subtask.id}
                              draggable={canEdit}
                              onDragStart={(event) => { event.dataTransfer.setData('text/plain', subtask.id) }}
                              onContextMenu={(event) => onCardContextMenu?.(event, subtask)}
                            >
                              <Checkbox
                                ariaLabel={subtask.title || t('project.board.untitled_card')}
                                checked={isDone}
                                disabled={!canEdit}
                                onChange={(checked) => {
                                  void onToggleCardDone?.(subtask, checked)
                                }}
                              />
                              <button
                                type="button"
                                className={`min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${isDone ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)] hover:text-[var(--accent)]'}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (onOpenCard) onOpenCard(subtask.id)
                                  else onSelectClick(e, subtask.id)
                                }}
                              >
                                {subtask.title || t('project.board.untitled_card')}
                              </button>
                              <CardBadges badges={subtaskBadges} />
                              {canEdit && (
                                <IconButton
                                  label={t('project.board.delete_card')}
                                  size="sm"
                                  className="opacity-0 group-hover/subtask:opacity-100 transition-opacity"
                                  onClick={() => onDeleteCard(subtask.id)}
                                >
                                  <Trash2 size={12} />
                                </IconButton>
                              )}
                            </div>
                          )
                        })}
                        {canEdit && onAddSubtask && (
                          <button
                            type="button"
                            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] transition-colors"
                            onClick={(e) => {
                              e.stopPropagation()
                              void onAddSubtask(card.id)
                            }}
                          >
                            <Plus size={11} />
                            <span>{t('project.card.add_subtask')}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            {canEdit && onAddCard && (
              <div className="shrink-0 px-1 pb-1">
                <ColumnAddTask label={t('project.board.new_card')} onAdd={(title) => onAddCard(title, key)} />
              </div>
            )}
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

function Swimlanes({
  cards,
  fields,
  properties,
  badgesFor,
  canEdit,
  onDeleteCard,
  density,
  onPatch,
  onPatchCard,
  onAddGroupOption,
  selected,
  onSelectClick,
  allCardsById,
  subtasksByParent,
  subtaskProgressByParent,
  expandedCards,
  onToggleExpand,
  onCardContextMenu,
  onAddSubtask,
  onToggleCardDone,
  onOpenCard,
  onAddCard,
}: {
  cards: ProjectCard[]
  fields: ProjectViewFields
  properties: ProjectProperty[]
  badgesFor: (cardId: string) => ProjectCardBadges
  canEdit: boolean
  onDeleteCard: (id: string) => void
  density: 'compact' | 'comfortable' | 'spacious'
  onPatch: (fields: Partial<ProjectViewFields>) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onAddGroupOption: (propertyId: string, value: string) => Promise<void>
  selected: string[]
  onSelectClick: (event: MouseEvent, id: string) => void
  allCardsById?: Set<string>
  subtasksByParent?: Map<string, ProjectCard[]>
  subtaskProgressByParent?: Map<string, { total: number, done: number }>
  expandedCards?: Set<string>
  onToggleExpand?: (id: string) => void
  onCardContextMenu?: (event: MouseEvent, card: ProjectCard) => void
  onAddSubtask?: (parentCardId: string) => Promise<void>
  onToggleCardDone?: (card: ProjectCard, checked: boolean) => Promise<void>
  onOpenCard?: (id: string) => void
  onAddCard?: (title: string, optionId: string) => Promise<void>
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
          <BoardColumns
            cards={laneCards}
            groupById={fields.groupById}
            properties={properties}
            badgesFor={badgesFor}
            canEdit={canEdit}
            onDeleteCard={onDeleteCard}
            fields={fields}
            density={density}
            onPatch={onPatch}
            onPatchCard={onPatchCard}
            onAddGroupOption={onAddGroupOption}
            selected={selected}
            onSelectClick={onSelectClick}
            allCardsById={allCardsById}
            subtasksByParent={subtasksByParent}
            subtaskProgressByParent={subtaskProgressByParent}
            expandedCards={expandedCards}
            onToggleExpand={onToggleExpand}
            onCardContextMenu={onCardContextMenu}
            onAddSubtask={onAddSubtask}
            onToggleCardDone={onToggleCardDone}
            onOpenCard={onOpenCard}
            onAddCard={onAddCard}
          />
        </section>
      ))}
    </div>
  )
}
function ColumnAddTask({ label, onAdd }: { label: string, onAdd: (title: string) => Promise<void> }): ReactElement {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onAdd(trimmed)
      setTitle('')
    } finally {
      setBusy(false)
    }
  }
  if (!open) {
    return (
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onClick={() => setOpen(true)}
      >
        <Plus size={13} aria-hidden="true" />
        <span>{label}</span>
      </button>
    )
  }
  return (
    <form
      className="px-1 pb-1"
      onSubmit={(event) => { event.preventDefault(); void submit() }}
    >
      <Input
        className="w-full"
        value={title}
        autoFocus
        disabled={busy}
        aria-label={label}
        placeholder={t('project.board.card_placeholder')}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); setTitle('') } }}
        onBlur={() => { if (!title.trim()) setOpen(false) }}
      />
    </form>
  )
}
