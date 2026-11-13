/**
 * The board shell: the tab strip, the controls every view shares, and the one view that is active.
 *
 * Filtering, sorting and searching happen here once, so every view receives the same cards and a
 * reader who switches tabs is looking at the same set. What a view does with them — columns, cells,
 * bars, tiles — is the view's own business.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { ArrowUpDown, BarChart3, Calendar, CalendarRange, Clock, Copy, Download, Eye, Filter, FolderOpen, LayoutDashboard, LayoutGrid, List, MoreHorizontal, Pencil, Plus, RotateCcw, SquareKanban, Table, Trash2, type LucideIcon } from 'lucide-react'
import type { ProjectBoardBundle, ProjectCard, ProjectCardLink, ProjectProperty, ProjectViewFields, ProjectViewPatch, ProjectViewType } from '@shared/project/model'
import { emptyProjectViewFields, projectCanMarkDone, projectDonePatch, projectViewPropertyId, PROJECT_PROPERTY_CAPABILITIES } from '@shared/project/model'
import { projectParentDonePatches } from '@shared/project/hierarchy'
import { projectCardBadges, type ProjectCardBadges } from '@shared/project/badges'
import { matchProjectFilterGroup, matchProjectViewSearch, orderProjectCards, projectGroupKeys, projectGroupLabel, sortProjectCards, sortProjectViewsAlphabetically } from '@shared/project/view-eval'
import { t, useLocale } from '../../lib/i18n'
import { useEvent } from '../../lib/hooks'
import { isImeComposing } from '../../lib/ime'
import { useUi } from '../../store/ui'
import { useProjectStore } from './store'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { confirm, Menu, prompt, type MenuItem } from '../../components/overlay'
import { PropertiesModal, SortModal } from './ViewSettingsModals'
import { FilterModal } from './FilterEditor'
import { buildCardMenu } from './card-menu'
import { ProjectPeopleProvider, useProjectPeople } from './people-context'
import { readPinnedCardsPref, readStarredCardsPref, writePinnedCardsPref, writeStarredCardsPref } from './project-prefs'
import { Seg } from './views/shell'
import { batchDeleteProjectBoard, batchPatchProjectBoard, createProjectCard, duplicateProjectCard, fetchBoardLinks, fetchProjectCardMarks, moveProjectCard, projectBoardExportUrl, projectFileUrl, saveProjectCardMarks } from './api'
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
import { BatchEditDialog } from './BatchEditDialog'

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
const EMPTY_BADGES: ProjectCardBadges = { description: false, comments: 0, checked: 0, checkboxes: 0 }

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
  onPatchCardsBatch?: (patches: { id: string, patch: Record<string, unknown> }[]) => Promise<void>
  onAddGroupOption: (propertyId: string, value: string) => Promise<void>
  onRenameGroupOption: (propertyId: string, optionId: string, value: string) => Promise<void>
  onSetGroupOptionColor: (propertyId: string, optionId: string, color: string) => Promise<void>
  onCardCreated: (card: ProjectCard) => void
  onRefresh: () => Promise<void>
  /** A public reader has no session: the member-only reads and exports would answer 401, so they are not offered. */
  publicView?: boolean
}

