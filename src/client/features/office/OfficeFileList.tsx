import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { AlertTriangle, ArrowUpDown, FolderInput, ListChecks, MoreHorizontal, Pin, Plus, RefreshCw, RotateCcw, Search, Star, Tags, Trash2, X } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import type { OfficeFileType } from '@shared/office/constants'
import type { OfficeFileSummary, OfficeTag } from '@shared/office/model'
import { useLocale, t } from '../../lib/i18n'
import { isImeComposing } from '../../lib/ime'
import { cn } from '../../lib/cn'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Checkbox, Input, Segmented } from '../../components/form'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Menu, Tooltip, useContextMenu, type MenuItem } from '../../components/overlay'
import { Tabs } from '../../components/tabs'
import type { OfficeSmartView, OfficeListState } from './office-address'
import { beginOfficeDrag, endOfficeDrag } from './office-drag'
import {
  blankAreaMenuItems,
  fileMenuItems,
  officeNewFileMenuItems,
  officeSortMenuItems,
  officeTypeIcon,
  officeTypeLabel,
  officeViewIcon,
  officeViewLabel,
  type OfficeFileMenuInput,
} from './office-menus'
import type { OfficeFileTypeFilter, OfficeSortDirection, OfficeSortKey, OfficeViewMode } from './office-prefs'
import { OFFICE_VIEW_MODES } from './office-prefs'

export interface OfficeBreadcrumb {
  label: string
  state: OfficeListState
}

/** Everything a file row may do. One object so the three layouts cannot drift apart. */
export interface OfficeFileActions {
  onOpen: (file: OfficeFileSummary) => void
  onRename: (file: OfficeFileSummary) => void
  onDuplicate: (file: OfficeFileSummary) => void
  onDownload: (file: OfficeFileSummary) => void
  onToggleStar: (files: readonly OfficeFileSummary[]) => void
  onTogglePin: (file: OfficeFileSummary) => void
  onCopy: (files: readonly OfficeFileSummary[]) => void
  onCut: (files: readonly OfficeFileSummary[]) => void
  onPaste: (folderId: string | null) => void
  onMove: (files: readonly OfficeFileSummary[]) => void
  onAddTag: (files: readonly OfficeFileSummary[], tagIds: string[]) => void
  onVersions: (file: OfficeFileSummary) => void
  onDetails: (file: OfficeFileSummary) => void
  onDelete: (files: readonly OfficeFileSummary[]) => void
  onRestore: (files: readonly OfficeFileSummary[]) => void
  onPurge: (files: readonly OfficeFileSummary[]) => void
  onCreateFile: (type: OfficeFileType) => void
  onCreateFolder: () => void
  onImport: () => void
  onRefresh: () => void
}

export interface OfficeFileListProps extends OfficeFileActions {
  files: readonly OfficeFileSummary[]
  status: 'loading' | 'ready' | 'error'
  error: string | null
  query: string
  typeFilter: OfficeFileTypeFilter
  viewMode: OfficeViewMode
  sortKey: OfficeSortKey
  sortDir: OfficeSortDirection
  showCheckboxes: boolean
  activeView: OfficeSmartView
  currentFolderId: string | null
  breadcrumbs: readonly OfficeBreadcrumb[]
  tags: readonly OfficeTag[]
  selected: ReadonlySet<string>
  clipboardHasFiles: boolean
  onSearchChange: (query: string) => void
  onTypeChange: (type: OfficeFileTypeFilter) => void
  onSortChange: (key: OfficeSortKey, dir: OfficeSortDirection) => void
  onViewModeChange: (mode: OfficeViewMode) => void
  onToggleCheckboxes: () => void
  onSelectChange: (ids: ReadonlySet<string>) => void
  onNavigate: (state: OfficeListState) => void
}

const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>()

function fileDate(timestamp: number, locale: string): string {
  if (!timestamp) return ''
  let formatter = DATE_FORMATS.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    DATE_FORMATS.set(locale, formatter)
  }
  return formatter.format(timestamp)
}

