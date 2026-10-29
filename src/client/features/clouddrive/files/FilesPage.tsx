import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpDown,
  FolderOpen,
  FolderPlus,
  GalleryHorizontal,
  LayoutGrid,
  List,
  PanelRight,
  RefreshCw,
  Search,
  Upload,
  X,
} from 'lucide-react'
import {
  CLOUDDRIVE_SORT_KEYS,
  parentPathOf,
  type CloudDriveEntry,
  type CloudDriveListing,
  type CloudDriveSortDirection,
  type CloudDriveSortKey,
} from '@shared/clouddrive/model'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Input, Segmented } from '../../../components/form'
import { Menu, type MenuItem } from '../../../components/overlay'
import { clouddriveApi, cloudDriveErrorKey } from '../api'
import { cloudDriveCssVars } from '../prefs'
import { useCloudDriveStore } from '../store'
import { FileList } from './FileList'
import { FileGrid } from './FileGrid'
import { FileGallery } from './FileGallery'
import { ContextMenu, type ContextMenuTarget } from './ContextMenu'
import { ConfirmDeleteDialog, MoveDialog, NewFolderDialog, RenameDialog } from './Dialogs'
import { Inspector } from './Inspector'
import { SelectionBar } from './SelectionBar'
import { useFileActions, type FileListChange } from './useFileActions'
import type { SelectMode } from './types'
import { totalEntryBytes } from './format'
import './files.css'

export interface FilesPageProps {
  mountId: string
  path: string
  onNavigate(path: string): void
  readOnly?: boolean
  /** Opens the preview/Quick Look surface. The shell owns the renderer. */
  onPreview?(entry: CloudDriveEntry): void
}

type ViewMode = 'icon' | 'list' | 'gallery'

type DialogState =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: CloudDriveEntry }
  | { kind: 'move'; ids: string[]; initialPath: string }
  | { kind: 'delete'; ids: string[] }
  | null