export function BoardViews({ bundle, canEdit, onDeleteCard, onCreateView, onOpenCard, onPatchView, onDeleteView, onDuplicateView, onActiveViewChange, onPatchCard, onPatchCardsBatch, onAddGroupOption, onRenameGroupOption, onSetGroupOptionColor, onCardCreated, onRefresh, publicView = false }: BoardViewsProps): ReactElement {
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
  const boards = useProjectStore((state) => state.boards)
  const [settings, setSettings] = useState<'sort' | 'filter' | 'properties' | null>(null)
  const [search, setSearch] = useState('')
  const [links, setLinks] = useState<ProjectCardLink[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [contextPoint, setContextPoint] = useState<{ x: number, y: number } | null>(null)
  const [contextItems, setContextItems] = useState<MenuItem[]>([])
  const lastIndex = useRef<number | null>(null)
  const [starredCards, setStarredCards] = useState<string[]>(() => readStarredCardsPref(bundle.board.id))
  const [pinnedCards, setPinnedCards] = useState<string[]>(() => readPinnedCardsPref(bundle.board.id))
  useEffect(() => {
    let alive = true
    const localStarred = readStarredCardsPref(bundle.board.id)
    const localPinned = readPinnedCardsPref(bundle.board.id)
    setStarredCards(localStarred)
    setPinnedCards(localPinned)
    if (publicView) return
    fetchProjectCardMarks(bundle.board.id)
      .then((marks) => {
        if (!alive) return
        // The account copy wins once it exists; a browser that marked cards before this shipped
        // uploads its local copy the first time the server has nothing.
        const starred = marks.starred.length ? marks.starred : localStarred
        const pinned = marks.pinned.length ? marks.pinned : localPinned
        setStarredCards(starred)
        setPinnedCards(pinned)
        writeStarredCardsPref(bundle.board.id, starred)
        writePinnedCardsPref(bundle.board.id, pinned)
        if ((!marks.starred.length && localStarred.length) || (!marks.pinned.length && localPinned.length)) {
          void saveProjectCardMarks(bundle.board.id, { starred, pinned }).catch(() => { /* best-effort migration */ })
        }
      })
      .catch(() => { /* best-effort: local marks keep working offline */ })
    return () => { alive = false }
  }, [bundle.board.id, publicView])
  const toggleCardFlag = useEvent((kind: 'star' | 'pin', cardId: string): void => {
    const read = kind === 'star' ? starredCards : pinnedCards
    const next = read.includes(cardId) ? read.filter((id) => id !== cardId) : [...read, cardId]
    const starred = kind === 'star' ? next : starredCards
    const pinned = kind === 'pin' ? next : pinnedCards
    if (kind === 'star') { setStarredCards(next); writeStarredCardsPref(bundle.board.id, next) }
    else { setPinnedCards(next); writePinnedCardsPref(bundle.board.id, next) }
    if (!publicView) {
      void saveProjectCardMarks(bundle.board.id, { starred, pinned })
        .catch(() => { useUi.getState().toast({ title: t('project.card.marks_save_failed'), tone: 'danger' }) })
    }
  })

  // C-23: tabs read alphabetically; the default view stays the board's first by position.
  const orderedViews = sortProjectViewsAlphabetically(bundle.views)
  const active = orderedViews.find((view) => view.id === activeId) ?? bundle.views[0] ?? null
  const fields = active?.fields ?? emptyProjectViewFields()
  const viewType = active?.viewType ?? 'table'

  // Only the two dependency-drawing views read links, and a saved dependency must refresh with the
  // bundle rather than waiting for a full remount.
  useEffect(() => {
    if (publicView || (viewType !== 'timeline' && viewType !== 'gantt')) {
      setLinks([])
      return
    }
    const controller = new AbortController()
    fetchBoardLinks(bundle.board.id, controller.signal).then(setLinks).catch(() => { if (!controller.signal.aborted) setLinks([]) })
    return () => controller.abort()
  }, [bundle.board.id, bundle.cursor, publicView, viewType])
  useEffect(() => { onActiveViewChange(active?.id ?? '') }, [active?.id, onActiveViewChange])

  const viewPatchQueue = useRef<Promise<void>>(Promise.resolve())
  const enqueueViewPatch = useEvent((viewId: string, patch: ProjectViewPatch): Promise<boolean> => {
    const task = viewPatchQueue.current
      .then(() => onPatchView(viewId, patch))
      .then(() => true)
      .catch((error: unknown) => {
        useUi.getState().toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
        return false
      })
    viewPatchQueue.current = task.then(() => undefined)
    return task
  })
  const patchFields = useEvent((patch: Partial<ProjectViewFields>): void => {
    if (active) void enqueueViewPatch(active.id, { fields: patch })
  })
  // Every keystroke used to re-match and re-sort the whole board; the box stays immediate while the
  // expensive pass trails one frame behind.
  const deferredSearch = useDeferredValue(search)
  const filtered = useMemo(
    () => bundle.cards.filter((card) => matchProjectFilterGroup(card, fields.filter, bundle.properties) && matchProjectViewSearch(card, deferredSearch, bundle.properties, bundle.people)),
    [bundle.cards, fields.filter, bundle.properties, bundle.people, deferredSearch],
  )
  const sorted = useMemo(() => sortProjectCards(filtered, fields.sortOptions, bundle.properties, bundle.people), [filtered, fields.sortOptions, bundle.properties, bundle.people])
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

  // A card's blurb is its first content block; a board that keeps notes in a text property instead
  // still gets one, so the rich card and the day panel are not blank on half the boards out there.
  const descriptionByCard = useMemo(() => {
    const map = new Map<string, string>()
    for (const block of bundle.contents) {
      if (block.type === 'text' && block.title.trim() && !map.has(block.cardId)) map.set(block.cardId, block.title.trim())
    }
    const textProperties = bundle.properties.filter((property) => property.type === 'text')
    for (const card of bundle.cards) {
      if (map.has(card.id)) continue
      for (const property of textProperties) {
        const value = card.values[property.id]?.trim()
        if (value) { map.set(card.id, value); break }
      }
    }
    return map
  }, [bundle.contents, bundle.cards, bundle.properties])

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

  const badgesFor = useCallback((cardId: string): ProjectCardBadges => badgesByCard.get(cardId) ?? EMPTY_BADGES, [badgesByCard])
  const coverFor = useCallback((cardId: string): string | null => publicView ? null : (coverByCard.get(cardId) ?? null), [coverByCard, publicView])
  const descriptionFor = useCallback((cardId: string): string => descriptionByCard.get(cardId) ?? '', [descriptionByCard])
  const patchCardsValues = useEvent(async (ids: readonly string[], values: Record<string, string | null>): Promise<void> => {
    await batchPatchProjectBoard(bundle.board.id, { cards: ids.map((id) => ({ id, patch: { values } })) })
    await onRefresh()
  })
  const changeCalendarMode = useEvent((mode: ProjectViewFields['calendarMode']): void => {
    patchFields({ calendarMode: mode })
  })

  /**
   * One writer for every tick in the app, so the list, the board's checklist and the card menu cannot
   * disagree about which option "done" is. A parent then follows its children.
   */
  const toggleCardDone = useEvent(async (card: ProjectCard, checked: boolean): Promise<void> => {
    const values = projectDonePatch(bundle.properties, checked)
    if (!values) return
    const after: ProjectCard[] = bundle.cards.map((entry) => (entry.id === card.id ? { ...entry, values: { ...entry.values, ...values } as Record<string, string> } : entry))
    const patches = [
      { id: card.id, patch: { values } as Record<string, unknown> },
      ...projectParentDonePatches(after, bundle.properties, card.id).map((parent) => ({ id: parent.id, patch: { values: parent.values } as Record<string, unknown> })),
    ]
    if (onPatchCardsBatch) {
      await onPatchCardsBatch(patches)
      return
    }
    await onPatchCard(patches[0]!.id, patches[0]!.patch)
    for (const entry of patches.slice(1)) await onPatchCard(entry.id, entry.patch)
  })

  const handleAddSubtask = useEvent(async (parentCardId: string): Promise<void> => {
    const name = await prompt({ title: t('project.card.add_subtask'), confirmLabel: t('project.card.add_subtask') })
    if (name === null || !name.trim()) return
    const card = await createProjectCard(bundle.board.id, { title: name.trim(), parentId: parentCardId })
    onCardCreated(card)
  })

  const addCardInColumn = useEvent(async (title: string, optionId: string): Promise<void> => {
    const values = fields.groupById && optionId ? { [fields.groupById]: optionId } : {}
    const card = await createProjectCard(bundle.board.id, { title, values })
    onCardCreated(card)
  })

  const handleCopyLink = useEvent(async (cardId: string): Promise<void> => {
    const url = `${window.location.origin}/project/boards/${encodeURIComponent(bundle.board.id)}?card=${encodeURIComponent(cardId)}`
    try {
      await navigator.clipboard.writeText(url)
      useUi.getState().toast({ title: t('common.copied') })
    } catch {
      useUi.getState().toast({ title: t('project.card.copy_link_failed'), tone: 'danger' })
    }
  })

  const buildCardContextMenu = useEvent((card: ProjectCard): MenuItem[] => buildCardMenu({
    card,
    properties: bundle.properties,
    groupById: fields.groupById,
    datePropertyId: fields.dateDisplayPropertyId,
    canEdit,
    publicView,
    starred: starredCards.includes(card.id),
    pinned: pinnedCards.includes(card.id),
    onOpen: onOpenCard,
    onPatchCard,
    onAddSubtask: handleAddSubtask,
    onDuplicate: (id) => { void duplicateProjectCard(id).then(onRefresh) },
    onCopyLink: (id) => { void handleCopyLink(id) },
    onDelete: onDeleteCard,
    onToggleDone: toggleCardDone,
    onToggleStar: (id) => toggleCardFlag('star', id),
    onTogglePin: (id) => toggleCardFlag('pin', id),
    moveTargets: boards.filter((board) => board.id !== bundle.board.id && (board.role === 'editor' || board.role === 'admin')).map((board) => ({ id: board.id, title: board.title })),
    onMove: (id, targetBoardId) => {
      void moveProjectCard(id, targetBoardId)
        .then(() => { useUi.getState().toast({ title: t('project.card.moved') }); onRefresh() })
        .catch((reason: unknown) => { useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' }) })
    },
  }))

  const onCardContextMenu = useEvent((event: MouseEvent, card: ProjectCard): void => {
    event.preventDefault()
    event.stopPropagation()
    setContextItems(buildCardContextMenu(card))
    setContextPoint({ x: event.clientX, y: event.clientY })
  })

  const selectClick = useEvent((event: MouseEvent, cardId: string): void => {
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
  })

  const runBatch = useEvent(async (action: () => Promise<void>): Promise<boolean> => {
    try {
      await action()
      setSelected([])
      await onRefresh()
      return true
    } catch (reason) {
      useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
      return false
    }
  })
  const batchDelete = useEvent(async (): Promise<void> => {
    const ok = await confirm({
      title: t('project.view.delete_selected'),
      description: t('project.view.delete_selected_hint', { count: selected.length }),
      tone: 'danger',
      confirmLabel: t('common.delete'),
    })
    if (!ok) return
    await runBatch(() => batchDeleteProjectBoard(bundle.board.id, { cardIds: selected }))
  })
  const batchApply = useEvent(async (values: Record<string, string | null>): Promise<void> => {
    const ok = await runBatch(() => batchPatchProjectBoard(bundle.board.id, { cards: selected.map((id) => ({ id, patch: { values } })) }))
    if (ok) setBatchOpen(false)
  })

  // The three keys a reader reaches for on a board: find, add, back out of a selection.
  const searchRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      if (event.key === '/') {
        const field = searchRef.current?.querySelector('input')
        if (field) { event.preventDefault(); field.focus() }
      } else if (event.key === 'n' && canEdit) {
        event.preventDefault()
        void prompt({ title: t('project.board.new_card'), confirmLabel: t('common.save') }).then((name) => {
          if (name && name.trim()) void addCardInColumn(name.trim(), '')
        })
      } else if (event.key === 'Escape') {
        setSelected([])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canEdit, bundle.board.id])

  const hiddenCount = bundle.cards.length - filtered.length
  const columns = useMemo(() => (fields.visiblePropertyIds.length
    ? fields.visiblePropertyIds.map((id) => bundle.properties.find((property) => property.id === id)).filter((property): property is ProjectProperty => Boolean(property))
    : bundle.properties), [fields.visiblePropertyIds, bundle.properties])
  const groupable = bundle.properties.filter((property) => PROJECT_PROPERTY_CAPABILITIES[property.type].canGroup)
  const dateProperties = bundle.properties.filter((property) => property.type === 'date')
  const showsDateDisplay = viewType === 'calendar' || viewType === 'timeline' || viewType === 'gantt' || viewType === 'dashboard'
  const showsGroupBy = viewType === 'board' || viewType === 'table' || viewType === 'gallery' || viewType === 'list'
  const density = fields.cardSize ?? 'comfortable'

  const renameView = useEvent((): void => {
    if (!active) return
    void prompt({ title: t('project.view.rename'), defaultValue: active.title, confirmLabel: t('common.save') }).then((name) => {
      if (name !== null) void enqueueViewPatch(active.id, { title: name.trim() })
    })
  })
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
    onPatchCards: patchCardsValues,
    onPatchFields: patchFields,
    onAddCard: addCardInColumn,
    onAddGroupOption,
    onRenameGroupOption,
    onSetGroupOptionColor,
    onCardContextMenu,
    onToggleCardDone: toggleCardDone,
    onAddSubtask: handleAddSubtask,
    starredCards,
    pinnedCards,
    canMarkDone: projectCanMarkDone(bundle.properties),
    descriptionFor,
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
            onModeChange={changeCalendarMode}
            canEdit={canEdit}
            onOpenCard={onOpenCard}
            onPatchCard={onPatchCard}
            onRefresh={onRefresh}
            descriptionFor={descriptionFor}
            subtasksByParent={subtasksByParent}
          />
        )
      case 'timeline':
        return <TimelineView cards={cards} properties={bundle.properties} links={links} fields={fields} subtasksByParent={subtasksByParent} canEdit={canEdit} onOpenCard={onOpenCard} onPatchFields={patchFields} />
      case 'gantt':
        return <GanttView cards={cards} boardId={bundle.board.id} properties={bundle.properties} links={links} fields={fields} subtasksByParent={subtasksByParent} canEdit={canEdit} onOpenCard={onOpenCard} onPatchCard={onPatchCard} onPatchFields={patchFields} onRefresh={onRefresh} />
      case 'gallery':
        return <GalleryView cards={cards} properties={bundle.properties} chipProperties={columns} fields={fields} badgesFor={badgesFor} coverFor={coverFor} canEdit={canEdit} onOpenCard={onOpenCard} onCardContextMenu={onCardContextMenu} onPatchFields={patchFields} onAddCard={addCardInColumn} />
      case 'list':
        return <ListView cards={cards} properties={bundle.properties} fields={fields} canEdit={canEdit} canMarkDone={projectCanMarkDone(bundle.properties)} badgesFor={badgesFor} onOpenCard={onOpenCard} onCardContextMenu={onCardContextMenu} onAddSubtask={handleAddSubtask} onToggleCardDone={toggleCardDone} onDeleteCard={onDeleteCard} onPatchCard={onPatchCard} onPatchFields={patchFields} onAddCard={addCardInColumn} />
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
      <div
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-subtle)] px-3 py-1.5"
        role="tablist"
        aria-label={t('project.view.tabs')}
        data-view-tabs=""
        onKeyDown={(event) => {
          if (isImeComposing(event)) return
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
          const ids = orderedViews.map((view) => view.id)
          const current = active ? ids.indexOf(active.id) : 0
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length
          const target = orderedViews[next]
          if (!target) return
          event.preventDefault()
          selectView(target.id)
          document.getElementById(`project-view-tab-${target.id}`)?.focus()
        }}
      >
        {orderedViews.map((view) => {
          const TabIcon = VIEW_ICON[view.viewType] ?? Table
          return (
            <button
              key={view.id}
              type="button"
              role="tab"
              id={`project-view-tab-${view.id}`}
              aria-selected={active?.id === view.id}
              aria-controls={active?.id === view.id ? `project-view-panel-${view.id}` : undefined}
              tabIndex={active?.id === view.id ? 0 : -1}
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
        <div ref={searchRef} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
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
            <Seg
              value={fields.boardLayout ?? 'compact'}
              label={t('project.view.board_layout')}
              disabled={!canEdit}
              onChange={(next) => patchFields({ boardLayout: next })}
              options={[
                { value: 'compact', label: t('project.view.layout_compact') },
                { value: 'card', label: t('project.view.layout_card') },
              ]}
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
                <IconButton label={t('project.view.sort')} size="sm" disabled={!canEdit} onClick={() => setSettings('sort')}><ArrowUpDown size={15} /></IconButton>
                <IconButton label={t('project.view.filter')} size="sm" disabled={!canEdit} onClick={() => setSettings('filter')}><Filter size={15} /></IconButton>
                <IconButton label={t('project.view.properties')} size="sm" disabled={!canEdit} onClick={() => setSettings('properties')}><Eye size={15} /></IconButton>
              </>
            )}
          </span>
        </div>
      )}
      {(bundle.contentsTruncated || bundle.commentsTruncated) && (
        <p className="shrink-0 px-3 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]" role="status">
          {publicView ? t('project.board.truncated_public') : t('project.board.truncated')}
        </p>
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
          <Button size="sm" onClick={() => setBatchOpen(true)}>{t('project.view.batch_edit', { count: selected.length })}</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>{t('project.view.clear_selection')}</Button>
        </div>
      )}
      {cards.length === 0 && !EMPTY_CAPABLE_VIEWS.has(viewType)
        ? (
          <ViewEmpty
            title={t('project.board.empty_cards')}
            hint={t('project.view.empty_hint')}
            action={(search.trim() || fields.filter.filters.length > 0)
              ? (
                <Button size="sm" onClick={() => { setSearch(''); patchFields({ filter: emptyProjectViewFields().filter }) }}>
                  {t('project.view.clear_filters')}
                </Button>
              )
              : undefined}
          />
        )
        : (
          <div
            className="flex min-h-0 flex-1 flex-col"
            role="tabpanel"
            id={active ? `project-view-panel-${active.id}` : undefined}
            aria-labelledby={active ? `project-view-tab-${active.id}` : undefined}
          >
            <ProjectPeopleProvider people={bundle.people}>{renderView()}</ProjectPeopleProvider>
          </div>
        )}
      {active && settings === 'sort' && <SortModal view={active} properties={bundle.properties} onClose={() => setSettings(null)} onPatch={(next) => enqueueViewPatch(active.id, { fields: next })} />}
      {active && settings === 'filter' && <FilterModal view={active} properties={bundle.properties} members={bundle.members} people={bundle.people} canEdit={canEdit} onClose={() => setSettings(null)} onPatch={(next) => enqueueViewPatch(active.id, { fields: next })} />}
      {active && settings === 'properties' && <PropertiesModal view={active} properties={bundle.properties} canEdit={canEdit} onClose={() => setSettings(null)} onPatch={(next) => enqueueViewPatch(active.id, { fields: next })} />}
      {contextPoint && <Menu anchor={contextPoint} open onClose={() => setContextPoint(null)} items={contextItems} label={t('project.card.menu')} />}
      {batchOpen && (
        <BatchEditDialog
          count={selected.length}
          properties={bundle.properties}
          members={bundle.members}
          people={bundle.people}
          onClose={() => setBatchOpen(false)}
          onApply={batchApply}
        />
      )}
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
  const people = useProjectPeople()
  const locale = useLocale()
  const keys = projectGroupKeys(cards, fields.swimlaneBy, properties)
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
        return (
          <section key={key || 'none'} className="pv-lane" data-swimlane={key}>
            <h3 className="pv-lane-head">
              <span className="min-w-0 flex-1 truncate">{key === '' ? t('project.view.no_value') : projectGroupLabel(laneProperty, key, people, locale)}</span>
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