function typeTabItems(): Array<{ id: OfficeFileTypeFilter; label: string }> {
  return [
    { id: 'all', label: t('office.type.all') },
    { id: 'sheets', label: t('office.type.sheets') },
    { id: 'docs', label: t('office.type.docs') },
    { id: 'slides', label: t('office.type.slides') },
    { id: 'bases', label: t('office.type.bases') },
    { id: 'boards', label: t('office.type.boards') },
    { id: 'pdfs', label: t('office.type.pdfs') },
  ]
}

export function OfficeFileList(props: OfficeFileListProps) {
  const {
    files, status, error, query, typeFilter, viewMode, sortKey, sortDir, showCheckboxes,
    activeView, currentFolderId, breadcrumbs, tags, selected, clipboardHasFiles,
  } = props
  const locale = useLocale()
  const [search, setSearch] = useState(query)
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  /** The breadcrumb row has its own "+", so a file can be created without leaving the current folder. */
  const [crumbMenuAnchor, setCrumbMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const newButtonRef = useRef<HTMLButtonElement>(null)
  const sortButtonRef = useRef<HTMLButtonElement>(null)
  const tagButtonRef = useRef<HTMLButtonElement>(null)
  const blankMenu = useContextMenu()
  const listRef = useRef<HTMLDivElement>(null)
  const onSearchChange = props.onSearchChange

  useEffect(() => {
    setSearch(query)
  }, [query])

  useEffect(() => {
    const next = search.trim()
    if (next === query) return
    const timer = window.setTimeout(() => onSearchChange(next), 300)
    return () => window.clearTimeout(timer)
  }, [search, query, onSearchChange])

  const selectedFiles = useMemo(() => files.filter((file) => selected.has(file.id)), [files, selected])

  const newFileItems: MenuItem[] = [
    ...officeNewFileMenuItems(props.onCreateFile),
    {
      id: 'new-folder',
      label: t('office.menu.blank.new_folder'),
      separatorBefore: true,
      onSelect: props.onCreateFolder,
    },
    {
      id: 'import',
      label: t('office.action.import'),
      onSelect: props.onImport,
    },
  ]

  useEffect(() => {
    if (anchorId && !files.some((file) => file.id === anchorId)) setAnchorId(null)
  }, [files, anchorId])

  const toggleFile = (file: OfficeFileSummary, range: boolean) => {
    const next = new Set(selected)
    if (range && anchorId) {
      const from = files.findIndex((entry) => entry.id === anchorId)
      const to = files.findIndex((entry) => entry.id === file.id)
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        const rangeIds = files.slice(start, end + 1).map((entry) => entry.id)
        const allSelected = rangeIds.every((id) => next.has(id))
        for (const id of rangeIds) {
          if (allSelected) next.delete(id)
          else next.add(id)
        }
        props.onSelectChange(next)
        return
      }
    }
    if (next.has(file.id)) next.delete(file.id)
    else next.add(file.id)
    setAnchorId(file.id)
    props.onSelectChange(next)
  }

  const selectAll = () => {
    props.onSelectChange(new Set(files.map((file) => file.id)))
    setAnchorId(files[0]?.id ?? null)
  }

  const clearSelection = () => {
    props.onSelectChange(new Set())
    setAnchorId(null)
  }

  const blankItems: MenuItem[] = blankAreaMenuItems({
    viewMode,
    sortKey,
    sortDir,
    clipboardEmpty: !clipboardHasFiles,
    onCreateFile: props.onCreateFile,
    onCreateFolder: props.onCreateFolder,
    onPaste: () => props.onPaste(currentFolderId),
    onRefresh: props.onRefresh,
    onImport: props.onImport,
    onViewMode: props.onViewModeChange,
    onSort: props.onSortChange,
  })

  const onBlankContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest('[data-office-file]')) return
    blankMenu.onContextMenu(event)
  }

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return
    const target = event.target as HTMLElement
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable
    if (typing) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'a') {
      event.preventDefault()
      selectAll()
      return
    }
    if (event.key === 'Escape' && selected.size > 0) {
      event.preventDefault()
      clearSelection()
      return
    }
    if (files.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const index = files.findIndex((file) => selected.has(file.id))
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = index < 0
        ? (step > 0 ? 0 : files.length - 1)
        : Math.min(files.length - 1, Math.max(0, index + step))
      const target = files[next]
      if (!target) return
      props.onSelectChange(new Set([target.id]))
      listRef.current?.querySelector<HTMLElement>(`[data-office-file-id="${CSS.escape(target.id)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter' && selectedFiles.length === 1) {
      event.preventDefault()
      props.onOpen(selectedFiles[0]!)
      return
    }
    if (event.key === 'Delete' && selectedFiles.length > 0) {
      event.preventDefault()
      props.onDelete(selectedFiles)
      return
    }
    if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && !blankMenu.point) {
      if (event.target instanceof Element && event.target.closest('[data-office-file]')) return
      event.preventDefault()
      const rect = listRef.current?.getBoundingClientRect()
      if (rect) blankMenu.openAt({ x: rect.left + 24, y: rect.top + 40 })
    }
  }

  const tagMenuItems: MenuItem[] = tags.map((tag): MenuItem => ({
    id: `tag-${tag.id}`,
    label: `#${tag.name}`,
    onSelect: () => props.onAddTag(selectedFiles, [tag.id]),
  }))

  const emptyAction = (
    <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={() => setNewMenuOpen(true)}>
      {t('office.action.new_file')}
    </Button>
  )

  const searching = query.length > 0
  const emptyTitle = searching
    ? t('office.empty.search.title')
    : activeView === 'trash'
      ? t('office.empty.trash.title')
      : t('office.empty.title')
  const emptyDescription = searching
    ? t('office.empty.search.description')
    : activeView === 'trash'
      ? t('office.empty.trash.description')
      : t('office.empty.description')

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-base)]">
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--border-subtle)] px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="min-w-[150px] flex-1 sm:max-w-[320px]">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('office.search.placeholder')}
              aria-label={t('office.search.placeholder')}
              leading={<Search size={13} />}
              trailing={search
                ? (
                    <IconButton label={t('office.search.clear')} size="xs" onClick={() => setSearch('')}>
                      <X size={12} />
                    </IconButton>
                  )
                : undefined}
              className="h-8"
            />
          </div>
          <Segmented<OfficeViewMode>
            value={viewMode}
            size="sm"
            label={t('office.view.label')}
            options={OFFICE_VIEW_MODES.map((mode) => ({
              value: mode,
              label: officeViewIcon(mode),
              title: officeViewLabel(mode),
            }))}
            onChange={props.onViewModeChange}
          />
          <Button
            ref={sortButtonRef}
            size="sm"
            variant="secondary"
            icon={<ArrowUpDown size={13} />}
            aria-label={t('office.sort.title')}
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
            onClick={() => setSortMenuOpen((open) => !open)}
          >
            <span className="hidden md:inline">{t('office.sort.title')}</span>
          </Button>
          <Tooltip label={showCheckboxes ? t('office.view.hide_checkboxes') : t('office.view.show_checkboxes')}>
            <IconButton
              label={showCheckboxes ? t('office.view.hide_checkboxes') : t('office.view.show_checkboxes')}
              active={showCheckboxes}
              onClick={props.onToggleCheckboxes}
            >
              <ListChecks size={15} />
            </IconButton>
          </Tooltip>
          <Button ref={newButtonRef} size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setNewMenuOpen(true)}>
            <span className="hidden sm:inline">{t('office.action.new_file')}</span>
          </Button>
          <IconButton label={t('office.action.refresh')} onClick={props.onRefresh}>
            <RefreshCw size={15} />
          </IconButton>
        </div>
        <Tabs<OfficeFileTypeFilter>
          value={typeFilter}
          onChange={props.onTypeChange}
          label={t('office.filter.types')}
          items={typeTabItems()}
        />
      </header>

      <nav aria-label={t('office.pane.files')} className="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--border-subtle)] px-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        {breadcrumbs.map((crumb, index) => {
          const last = index === breadcrumbs.length - 1
          return (
            <span key={`${crumb.state.folderId ?? ''}:${crumb.state.tagId ?? ''}:${crumb.state.view}:${index}`} className="flex min-w-0 shrink-0 items-center gap-0.5">
              {index > 0 && <span className="opacity-60" aria-hidden="true">/</span>}
              <button
                type="button"
                aria-current={last ? 'page' : undefined}
                onClick={() => props.onNavigate(crumb.state)}
                className="max-w-[220px] truncate rounded-[var(--r-sm)] px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] aria-[current=page]:font-medium aria-[current=page]:text-[var(--text-primary)]"
              >
                {crumb.label}
              </button>
            </span>
          )
        })}
        <span className="ml-1 flex shrink-0 items-center">
          <IconButton
            label={t('office.crumb.new')}
            size="xs"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setCrumbMenuAnchor({ x: rect.left, y: rect.bottom + 4 })
            }}
          >
            <Plus size={12} />
          </IconButton>
        </span>
      </nav>

      {selected.size > 0 && (
        <div role="toolbar" aria-label={t('office.batch.selected', { count: selected.size })} className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
          <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">
            {t('office.batch.selected', { count: selected.size })}
          </span>
          {activeView === 'trash'
            ? (
                <>
                  <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => props.onRestore(selectedFiles)}>
                    {t('office.action.restore')}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-[var(--danger)]" icon={<Trash2 size={13} />} onClick={() => props.onPurge(selectedFiles)}>
                    {t('office.action.purge')}
                  </Button>
                </>
              )
            : (
                <>
                  <Button size="sm" variant="secondary" icon={<FolderInput size={13} />} onClick={() => props.onMove(selectedFiles)}>
                    {t('office.batch.move')}
                  </Button>
                  <Button ref={tagButtonRef} size="sm" variant="secondary" icon={<Tags size={13} />} aria-haspopup="menu" aria-expanded={tagMenuOpen} onClick={() => setTagMenuOpen((open) => !open)}>
                    {t('office.batch.tag')}
                  </Button>
                  <Button size="sm" variant="secondary" icon={<Star size={13} />} onClick={() => props.onToggleStar(selectedFiles)}>
                    {t('office.batch.star')}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-[var(--danger)]" icon={<Trash2 size={13} />} onClick={() => props.onDelete(selectedFiles)}>
                    {t('office.batch.delete')}
                  </Button>
                </>
              )}
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            {t('office.batch.clear')}
          </Button>
          {selectedFiles.length > 0 && (
            <span className="ml-auto text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
              {formatBytes(selectedFiles.reduce((sum, file) => sum + file.size, 0))}
            </span>
          )}
        </div>
      )}

      <div
        ref={listRef}
        role="region"
        tabIndex={-1}
        aria-label={t('office.pane.files')}
        aria-busy={status === 'loading'}
        className="relative min-h-0 flex-1 overflow-auto"
        onContextMenu={onBlankContextMenu}
        onKeyDown={onListKeyDown}
      >
        {status === 'loading' && files.length === 0 && <LoadingBlock label={t('common.loading')} />}
        {status === 'error' && files.length === 0 && (
          <div role="alert" className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <AlertTriangle size={24} className="text-[var(--danger)]" aria-hidden="true" />
            <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('office.error.load')}</p>
            {error && <p className="max-w-[420px] text-[length:var(--text-11)] text-[var(--text-tertiary)]">{error}</p>}
            <Button variant="secondary" size="sm" onClick={props.onRefresh}>{t('office.error.retry')}</Button>
          </div>
        )}
        {status !== 'loading' && status !== 'error' && files.length === 0 && (
          <Empty art={searching ? 'search' : 'notes'} title={emptyTitle} description={emptyDescription} action={emptyAction} />
        )}
        {files.length > 0 && viewMode === 'list' && (
          <div role="list" aria-label={t('office.pane.files')} className="flex flex-col">
            {files.map((file) => (
              <FileTile
                key={file.id}
                variant="row"
                file={file}
                selected={selected}
                selectedFiles={selectedFiles}
                tags={tags}
                clipboardHasFiles={clipboardHasFiles}
                showCheckboxes={showCheckboxes}
                trashed={activeView === 'trash'}
                locale={locale}
                onToggleSelect={toggleFile}
                actions={props}
              />
            ))}
          </div>
        )}
        {files.length > 0 && viewMode !== 'list' && (
          <div
            role="list"
            aria-label={t('office.pane.files')}
            className={cn(
              'grid gap-2 p-2',
              viewMode === 'card' ? 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3',
            )}
          >
            {files.map((file) => (
              <FileTile
                key={file.id}
                variant={viewMode === 'gallery' ? 'gallery' : 'card'}
                file={file}
                selected={selected}
                selectedFiles={selectedFiles}
                tags={tags}
                clipboardHasFiles={clipboardHasFiles}
                showCheckboxes={showCheckboxes}
                trashed={activeView === 'trash'}
                locale={locale}
                onToggleSelect={toggleFile}
                actions={props}
              />
            ))}
          </div>
        )}
        {status === 'loading' && files.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center py-1">
            <Spinner size={12} />
          </div>
        )}
      </div>

      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-[var(--border-subtle)] px-3 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
        <span>{t('office.list.count', { count: files.length })}</span>
        {selected.size > 0 && <span className="tabular">{t('office.batch.selected', { count: selected.size })}</span>}
        {status === 'loading' && <span className="ml-auto">{t('common.loading')}</span>}
      </div>

      <Menu anchor={newButtonRef} open={newMenuOpen} onClose={() => setNewMenuOpen(false)} items={newFileItems} width={216} />
      {crumbMenuAnchor && (
        <Menu anchor={crumbMenuAnchor} open onClose={() => setCrumbMenuAnchor(null)} items={newFileItems} width={216} />
      )}
      <Menu
        anchor={sortButtonRef}
        open={sortMenuOpen}
        onClose={() => setSortMenuOpen(false)}
        items={officeSortMenuItems(sortKey, sortDir, props.onSortChange)}
        width={216}
      />
      <Menu
        anchor={tagButtonRef}
        open={tagMenuOpen}
        onClose={() => setTagMenuOpen(false)}
        items={tagMenuItems}
        searchable
        searchPlaceholder={t('office.search.placeholder')}
        width={232}
      />
      {blankMenu.point && (
        <Menu anchor={blankMenu.point} open onClose={blankMenu.close} items={blankItems} width={224} />
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {t('office.list.count', { count: files.length })}
        {selected.size > 0 ? ` ${t('office.batch.selected', { count: selected.size })}` : ''}
      </p>
    </div>
  )
}