export function FilesPage({ mountId, path, onNavigate, readOnly = false, onPreview }: FilesPageProps) {
  const prefs = useCloudDriveStore((state) => state.prefs)
  const setPrefs = useCloudDriveStore((state) => state.setPrefs)
  const refreshKey = useCloudDriveStore((state) => state.refreshKey)

  const [listing, setListing] = useState<CloudDriveListing | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'cut'; ids: string[] } | null>(null)
  const [menuTarget, setMenuTarget] = useState<ContextMenuTarget | null>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [sortOpen, setSortOpen] = useState(false)

  const listingRef = useRef<CloudDriveListing | null>(null)
  const requestRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sortButtonRef = useRef<HTMLButtonElement>(null)

  const writable = !readOnly
  const viewMode: ViewMode = prefs.viewMode === 'column' ? 'icon' : prefs.viewMode

  useEffect(() => {
    listingRef.current = listing
  }, [listing])

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim().slice(0, 100)), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const load = useCallback(async () => {
    const sequence = ++requestRef.current
    setStatus('loading')
    setError(null)
    try {
      const result = await clouddriveApi.list({
        mountId,
        path,
        sort: prefs.sortKey,
        dir: prefs.sortDir,
        foldersFirst: prefs.foldersFirst,
        limit: 500,
        q: query || undefined,
      })
      if (sequence !== requestRef.current) return
      setListing(result)
      setStatus('ready')
    } catch (caught) {
      if (sequence !== requestRef.current) return
      const message = t(cloudDriveErrorKey(caught) as MessageKey)
      if (listingRef.current) {
        // The previous directory is still usable; the failed refresh explains itself in a toast.
        setStatus('ready')
        useUi.getState().toast({ title: message, tone: 'danger' })
      } else {
        setError(message)
        setStatus('error')
      }
    }
  }, [mountId, path, query, prefs.sortKey, prefs.sortDir, prefs.foldersFirst])

  useEffect(() => {
    setListing(null)
    listingRef.current = null
    setSelected(new Set())
    setAnchorId(null)
    setFocusedId(null)
    setMenuTarget(null)
    setClipboard(null)
    setSearch('')
    setQuery('')
  }, [mountId, path])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const entries = useMemo(
    () => (listing ? [...listing.folders, ...listing.files] : []),
    [listing],
  )

  useEffect(() => {
    if (!listing) return
    const ids = new Set(entries.map((entry) => entry.id))
    setSelected((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)))
      return next.size === current.size ? current : next
    })
    setFocusedId((current) => (current && ids.has(current) ? current : entries[0]?.id ?? null))
    setAnchorId((current) => (current && ids.has(current) ? current : null))
  }, [listing, entries])

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.id)),
    [entries, selected],
  )

  const applyLocalChange = useCallback((change: FileListChange) => {
    setListing((current) => {
      if (!current) return current
      if (change.type === 'remove') {
        const dropped = new Set(change.ids)
        return {
          ...current,
          folders: current.folders.filter((entry) => !dropped.has(entry.id)),
          files: current.files.filter((entry) => !dropped.has(entry.id)),
        }
      }
      const replace = (list: CloudDriveEntry[]) => list.map((entry) => (entry.id === change.entry.id ? change.entry : entry))
      return { ...current, folders: replace(current.folders), files: replace(current.files) }
    })
  }, [])

  const actions = useFileActions({ mountId, refresh: load, onLocalChange: applyLocalChange })

  const selectEntry = useCallback((entry: CloudDriveEntry, mode: SelectMode) => {
    setSelected((current) => {
      if (mode === 'toggle') {
        const next = new Set(current)
        if (next.has(entry.id)) next.delete(entry.id)
        else next.add(entry.id)
        return next
      }
      if (mode === 'range' && anchorId) {
        const from = entries.findIndex((item) => item.id === anchorId)
        const to = entries.findIndex((item) => item.id === entry.id)
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from]
          return new Set(entries.slice(start, end + 1).map((item) => item.id))
        }
      }
      return new Set([entry.id])
    })
    if (mode !== 'range') setAnchorId(entry.id)
    setFocusedId(entry.id)
  }, [anchorId, entries])

  const selectAll = useCallback(() => {
    setSelected(new Set(entries.map((entry) => entry.id)))
    setAnchorId(entries[0]?.id ?? null)
  }, [entries])

  const clearSelection = useCallback(() => {
    setSelected(new Set())
    setAnchorId(null)
  }, [])

  const targetsFor = useCallback(
    (entry: CloudDriveEntry) => (selected.has(entry.id) ? entries.filter((item) => selected.has(item.id)) : [entry]),
    [entries, selected],
  )

  const previewEntry = useCallback((entry: CloudDriveEntry) => {
    if (onPreview) {
      onPreview(entry)
      return
    }
    if (entry.kind === 'folder') {
      onNavigate(entry.path)
      return
    }
    window.open(clouddriveApi.contentUrl(entry.id), '_blank', 'noopener,noreferrer')
  }, [onNavigate, onPreview])

  const openEntry = useCallback((entry: CloudDriveEntry) => {
    if (entry.kind === 'folder') onNavigate(entry.path)
    else previewEntry(entry)
  }, [onNavigate, previewEntry])

  const isMutable = useCallback((entry: CloudDriveEntry) => writable && !entry.readOnly, [writable])

  const requestDelete = useCallback((targets: CloudDriveEntry[]) => {
    if (targets.length === 0) return
    setDialog({ kind: 'delete', ids: targets.map((entry) => entry.id) })
  }, [])

  const handleContextMenu = useCallback((entry: CloudDriveEntry, event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setSelected((current) => (current.has(entry.id) ? current : new Set([entry.id])))
    setAnchorId((current) => (selected.has(entry.id) ? current : entry.id))
    setFocusedId(entry.id)
    setMenuTarget({ entry, point: { x: event.clientX, y: event.clientY } })
  }, [selected])

  const handleKeyCommand = useCallback((event: ReactKeyboardEvent<HTMLElement>, entry: CloudDriveEntry): boolean => {
    const target = event.target as HTMLElement
    const onCheckbox = target instanceof HTMLInputElement && target.type === 'checkbox'
    if (onCheckbox && (event.key === ' ' || event.key === 'Enter')) return false
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'a') {
      event.preventDefault()
      selectAll()
      return true
    }
    if (event.key === 'Escape') {
      if (selected.size > 0) {
        event.preventDefault()
        clearSelection()
      }
      return true
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      openEntry(entry)
      return true
    }
    if (event.key === 'F2') {
      if (isMutable(entry)) {
        event.preventDefault()
        setDialog({ kind: 'rename', entry })
        return true
      }
      return false
    }
    if (event.key === 'Delete') {
      if (isMutable(entry)) {
        event.preventDefault()
        requestDelete(targetsFor(entry))
        return true
      }
      return false
    }
    if (event.shiftKey && event.key === 'F10') {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      setSelected((current) => (current.has(entry.id) ? current : new Set([entry.id])))
      setAnchorId((current) => (selected.has(entry.id) ? current : entry.id))
      setFocusedId(entry.id)
      setMenuTarget({ entry, point: { x: rect.left + 8, y: rect.bottom } })
      return true
    }
    return false
  }, [clearSelection, isMutable, openEntry, requestDelete, selectAll, selected, targetsFor])

  const pasteClipboard = useCallback(async () => {
    if (!clipboard) return
    const ok = clipboard.mode === 'copy'
      ? await actions.copy(clipboard.ids, path)
      : await actions.move(clipboard.ids, path)
    if (ok && clipboard.mode === 'cut') setClipboard(null)
  }, [actions, clipboard, path])

  const handleUploadPicked = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length > 0) await actions.upload(files, path)
  }, [actions, path])

  const handleRootKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 'i') return
    const target = event.target as HTMLElement
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return
    event.preventDefault()
    setPrefs({ inspectorVisible: !prefs.inspectorVisible })
  }, [prefs.inspectorVisible, setPrefs])

  const sortItems: MenuItem[] = [
    ...CLOUDDRIVE_SORT_KEYS.map((key: CloudDriveSortKey): MenuItem => ({
      id: `sort-${key}`,
      label: t(`clouddrive.sort.${key}` as MessageKey),
      checked: prefs.sortKey === key,
      onSelect: () => setPrefs({ sortKey: key }),
    })),
    ...(['asc', 'desc'] as CloudDriveSortDirection[]).map((dir): MenuItem => ({
      id: `dir-${dir}`,
      label: t(dir === 'asc' ? 'clouddrive.sort.asc' : 'clouddrive.sort.desc'),
      checked: prefs.sortDir === dir,
      separatorBefore: dir === 'asc',
      onSelect: () => setPrefs({ sortDir: dir }),
    })),
    {
      id: 'folders-first',
      label: t('clouddrive.sort.folders_first'),
      checked: prefs.foldersFirst,
      separatorBefore: true,
      onSelect: () => setPrefs({ foldersFirst: !prefs.foldersFirst }),
    },
  ]

  const menuEntry = menuTarget ? entries.find((entry) => entry.id === menuTarget.entry.id) ?? menuTarget.entry : null
  const menuTargets = menuEntry
    ? (selected.has(menuEntry.id) ? entries.filter((entry) => selected.has(entry.id)) : [menuEntry])
    : []
  const contextTarget = useMemo<ContextMenuTarget | null>(
    () => (menuTarget && menuEntry ? { entry: menuEntry, point: menuTarget.point } : null),
    [menuTarget, menuEntry],
  )
  const canPaste = clipboard !== null
  const writableSelection = writable && selectedEntries.length > 0 && selectedEntries.every((entry) => !entry.readOnly)
  const announcement = `${t('clouddrive.status.items', { count: entries.length })}. ${selected.size > 0
    ? t('clouddrive.selection.count', { count: selected.size })
    : t('clouddrive.selection.none')}`

  return (
    <div
      data-clouddrive-files=""
      className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-base)]"
      style={cloudDriveCssVars(prefs) as CSSProperties}
      onKeyDown={handleRootKeyDown}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] px-2 py-1.5">
        <IconButton
          label={t('clouddrive.toolbar.back')}
          onClick={() => onNavigate(parentPathOf(path))}
          disabled={path === '/'}
        >
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton label={t('clouddrive.toolbar.refresh')} onClick={() => void load()}>
          <RefreshCw size={15} className={status === 'loading' ? 'animate-spin' : undefined} />
        </IconButton>
        <div className="min-w-[140px] flex-1 sm:max-w-[320px]">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('clouddrive.toolbar.search')}
            aria-label={t('clouddrive.toolbar.search')}
            leading={<Search size={13} />}
            trailing={search
              ? (
                <IconButton label={t('clouddrive.search.clear')} size="xs" onClick={() => { setSearch(''); setQuery('') }}>
                  <X size={12} />
                </IconButton>
              )
              : undefined}
            className="h-8"
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Segmented<ViewMode>
            value={viewMode}
            size="sm"
            label={t('clouddrive.toolbar.view')}
            options={[
              { value: 'icon', label: <LayoutGrid size={14} />, title: t('clouddrive.toolbar.view_icon') },
              { value: 'list', label: <List size={14} />, title: t('clouddrive.toolbar.view_list') },
              { value: 'gallery', label: <GalleryHorizontal size={14} />, title: t('clouddrive.toolbar.view_gallery') },
            ]}
            onChange={(mode) => setPrefs({ viewMode: mode })}
          />
          <Button
            ref={sortButtonRef}
            size="sm"
            variant="secondary"
            icon={<ArrowUpDown size={13} />}
            aria-label={t('clouddrive.toolbar.sort')}
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            onClick={() => setSortOpen((open) => !open)}
          >
            <span className="hidden sm:inline">{t('clouddrive.toolbar.sort')}</span>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Upload size={13} />}
            aria-label={t('clouddrive.toolbar.upload')}
            disabled={!writable || actions.busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="hidden sm:inline">{t('clouddrive.toolbar.upload')}</span>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<FolderPlus size={13} />}
            aria-label={t('clouddrive.toolbar.new_folder')}
            disabled={!writable || actions.busy}
            onClick={() => setDialog({ kind: 'mkdir' })}
          >
            <span className="hidden sm:inline">{t('clouddrive.toolbar.new_folder')}</span>
          </Button>
          <IconButton
            label={t('clouddrive.toolbar.inspector')}
            active={prefs.inspectorVisible}
            onClick={() => setPrefs({ inspectorVisible: !prefs.inspectorVisible })}
          >
            <PanelRight size={15} />
          </IconButton>
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => void handleUploadPicked(event)} />
        </div>
      </header>

      <Menu
        anchor={sortButtonRef}
        open={sortOpen}
        onClose={() => setSortOpen(false)}
        items={sortItems}
        align="end"
        width={224}
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          role="region"
          aria-label={t('clouddrive.nav.files')}
          aria-busy={status === 'loading'}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"
        >
          {status === 'loading' && !listing && <LoadingSkeleton />}
          {status === 'error' && !listing && (
            <ErrorState message={error} onRetry={() => void load()} />
          )}
          {listing && entries.length === 0 && (
            <EmptyState
              searching={query.length > 0}
              writable={writable}
              onClearSearch={() => { setSearch(''); setQuery('') }}
              onUpload={() => fileInputRef.current?.click()}
            />
          )}
          {listing && entries.length > 0 && (
            <>
              {viewMode === 'list' && (
                <FileList
                  entries={entries}
                  selected={selected}
                  focusedId={focusedId}
                  showCheckboxes={prefs.showCheckboxes}
                  readOnly={readOnly}
                  onFocusEntry={setFocusedId}
                  onSelect={selectEntry}
                  onOpen={openEntry}
                  onPreview={previewEntry}
                  onSelectAll={selectAll}
                  onClearSelection={clearSelection}
                  onContextMenu={handleContextMenu}
                  onKeyCommand={handleKeyCommand}
                />
              )}
              {viewMode === 'icon' && (
                <FileGrid
                  entries={entries}
                  selected={selected}
                  focusedId={focusedId}
                  showCheckboxes={prefs.showCheckboxes}
                  readOnly={readOnly}
                  onFocusEntry={setFocusedId}
                  onSelect={selectEntry}
                  onOpen={openEntry}
                  onPreview={previewEntry}
                  onSelectAll={selectAll}
                  onClearSelection={clearSelection}
                  onContextMenu={handleContextMenu}
                  onKeyCommand={handleKeyCommand}
                />
              )}
              {viewMode === 'gallery' && (
                <FileGallery
                  entries={entries}
                  selected={selected}
                  focusedId={focusedId}
                  showCheckboxes={prefs.showCheckboxes}
                  readOnly={readOnly}
                  onFocusEntry={setFocusedId}
                  onSelect={selectEntry}
                  onOpen={openEntry}
                  onPreview={previewEntry}
                  onSelectAll={selectAll}
                  onClearSelection={clearSelection}
                  onContextMenu={handleContextMenu}
                  onKeyCommand={handleKeyCommand}
                />
              )}
              {status === 'loading' && (
                <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center py-1">
                  <Spinner size={12} />
                </div>
              )}
            </>
          )}
        </div>
        <Inspector
          open={prefs.inspectorVisible}
          entries={selectedEntries}
          readOnly={readOnly}
          busy={actions.busy}
          onClose={() => setPrefs({ inspectorVisible: false })}
          onOpen={openEntry}
          onShare={(targets) => void actions.share(targets)}
          onColor={(entry, color) => void actions.setColor(entry, color)}
          onAddTag={(entry, tag, color) => void actions.addTag(entry, tag, color)}
          onRemoveTag={(entry, tag) => void actions.removeTag(entry, tag)}
        />
      </div>

      <SelectionBar
        count={selected.size}
        totalBytes={totalEntryBytes(selectedEntries)}
        busy={actions.busy}
        writable={writableSelection}
        onDownload={() => actions.download(selectedEntries)}
        onShare={() => void actions.share(selectedEntries)}
        onCopy={() => setClipboard({ mode: 'copy', ids: selectedEntries.map((entry) => entry.id) })}
        onCut={() => setClipboard({ mode: 'cut', ids: selectedEntries.map((entry) => entry.id) })}
        onMove={() => setDialog({ kind: 'move', ids: selectedEntries.map((entry) => entry.id), initialPath: path })}
        onDelete={() => requestDelete(selectedEntries)}
        onClear={clearSelection}
      />

      <ContextMenu
        target={contextTarget}
        targets={menuTargets}
        readOnly={readOnly}
        showCheckboxes={prefs.showCheckboxes}
        canPaste={canPaste}
        busy={actions.busy}
        onClose={() => setMenuTarget(null)}
        onOpen={openEntry}
        onPreview={previewEntry}
        onDownload={actions.download}
        onShare={(targets) => void actions.share(targets)}
        onCopy={(targets) => setClipboard({ mode: 'copy', ids: targets.map((entry) => entry.id) })}
        onCut={(targets) => setClipboard({ mode: 'cut', ids: targets.map((entry) => entry.id) })}
        onPaste={() => void pasteClipboard()}
        onRename={(entry) => setDialog({ kind: 'rename', entry })}
        onMove={(targets) => setDialog({ kind: 'move', ids: targets.map((entry) => entry.id), initialPath: path })}
        onDelete={requestDelete}
        onColor={(entry, color) => void actions.setColor(entry, color)}
        onAddTag={(entry, tag, color) => void actions.addTag(entry, tag, color)}
        onRemoveTag={(entry, tag) => void actions.removeTag(entry, tag)}
        onToggleCheckboxes={() => setPrefs({ showCheckboxes: !prefs.showCheckboxes })}
      />

      <NewFolderDialog
        open={dialog?.kind === 'mkdir'}
        busy={actions.busy}
        onClose={() => setDialog(null)}
        onSubmit={(name) => actions.mkdir(path, name)}
      />
      <RenameDialog
        open={dialog?.kind === 'rename'}
        entry={dialog?.kind === 'rename' ? dialog.entry : null}
        busy={actions.busy}
        onClose={() => setDialog(null)}
        onSubmit={(name) => (dialog?.kind === 'rename' ? actions.rename(dialog.entry, name) : Promise.resolve(false))}
      />
      <MoveDialog
        open={dialog?.kind === 'move'}
        count={dialog?.kind === 'move' ? dialog.ids.length : 0}
        initialPath={dialog?.kind === 'move' ? dialog.initialPath : path}
        busy={actions.busy}
        onClose={() => setDialog(null)}
        onSubmit={(destination) => (dialog?.kind === 'move' ? actions.move(dialog.ids, destination) : Promise.resolve(false))}
      />
      <ConfirmDeleteDialog
        open={dialog?.kind === 'delete'}
        count={dialog?.kind === 'delete' ? dialog.ids.length : 0}
        busy={actions.busy}
        onClose={() => setDialog(null)}
        onConfirm={() => (dialog?.kind === 'delete' ? actions.trash(dialog.ids) : Promise.resolve(false))}
      />

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-1 p-3">
      <span className="sr-only">{t('clouddrive.loading')}</span>
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-[var(--r-sm)] px-2" style={{ height: 'var(--cd-row-height)' }}>
          <span className="size-4 animate-pulse rounded-[var(--r-sm)] bg-[var(--bg-hover)]" />
          <span className="h-3 w-1/3 animate-pulse rounded-full bg-[var(--bg-hover)]" />
          <span className="ml-auto h-3 w-16 animate-pulse rounded-full bg-[var(--bg-hover)]" />
        </div>
      ))}
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangle size={24} className="text-[var(--danger)]" aria-hidden="true" />
      <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('clouddrive.failed')}</p>
      {message && <p className="max-w-[420px] text-[length:var(--text-11)] text-[var(--text-tertiary)]">{message}</p>}
      <Button variant="secondary" onClick={onRetry}>{t('clouddrive.retry')}</Button>
    </div>
  )
}

function EmptyState({
  searching,
  writable,
  onClearSearch,
  onUpload,
}: {
  searching: boolean
  writable: boolean
  onClearSearch: () => void
  onUpload: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <FolderOpen size={26} className="text-[var(--text-tertiary)]" aria-hidden="true" />
      <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">
        {searching ? t('clouddrive.empty.search') : t('clouddrive.empty.folder')}
      </p>
      {searching
        ? <Button size="sm" variant="secondary" onClick={onClearSearch}>{t('clouddrive.search.clear')}</Button>
        : writable && (
          <>
            <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.empty.upload_hint')}</p>
            <Button size="sm" variant="secondary" icon={<Upload size={13} />} onClick={onUpload}>{t('clouddrive.toolbar.upload')}</Button>
          </>
        )}
    </div>
  )
}
