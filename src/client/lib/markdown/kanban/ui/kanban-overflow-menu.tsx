/**
 * The compact header's one trigger for everything it has no room to draw.
 *
 * The board's top bar is laid out against its **own** width, not the window's, and the note gives it
 * as little as a few hundred pixels — a panel beside the editor, or a phone. At that size a labeled
 * control per action does not fit and the row grew to three lines of chrome above a 480px canvas
 * (user report 2026-09-23). Below the header's container breakpoint the bar keeps what a reader
 * reaches for constantly — the view strip, search, new card — and this menu holds the rest.
 *
 * A row here is not a button of its own: it opens the *same* panel the wide control opens, anchored
 * to this trigger instead. That is why the panels are imported rather than copied, and why the two
 * lists of view rows come from `kanban-view-tabs.tsx` — a compact layout that offered a different
 * set of view types, or a different set of things a view can have done to it, would be a second
 * contract for the same field.
 */
import { useId, useRef, useState } from 'react'
import {
  Archive,
  Columns3,
  FileSpreadsheet,
  Image as ImageIcon,
  Filter,
  Maximize2,
  Minimize2,
  Keyboard,
  MoreHorizontal,
  Plus,
  Redo2,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react'
import { Menu, submenuFor, type MenuItem } from '../../../../components/overlay'
import { IconButton } from '../../../../components/primitives'
import { prettyCombo } from '../../../../lib/hotkeys'
import { t, useLocaleRepaint } from '../../../i18n'
import type { KanbanData, KanbanFilter, KanbanSort, KanbanView } from '../types'
import { KanbanArchivePanel, type KanbanArchiveEntry } from './kanban-archive'
import { KanbanCsvDoor, type KanbanCsvEntry } from './kanban-csv'
import { KanbanExportDoor, type KanbanExportEntry } from './kanban-export'
import type { KanbanSchemaOperations } from './kanban-column-hooks'
import { KanbanFilterPopover } from './kanban-filter-popover'
import { KanbanShortcutsPanel } from './kanban-shortcuts'
import { KanbanSortPopover } from './kanban-sort-popover'
import { KanbanViewOptions, type CardSize } from './kanban-view-options'
import { kanbanNewViewItems, kanbanViewActionItems, type KanbanViewOperations } from './kanban-view-tabs'

/** Which of the menu's rows has a panel open under the trigger. One at a time, by construction. */
type OverflowPanel = 'filter' | 'sort' | 'options' | 'csv' | 'export' | 'archive' | 'shortcuts'

export interface KanbanOverflowMenuProps {
  columns: KanbanData['columns']
  views: KanbanView[]
  activeView: KanbanView
  filters: KanbanFilter[]
  sorts: KanbanSort[]
  cardSize?: CardSize
  schemaOps?: KanbanSchemaOperations
  archive?: KanbanArchiveEntry
  csv?: KanbanCsvEntry
  exportEntry?: KanbanExportEntry
  viewOps: KanbanViewOperations
  canUndo?: boolean
  canRedo?: boolean
  isFullscreen?: boolean
  onChangeFilters: (filters: KanbanFilter[]) => void
  onChangeSorts: (sorts: KanbanSort[]) => void
  onChangeGroupBy?: (propId: string) => void
  onChangeSwimlaneBy?: (propId: string | undefined) => void
  onChangeCardSize?: (size: CardSize) => void
  onChangeSumBy?: (propId: string | undefined) => void
  onToggleHiddenColumn?: (propertyId: string) => void
  onToggleCardField?: (propertyId: string) => void
  onUndo?: () => void
  onRedo?: () => void
  onAddItem: () => void
  onToggleFullscreen?: () => void
}

/** The rows that make or unmake something: the card, and the two history steps with their chords. */
function creationRows(props: KanbanOverflowMenuProps): MenuItem[] {
  return [
    { id: 'new-item', label: t('preview.kanban_new_item'), icon: <Plus size={13} />, onSelect: props.onAddItem },
    {
      id: 'undo',
      label: t('common.undo'),
      icon: <Undo2 size={13} />,
      combo: prettyCombo('mod+z').join('+'),
      disabled: !props.canUndo,
      onSelect: props.onUndo,
    },
    {
      id: 'redo',
      label: t('command.redo'),
      icon: <Redo2 size={13} />,
      combo: prettyCombo('mod+shift+z').join('+'),
      disabled: !props.canRedo,
      onSelect: props.onRedo,
    },
  ]
}

/**
 * The rows that decide what is on screen, and the two doors. The filter and the sort carry the menu
 * checkbox while they are in force, so a board showing a filtered subset says so here and not only in
 * the counts — which is the one thing a reader cannot otherwise tell from a narrow bar.
 */
function panelRows(props: KanbanOverflowMenuProps, open: (panel: OverflowPanel) => void): MenuItem[] {
  const { activeView, filters, sorts } = props
  const isColumnPanel = activeView.type === 'table'
  const optionsLabel = t(isColumnPanel ? 'preview.kanban_columns' : 'preview.kanban_group_by')
  return [
    { id: 'filter', label: t('preview.kanban_filter'), icon: <Filter size={13} />, checked: filters.length > 0, separatorBefore: true, onSelect: () => open('filter') },
    // The keyboard reference is a row here because the wide bar keeps its control beside the toolbar's
    // own: a reader on a narrow bar must not be the one reader who cannot find out what the keys do.
    { id: 'shortcuts', label: t('preview.kanban_shortcuts'), icon: <Keyboard size={13} />, onSelect: () => open('shortcuts') },
    { id: 'sort', label: t('preview.kanban_sort'), icon: <SlidersHorizontal size={13} />, checked: sorts.length > 0, onSelect: () => open('sort') },
    ...(props.onChangeGroupBy || isColumnPanel
      ? [{ id: 'options', label: optionsLabel, icon: <Columns3 size={13} />, onSelect: () => open('options') }]
      : []),
    ...(props.csv
      ? [{ id: 'csv', label: t('preview.kanban_csv'), icon: <FileSpreadsheet size={13} />, separatorBefore: true, onSelect: () => open('csv') }]
      : []),
    ...(props.exportEntry
      ? [{ id: 'export', label: t('preview.kanban_export'), icon: <ImageIcon size={13} />, onSelect: () => open('export') }]
      : []),
    ...(props.archive && props.archive.items.length > 0
      ? [{
          id: 'archive',
          label: t('preview.kanban_archived_count', { count: props.archive.items.length }),
          icon: <Archive size={13} />,
          onSelect: () => open('archive'),
        }]
      : []),
  ]
}

/** The view's own management and the way out of the note: what the strip and the toolbar keep. */
function viewRows(props: KanbanOverflowMenuProps): MenuItem[] {
  return [
    {
      id: 'new-view',
      label: t('preview.kanban_new_view'),
      separatorBefore: true,
      submenu: submenuFor(kanbanNewViewItems(props.viewOps.createView)),
    },
    { id: 'view-actions', label: t('preview.kanban_view_actions'), submenu: submenuFor(kanbanViewActionItems(props.views, props.activeView.id, props.viewOps)) },
    ...(props.onToggleFullscreen
      ? [{
          id: 'fullscreen',
          label: t(props.isFullscreen ? 'preview.kanban_exit_fullscreen' : 'preview.kanban_fullscreen'),
          icon: props.isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />,
          separatorBefore: true,
          onSelect: props.onToggleFullscreen,
        }]
      : []),
  ]
}

/**
 * The rows in the order a reader reaches for them: the two that make something, then the three that
 * decide what is on screen, then the two doors, then the view's own management.
 */
function overflowItems(props: KanbanOverflowMenuProps, open: (panel: OverflowPanel) => void): MenuItem[] {
  return [...creationRows(props), ...panelRows(props, open), ...viewRows(props)]
}

/**
 * The panels the rows open. Each is the board's own component, so a rule added in one place shows up
 * in both layouts; only one is ever open, and each is closed by the gesture its own trigger uses.
 */
function OverflowPanels({ props, panel, panelId, anchorRef, onClose }: {
  props: KanbanOverflowMenuProps
  panel: OverflowPanel | null
  panelId: string
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const { activeView } = props
  const shared = { panelId: `${panelId}-panel`, anchorRef, onClose }
  return (
    <>
      <KanbanFilterPopover
        open={panel === 'filter'}
        columns={props.columns}
        filters={props.filters}
        onChangeFilters={props.onChangeFilters}
        {...shared}
      />
      <KanbanSortPopover
        open={panel === 'sort'}
        columns={props.columns}
        sorts={props.sorts}
        onChangeSorts={props.onChangeSorts}
        {...shared}
      />
      <KanbanViewOptions
        open={panel === 'options'}
        columns={props.columns}
        groupBy={activeView.groupBy || 'status'}
        swimlaneBy={activeView.swimlaneBy}
        cardSize={activeView.type === 'board' ? props.cardSize : undefined}
        hiddenColumns={activeView.hiddenColumns}
        cardFields={activeView.cardFields}
        sumBy={activeView.type === 'board' ? activeView.sumBy : undefined}
        onChangeGroupBy={activeView.type === 'board' ? props.onChangeGroupBy : undefined}
        onChangeSwimlaneBy={activeView.type === 'board' ? props.onChangeSwimlaneBy : undefined}
        onChangeCardSize={activeView.type === 'board' ? props.onChangeCardSize : undefined}
        onChangeSumBy={activeView.type === 'board' ? props.onChangeSumBy : undefined}
        onToggleHiddenColumn={activeView.type === 'table' ? props.onToggleHiddenColumn : undefined}
        onToggleCardField={activeView.type === 'board' ? props.onToggleCardField : undefined}
        schemaOps={activeView.type === 'table' ? props.schemaOps : undefined}
        {...shared}
      />
      {props.csv && (
        <KanbanCsvDoor entry={props.csv} open={panel === 'csv'} {...shared} />
      )}
      {props.exportEntry && <KanbanExportDoor entry={props.exportEntry} open={panel === 'export'} {...shared} />}
      {props.archive && (
        <KanbanArchivePanel {...props.archive} open={panel === 'archive'} {...shared} />
      )}
      <KanbanShortcutsPanel open={panel === 'shortcuts'} {...shared} />
    </>
  )
}

export function KanbanOverflowMenu(props: KanbanOverflowMenuProps) {
  useLocaleRepaint()
  const [isOpen, setIsOpen] = useState(false)
  const [panel, setPanel] = useState<OverflowPanel | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const label = t('preview.kanban_more_actions')

  // Opening a row's panel closes the menu first: two overlapping surfaces under one trigger would
  // each be closed by the other's Escape, and the panel is placed against the trigger either way.
  const openPanel = (next: OverflowPanel) => {
    setPanel(next)
    setIsOpen(false)
  }

  return (
    <>
      <IconButton
        ref={btnRef}
        label={label}
        data-kanban-overflow
        onClick={() => setIsOpen((o) => !o)}
        aria-haspopup='menu'
        aria-expanded={isOpen}
        {...(isOpen ? { 'aria-controls': panelId } : {})}
        className={(isOpen || panel !== null) ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : undefined}
      >
        <MoreHorizontal size={15} aria-hidden />
      </IconButton>
      <Menu
        anchor={btnRef}
        open={isOpen}
        onClose={() => setIsOpen(false)}
        items={overflowItems(props, openPanel)}
        panelId={panelId}
        label={label}
        align='end'
      />
      <OverflowPanels props={props} panel={panel} panelId={panelId} anchorRef={btnRef} onClose={() => setPanel(null)} />
    </>
  )
}