function FileTile({
  variant, file, selected, selectedFiles, tags,
  clipboardHasFiles, showCheckboxes, trashed, locale, onToggleSelect, actions,
}: {
  variant: 'row' | 'card' | 'gallery'
  file: OfficeFileSummary
  selected: ReadonlySet<string>
  selectedFiles: readonly OfficeFileSummary[]
  tags: readonly OfficeTag[]
  clipboardHasFiles: boolean
  showCheckboxes: boolean
  trashed: boolean
  locale: string
  onToggleSelect: (file: OfficeFileSummary, range: boolean) => void
  actions: OfficeFileActions
}) {
  const menu = useContextMenu()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const shiftRef = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const isSelected = selected.has(file.id)
  const targets = isSelected ? selectedFiles : [file]
  const menuInput: OfficeFileMenuInput = {
    file,
    targets,
    tags,
    trashed,
    clipboardEmpty: !clipboardHasFiles,
    onOpen: actions.onOpen,
    onRename: actions.onRename,
    onDuplicate: actions.onDuplicate,
    onDownload: actions.onDownload,
    onToggleStar: actions.onToggleStar,
    onTogglePin: actions.onTogglePin,
    onCopy: actions.onCopy,
    onCut: actions.onCut,
    onPaste: actions.onPaste,
    onMove: actions.onMove,
    onAddTag: actions.onAddTag,
    onVersions: actions.onVersions,
    onDetails: actions.onDetails,
    onDelete: actions.onDelete,
    onRestore: actions.onRestore,
    onPurge: actions.onPurge,
  }
  const items = fileMenuItems(menuInput)

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) menu.openAt({ x: rect.left + 8, y: rect.bottom })
  }

  const openFromContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    setMenuOpen(false)
    if (event.clientX !== 0 || event.clientY !== 0) {
      menu.onContextMenu(event)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    openMenu()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      openMenu()
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      actions.onRename(file)
      return
    }
    if (event.key === 'Delete' && trashed) {
      event.preventDefault()
      actions.onPurge(targets)
      return
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      actions.onDelete(targets)
    }
  }

  const activate = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      event.preventDefault()
      onToggleSelect(file, event.shiftKey)
      return
    }
    actions.onOpen(file)
  }

  const dragStart = (event: React.DragEvent<HTMLElement>) => {
    const ids = isSelected ? selectedFiles.map((entry) => entry.id) : [file.id]
    beginOfficeDrag(event, { kind: 'files', ids })
  }

  const menuLayer = (
    <>
      <Menu anchor={buttonRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={232} />
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items} width={232} />}
    </>
  )

  const titleButton = (
    <button
      type="button"
      onClick={activate}
      onDoubleClick={() => actions.onRename(file)}
      onKeyDown={onKeyDown}
      className={cn(
        'min-w-0 flex-1 truncate text-left font-medium text-[var(--text-primary)]',
        variant === 'row' ? 'text-[length:var(--text-12-5)]' : 'text-[length:var(--text-13)]',
      )}
      aria-label={`${file.title}, ${officeTypeLabel(file.type)}`}
    >
      {file.title}
    </button>
  )

  const checkbox = showCheckboxes && (
    <span onPointerDown={(event) => { shiftRef.current = event.shiftKey }} className="shrink-0">
      <Checkbox
        checked={isSelected}
        onChange={() => onToggleSelect(file, shiftRef.current)}
        ariaLabel={`${t('office.action.select')} ${file.title}`}
      />
    </span>
  )

  const moreButton = (
    <Tooltip label={t('common.more_actions')} side="left">
      <IconButton
        ref={buttonRef}
        label={t('common.more_actions')}
        size="sm"
        onClick={(event) => {
          event.stopPropagation()
          menu.close()
          setMenuOpen(true)
        }}
      >
        <MoreHorizontal size={13} />
      </IconButton>
    </Tooltip>
  )

  if (variant === 'row') {
    return (
      <div
        role="listitem"
        data-office-file=""
        data-office-file-id={file.id}
        draggable={!trashed}
        onDragStart={dragStart}
        onDragEnd={endOfficeDrag}
        onContextMenu={openFromContextMenu}
        className={cn(
          'group flex h-10 items-center gap-2 border-b border-[var(--border-subtle)] px-2 transition-colors',
          isSelected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
        )}
      >
        {checkbox}
        <span className="flex size-5 shrink-0 items-center justify-center text-[var(--text-tertiary)]">
          {officeTypeIcon(file.type, 14)}
        </span>
        {titleButton}
        {(file.isPinned || file.isStarred) && (
          <span className="flex shrink-0 items-center gap-1 text-[var(--text-quaternary)]">
            {file.isPinned && <Pin size={11} role="img" aria-label={t('office.action.pin')} />}
            {file.isStarred && <Star size={11} role="img" aria-label={t('office.action.star')} />}
          </span>
        )}
        <span className="hidden shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)] sm:inline">
          {officeTypeLabel(file.type)}
        </span>
        <span className="w-[104px] shrink-0 text-right text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
          {fileDate(file.updatedAt, locale)}
        </span>
        {moreButton}
        {menuLayer}
      </div>
    )
  }

  return (
    <div
      role="listitem"
      data-office-file=""
      data-office-file-id={file.id}
      draggable={!trashed}
      onDragStart={dragStart}
      onDragEnd={endOfficeDrag}
      onContextMenu={openFromContextMenu}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 transition-colors',
        isSelected ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'hover:border-[var(--border-default)]',
        variant === 'gallery' && 'min-h-[132px]',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--bg-inset)] text-[var(--text-tertiary)]', variant === 'gallery' && 'size-9')}>
          {officeTypeIcon(file.type, variant === 'gallery' ? 20 : 14)}
        </span>
        <span className="min-w-0 flex-1" />
        {(file.isPinned || file.isStarred) && (
          <span className="flex shrink-0 items-center gap-1 text-[var(--text-quaternary)]">
            {file.isPinned && <Pin size={11} role="img" aria-label={t('office.action.pin')} />}
            {file.isStarred && <Star size={11} role="img" aria-label={t('office.action.star')} />}
          </span>
        )}
        {checkbox}
        {moreButton}
      </div>
      {titleButton}
      <p className="flex items-center gap-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
        <span className="shrink-0">{officeTypeLabel(file.type)}</span>
        <span className="truncate">{fileDate(file.updatedAt, locale)}</span>
        {variant === 'gallery' && file.size > 0 && <span className="ml-auto shrink-0 tabular">{formatBytes(file.size)}</span>}
      </p>
      {menuLayer}
    </div>
  )
}