import { memo, useId, useMemo, useRef, useState } from 'react'
import {
  Columns3,
  Filter,
  Maximize2,
  Minimize2,
  Plus,
  Redo2,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react'
import { Button, IconButton } from '../../../../components/primitives'
import type { KanbanData, KanbanFilter, KanbanSort, KanbanView } from '../types'
import { t, useLocaleRepaint } from '../../../i18n'
import { prettyCombo } from '../../../../lib/hotkeys'
import { kanbanActiveItems } from '../archive'
import { kanbanStatusColumn, kanbanTagsColumn } from '../view-ops'
import { KanbanArchiveAction, type KanbanArchiveEntry } from './kanban-archive'
import { KanbanCsvAction, type KanbanCsvEntry } from './kanban-csv'
import { KanbanExportAction, type KanbanExportEntry } from './kanban-export'
import type { KanbanSchemaOperations } from './kanban-column-hooks'
import { KanbanFilterPopover } from './kanban-filter-popover'
import {
  CompactOnly,
  narrowLabel,
  STATUS_PROGRESS_BAR_HEIGHT,
  TOOLBAR_ICON_CLASS,
  WideOnly,
} from './kanban-header-layout'
import { KanbanBoardTitle } from './kanban-title'
import { KanbanOverflowMenu } from './kanban-overflow-menu'
import { KanbanProgressBar } from './kanban-progress-bar'
import { KanbanQuickFilterBar } from './kanban-quick-filter-bar'
import { KanbanSearchBox } from './kanban-search-box'
import { KanbanShortcutsAction } from './kanban-shortcuts'
import { KanbanSortPopover } from './kanban-sort-popover'
import { KanbanTagFilterBar } from './kanban-tag-filter-bar'
import { KanbanViewOptions, type CardSize } from './kanban-view-options'
import { KanbanViewTabs, type KanbanViewOperations } from './kanban-view-tabs'
import { KanbanWriteStatus } from './kanban-write-status'

interface KanbanHeaderProps {
  data: KanbanData
  visibleItems: KanbanData['items']
  activeView: KanbanView
  searchQuery: string
  filters: KanbanFilter[]
  sorts: KanbanSort[]
  selectedTags?: string[]
  cardSize?: CardSize
  isFullscreen?: boolean
  canUndo?: boolean
  canRedo?: boolean
  unsaved?: boolean
  onUndo?: () => void
  onRedo?: () => void
  onRetryWrite?: () => void
  onDiscardWrite?: () => void
  onUpdateBoardTitle?: (title: string) => void
  onSelectView: (viewId: string) => void
  onSearchChange: (q: string) => void
  onChangeFilters: (filters: KanbanFilter[]) => void
  onChangeSorts: (sorts: KanbanSort[]) => void
  onToggleTag?: (tag: string) => void
  onClearTags?: () => void
  onChangeCardSize?: (size: CardSize) => void
  onChangeGroupBy?: (propId: string) => void
  onChangeSwimlaneBy?: (propId: string | undefined) => void
  onChangeSumBy?: (propId: string | undefined) => void
  onToggleHiddenColumn?: (propertyId: string) => void
  onToggleCardField?: (propertyId: string) => void
  onAddItem: () => void
  onToggleFullscreen?: () => void
  archive?: KanbanArchiveEntry
  csv?: KanbanCsvEntry
  exportEntry?: KanbanExportEntry
  viewOps: KanbanViewOperations
  schemaOps?: KanbanSchemaOperations
  viewPanelId: string
}

// The action cluster is the header minus the view switcher, so it takes the same props; `columns` is
// the one thing it reads that the header spells out as `data`.
type HeaderActionsProps = KanbanHeaderProps & { columns: KanbanData['columns'] }

function KanbanViewOptionsAction({
  columns,
  groupBy,
  swimlaneBy,
  cardSize,
  hiddenColumns,
  cardFields,
  sumBy,
  onChangeGroupBy,
  onChangeSwimlaneBy,
  onChangeCardSize,
  onChangeSumBy,
  onToggleHiddenColumn,
  onToggleCardField,
  schemaOps,
}: {
  columns: KanbanData['columns']
  groupBy: string
  swimlaneBy?: string
  cardSize?: CardSize
  hiddenColumns?: string[]
  cardFields?: string[]
  sumBy?: string
  onChangeGroupBy?: (propId: string) => void
  onChangeSwimlaneBy?: (propId: string | undefined) => void
  onChangeCardSize?: (size: CardSize) => void
  onChangeSumBy?: (propId: string | undefined) => void
  onToggleHiddenColumn?: (propertyId: string) => void
  onToggleCardField?: (propertyId: string) => void
  schemaOps?: KanbanSchemaOperations
}) {
  const [isOpen, setIsOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  // The column panel needs nothing but its toggle; the board panel keeps its
  // older rule of showing up only once both of its own writers are wired.
  const isColumnPanel = onToggleHiddenColumn !== undefined
  if (!isColumnPanel && (!onChangeGroupBy || !onChangeCardSize || !cardSize)) return null
  const label = t(isColumnPanel ? 'preview.kanban_columns' : 'preview.kanban_group_by')

  return (
    <>
      <Button
        ref={btnRef}
        size='sm'
        variant='ghost'
        icon={isColumnPanel ? <Columns3 size={13} aria-hidden /> : <SlidersHorizontal size={13} aria-hidden />}
        onClick={() => setIsOpen((o) => !o)}
        aria-label={label}
        aria-haspopup='dialog'
        aria-expanded={isOpen}
        {...(isOpen ? { 'aria-controls': panelId } : {})}
      >
        {narrowLabel(label)}
      </Button>
      <KanbanViewOptions
        open={isOpen}
        panelId={panelId}
        onClose={() => setIsOpen(false)}
        anchorRef={btnRef}
        columns={columns}
        groupBy={groupBy}
        swimlaneBy={swimlaneBy}
        cardSize={cardSize}
        hiddenColumns={hiddenColumns}
        cardFields={cardFields}
        sumBy={sumBy}
        onChangeGroupBy={onChangeGroupBy}
        onChangeSwimlaneBy={onChangeSwimlaneBy}
        onChangeCardSize={onChangeCardSize}
        onChangeSumBy={onChangeSumBy}
        onToggleHiddenColumn={onToggleHiddenColumn}
        onToggleCardField={onToggleCardField}
        schemaOps={schemaOps}
      />
    </>
  )
}

function KanbanFilterAction({
  columns,
  filters,
  onChangeFilters,
}: {
  columns: KanbanData['columns']
  filters: KanbanFilter[]
  onChangeFilters: (filters: KanbanFilter[]) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  return (
    <>
      <Button
        ref={btnRef}
        size='sm'
        variant='ghost'
        icon={<Filter size={13} aria-hidden />}
        trailing={filters.length > 0 ? <span className='size-1.5 rounded-full bg-[var(--accent)]' /> : undefined}
        className={filters.length > 0 ? 'text-[var(--accent)] font-semibold' : undefined}
        onClick={() => setIsOpen((o) => !o)}
        aria-label={t('preview.kanban_filter')}
        aria-haspopup='dialog'
        aria-expanded={isOpen}
        {...(isOpen ? { 'aria-controls': panelId } : {})}
      >
        {narrowLabel(t('preview.kanban_filter'))}
      </Button>
      <KanbanFilterPopover
        open={isOpen}
        panelId={panelId}
        onClose={() => setIsOpen(false)}
        anchorRef={btnRef}
        columns={columns}
        filters={filters}
        onChangeFilters={onChangeFilters}
      />
    </>
  )
}

function KanbanSortAction({
  columns,
  sorts,
  onChangeSorts,
}: {
  columns: KanbanData['columns']
  sorts: KanbanSort[]
  onChangeSorts: (sorts: KanbanSort[]) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  return (
    <>
      <Button
        ref={btnRef}
        size='sm'
        variant='ghost'
        icon={<SlidersHorizontal size={13} aria-hidden />}
        trailing={sorts.length > 0 ? <span className='size-1.5 rounded-full bg-[var(--accent)]' /> : undefined}
        className={sorts.length > 0 ? 'text-[var(--accent)] font-semibold' : undefined}
        onClick={() => setIsOpen((o) => !o)}
        aria-label={t('preview.kanban_sort')}
        aria-haspopup='dialog'
        aria-expanded={isOpen}
        {...(isOpen ? { 'aria-controls': panelId } : {})}
      >
        {narrowLabel(t('preview.kanban_sort'))}
      </Button>
      <KanbanSortPopover
        open={isOpen}
        panelId={panelId}
        onClose={() => setIsOpen(false)}
        anchorRef={btnRef}
        columns={columns}
        sorts={sorts}
        onChangeSorts={onChangeSorts}
      />
    </>
  )
}

function KanbanHeaderToolbar({
  onAddItem,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  isFullscreen,
  onToggleFullscreen,
}: {
  onAddItem: () => void
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
}) {
  const undoHint = t('preview.kanban_undo_shortcut', { shortcut: prettyCombo('mod+z').join('+') })
  const redoHint = t('preview.kanban_redo_shortcut', { shortcut: prettyCombo('mod+shift+z').join('+') })
  // Four more icon controls is what would leave the view strip no room at all in a note pane, and
  // every one of the four is a row of the compact header's own menu — with the undo and redo chords
  // named there as the menu's shortcuts.
  return (
    <div className='hidden @4xl:flex items-center gap-1'>
      {onUndo && (
        <button
          type='button'
          disabled={!canUndo}
          onClick={onUndo}
          className={TOOLBAR_ICON_CLASS}
          title={undoHint}
          aria-label={t('common.undo')}
        >
          <Undo2 size={14} aria-hidden />
        </button>
      )}
      {onRedo && (
        <button
          type='button'
          disabled={!canRedo}
          onClick={onRedo}
          className={TOOLBAR_ICON_CLASS}
          title={redoHint}
          aria-label={t('command.redo')}
        >
          <Redo2 size={14} aria-hidden />
        </button>
      )}
      <Button variant='primary' size='sm' icon={<Plus size={14} aria-hidden />} onClick={onAddItem} aria-label={t('preview.kanban_new_item')}>
        {narrowLabel(t('preview.kanban_new_item'))}
      </Button>
      <KanbanShortcutsAction />
      {onToggleFullscreen && (
        <IconButton
          label={isFullscreen ? t('preview.kanban_exit_fullscreen') : t('preview.kanban_fullscreen')}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
        </IconButton>
      )}
    </div>
  )
}

/**
 * The labeled cluster: one control per action, words and all. It is what the full screen board draws,
 * and everything in it is also a row of the compact menu — the two lists are asserted against each
 * other so the narrow layout cannot offer less than the wide one.
 */
/** What the view options panel takes, as the active view and its writers spell it. */
function viewOptionsProps(props: HeaderActionsProps) {
  const { activeView } = props
  const isBoard = activeView.type === 'board'
  return {
    columns: props.columns,
    groupBy: activeView.groupBy || 'status',
    swimlaneBy: activeView.swimlaneBy,
    cardSize: isBoard ? props.cardSize : undefined,
    hiddenColumns: activeView.hiddenColumns,
    cardFields: activeView.cardFields,
    sumBy: isBoard ? activeView.sumBy : undefined,
    onChangeGroupBy: isBoard ? props.onChangeGroupBy : undefined,
    onChangeSwimlaneBy: isBoard ? props.onChangeSwimlaneBy : undefined,
    onChangeCardSize: isBoard ? props.onChangeCardSize : undefined,
    onChangeSumBy: isBoard ? props.onChangeSumBy : undefined,
    onToggleHiddenColumn: activeView.type === 'table' ? props.onToggleHiddenColumn : undefined,
    onToggleCardField: isBoard ? props.onToggleCardField : undefined,
    schemaOps: activeView.type === 'table' ? props.schemaOps : undefined,
  }
}

function KanbanWideActions(props: HeaderActionsProps) {
  const { columns, activeView, filters, sorts } = props
  return (
    <WideOnly>
      <KanbanFilterAction columns={columns} filters={filters} onChangeFilters={props.onChangeFilters} />
      <KanbanSortAction columns={columns} sorts={sorts} onChangeSorts={props.onChangeSorts} />
      {props.archive && <KanbanArchiveAction {...props.archive} />}
      {props.csv && <KanbanCsvAction {...props.csv} />}
      {props.exportEntry && <KanbanExportAction entry={props.exportEntry} />}
      {(activeView.type === 'board' || activeView.type === 'table') && (
        <KanbanViewOptionsAction {...viewOptionsProps(props)} />
      )}
    </WideOnly>
  )
}

/** The narrow cluster: the one trigger whose menu holds everything above, plus the toolbar's four. */
function KanbanCompactActions(props: HeaderActionsProps) {
  // The menu reads the active view's own card fields, the same way it reads its hidden columns. The
  // header's props cover the menu's whole surface, so they travel as the spread rather than row by row.
  return (
    <CompactOnly>
      <KanbanOverflowMenu {...props} views={props.data.views} />
    </CompactOnly>
  )
}

function KanbanHeaderActions(props: HeaderActionsProps) {
  const { columns, visibleItems, searchQuery } = props
  const statusCol = kanbanStatusColumn(columns)

  return (
    // A phone gets a row that wraps instead of a row that runs off the viewport, and never a scroll
    // box: the filter, sort and options panels hang off this element, and an `overflow` here would
    // clip them to the row they are anchored to.
    <div
      data-kanban-actions
      className='relative flex min-w-0 flex-wrap items-center gap-1.5'
    >
      <div className='hidden @4xl:flex items-center mr-1 w-28'>
        <KanbanProgressBar items={visibleItems} statusColumn={statusCol} height={STATUS_PROGRESS_BAR_HEIGHT} />
      </div>
      <KanbanSearchBox searchQuery={searchQuery} onSearchChange={props.onSearchChange} />
      <KanbanWideActions {...props} />
      <KanbanCompactActions {...props} />
      <KanbanWriteStatus unsaved={props.unsaved} onRetry={props.onRetryWrite} onDiscard={props.onDiscardWrite} />
      <KanbanHeaderToolbar
        onAddItem={props.onAddItem}
        canUndo={props.canUndo}
        canRedo={props.canRedo}
        onUndo={props.onUndo}
        onRedo={props.onRedo}
        isFullscreen={props.isFullscreen}
        onToggleFullscreen={props.onToggleFullscreen}
      />
    </div>
  )
}

/**
 * The board's own name, in the overlay, and the strip of views beside it. The note draws that same
 * name in the block's own head instead (written there by the registry, which is the only layer holding
 * the parsed body): this bar in a note pane is a few hundred pixels wide, and a name drawn here took
 * the room the view strip has to scroll its own tab into (measured by the visual gate, 2026-09-23).
 * The head has room for it; the bar does not, and the strip is the half that must not be squeezed.
 */
function KanbanHeaderIdentity({
  title,
  isFullscreen,
  onUpdateTitle,
  views,
  activeView,
  panelId,
  onSelectView,
  viewOps,
}: {
  title?: string
  isFullscreen?: boolean
  onUpdateTitle?: (title: string) => void
  views: KanbanData['views']
  activeView: KanbanView
  panelId: string
  onSelectView: (viewId: string) => void
  viewOps: KanbanViewOperations
}) {
  return (
    <div className='flex min-w-0 flex-1 items-center gap-2.5'>
      {isFullscreen && (
        <>
          <KanbanBoardTitle title={title} onUpdateTitle={onUpdateTitle} />
          <div className='h-4 w-px bg-[var(--border-subtle)] shrink-0' />
        </>
      )}
      <KanbanViewTabs
        views={views}
        activeViewId={activeView.id}
        panelId={panelId}
        onSelectView={onSelectView}
        viewOps={viewOps}
      />
    </div>
  )
}

export const KanbanHeader = memo(function KanbanHeader(props: KanbanHeaderProps) {
  useLocaleRepaint()
  const { data, activeView, isFullscreen, onUpdateBoardTitle } = props
  const tagsCol = kanbanTagsColumn(data.columns)
  // The tag bar offers values a reader could filter the live board down to; a tag that only
  // survives on archived cards would promise an empty result. The scan is memoized on the item list
  // because that array is the bar's own count memo key: rebuilt per render it walked the whole board
  // again on every repaint -- a language switch, a drag highlight, any commit at all -- none of which
  // move a tag.
  const activeItems = useMemo(() => kanbanActiveItems(data.items), [data.items])

  return (
    <div
      data-kanban-header
      // `@container`: everything inside the bar is sized against the bar, not the window. It is what
      // lets a note pane and a full screen board draw the same component at their own widths.
      className='@container flex flex-col gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-2'
    >
      <div className='flex flex-wrap items-center justify-between gap-2.5'>
        <KanbanHeaderIdentity
          title={data.title}
          isFullscreen={isFullscreen}
          onUpdateTitle={onUpdateBoardTitle}
          views={data.views}
          activeView={activeView}
          panelId={props.viewPanelId}
          onSelectView={props.onSelectView}
          viewOps={props.viewOps}
        />
        <KanbanHeaderActions {...props} columns={data.columns} activeView={activeView} />
      </div>

      <div className='flex flex-wrap items-center gap-x-3 gap-y-1.5'>
        <KanbanQuickFilterBar
          columns={data.columns}
          filters={props.filters}
          onChangeFilters={props.onChangeFilters}
        />
        <KanbanTagFilterBar
          tagsColumn={tagsCol}
          items={activeItems}
          selectedTags={props.selectedTags}
          onToggleTag={props.onToggleTag}
          onClearTags={props.onClearTags}
        />
      </div>
    </div>
  )
})
