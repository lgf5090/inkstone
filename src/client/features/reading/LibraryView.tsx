/**
 * The shelf.
 *
 * What a reader looks for on a bookshelf is the cover and where they stopped, so the card is a cover
 * first and a caption second (see `ShelfCard`). The shelf itself is per device — see
 * `store/library.ts` for why the files cannot live on the server — so the export/import pair here is
 * what carries a reader's marks and positions to another machine.
 */
import { useMemo, useRef, useState, type DragEvent } from 'react'
import { Download, FolderInput, Images, Inbox, LayoutGrid, List, MessageSquareQuote, Pencil, Plus, Sparkles, Star, Trash2, Upload } from 'lucide-react'
import { Button } from '../../components/primitives'
import { Input, Segmented } from '../../components/form'
import { Menu, confirm, prompt, submenuFor, useContextMenu, type MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { useLibrary } from './store/library'
import { hasBookExtension } from './engine/book-import'
import { stoppedAtLabel } from './position'
import { dropBookHandle } from './reader/useEpubHandle'
import { ShelfCard } from './ShelfCard'
import { ShelfRow } from './ShelfRow'
import { ShelfGroups } from './ShelfGroups'
import { groupsHolding, sortGroups } from './book-groups'
import { SHELF_NARROW_QUERY, resolveShelfView, type ShelfViewMode } from './shelf-view'
import { useReaderSettings } from './store/reader-settings'
import { useMediaQuery } from '../../lib/hooks'
import { cn } from '../../lib/cn'
import { SyncLine } from './SyncLine'
import type { BookRecord, ImportFailure } from './types'

const FAILURE_KEYS = {
  format: 'reading.error_format',
  size: 'reading.error_size',
  corrupt: 'reading.error_corrupt',
  duplicate: 'reading.error_duplicate',
  storage: 'reading.error_storage',
} as const

type ShelfFilter = 'all' | 'reading' | 'finished' | 'marked'
type ShelfSort = 'recent' | 'added' | 'title' | 'author' | 'progress'

const ACCEPT = '.epub,.pdf,.cbz,application/epub+zip,application/pdf'

/** The four shelf layouts, in the order the toolbar offers them. */
const SHELF_VIEW_ICONS: Record<ShelfViewMode, React.ReactNode> = {
  adaptive: <Sparkles size={13} />,
  grid: <LayoutGrid size={13} />,
  list: <List size={13} />,
  covers: <Images size={13} />,
}

export function LibraryView() {
  const books = useLibrary((state) => state.books)
  const progress = useLibrary((state) => state.progress)
  const highlights = useLibrary((state) => state.highlights)
  const covers = useLibrary((state) => state.covers)
  const noteLinks = useLibrary((state) => state.notes)
  const addFiles = useLibrary((state) => state.addFiles)
  const removeBook = useLibrary((state) => state.removeBook)
  const renameBook = useLibrary((state) => state.renameBook)
  const markFinished = useLibrary((state) => state.markFinished)
  const exportLibrary = useLibrary((state) => state.exportLibrary)
  const shelfView = useReaderSettings((state) => state.shelfView)
  const updateSettings = useReaderSettings((state) => state.update)
  const narrow = useMediaQuery(SHELF_NARROW_QUERY)
  const groups = useLibrary((state) => state.groups)
  const moveBook = useLibrary((state) => state.moveBook)
  const addGroup = useLibrary((state) => state.addGroup)
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  const view = resolveShelfView(shelfView, narrow)
  const importLibrary = useLibrary((state) => state.importLibrary)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ShelfFilter>('all')
  const [sort, setSort] = useState<ShelfSort>('recent')
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState<BookRecord | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const dataInput = useRef<HTMLInputElement>(null)
  const menu = useContextMenu()
  const toast = useUi((state) => state.toast)

  function openBookNote(noteId: string | undefined): void {
    if (!noteId) return
    navigateToPath('/notes')
    useUi.getState().openExplorer()
    void useNotes.getState().openNote(noteId)
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = books.filter((book) => !needle
      || `${book.title} ${book.author} ${book.filename}`.toLowerCase().includes(needle))
      .filter((book) => !groupFilter || (groups.find((one) => one.id === groupFilter)?.bookIds.includes(book.id) ?? false))
      .filter((book) => {
        const state = progress[book.id]
        if (filter === 'reading') return Boolean(state && !state.finishedAt && state.fraction > 0.005)
        if (filter === 'finished') return Boolean(state?.finishedAt)
        if (filter === 'marked') return (highlights[book.id]?.length ?? 0) > 0
        return true
      })
    const sorted = [...list]
    if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title))
    else if (sort === 'author') sorted.sort((a, b) => (a.author ||
      a.title).localeCompare(b.author || b.title))
    else if (sort === 'added') sorted.sort((a, b) => b.addedAt - a.addedAt)
    else if (sort === 'progress') sorted.sort((a, b) => (progress[b.id]?.fraction ?? 0) - (progress[a.id]?.fraction ?? 0))
    else sorted.sort((a, b) => (progress[b.id]?.updatedAt ?? 0) - (progress[a.id]?.updatedAt ?? 0) || b.addedAt - a.addedAt)
    return sorted
  }, [books, filter, groupFilter, groups, highlights, progress, query, sort])

  /** One book's facts, so the grid, the cover wall and the list cannot disagree about what they show. */
  function shelfProps(book: BookRecord) {
    return {
      book,
      coverUrl: covers[book.id] ?? book.coverUrl ?? undefined,
      fraction: progress[book.id]?.fraction ?? 0,
      finished: Boolean(progress[book.id]?.finishedAt),
      highlightCount: highlights[book.id]?.length ?? 0,
      noteCount: noteLinks.byBook[book.id] ? 1 : 0,
      lastReadAt: progress[book.id]?.updatedAt,
      stoppedAt: stoppedAtLabel(progress[book.id]?.position, book),
      groupNames: groupsHolding(groups, book.id).map((one) => one.name),
      onOpen: () => navigateToPath(`/reading/${encodeURIComponent(book.id)}`),
      onOpenNote: () => openBookNote(noteLinks.byBook[book.id]),
      onMenu: (event: React.MouseEvent) => {
        setActive(book)
        menu.onContextMenu(event)
      },
    }
  }

  async function ingest(files: File[]): Promise<void> {
    const wanted = files.filter((file) => hasBookExtension(file.name) || ACCEPT.split(',').includes(file.type))
    const skipped = files.length - wanted.length
    if (!wanted.length) {
      if (skipped) toast({ title: t('reading.nothing_importable'), tone: 'warning' })
      return
    }
    setBusy(true)
    const result = await addFiles(wanted)
    setBusy(false)
    reportFailures(result.failed, skipped)
    if (result.added.length) {
      toast({
        title: t('reading.books_added_value0', { value0: result.added.length }),
        description: t('reading.library_is_local_hint'),
        tone: 'success',
      })
    }
  }

  function reportFailures(failed: ImportFailure[], skippedCount: number): void {
    if (!failed.length && !skippedCount) return
    const parts = failed.slice(0, 3).map((one) => `${one.filename}: ${t(FAILURE_KEYS[one.reason])}`)
    if (failed.length > 3) parts.push(t('reading.and_more_value0', { value0: failed.length - 3 }))
    if (skippedCount) parts.push(t('reading.skipped_not_books_value0', { value0: skippedCount }))
    toast({ title: t('reading.some_files_failed'), description: parts.join('\n'), tone: 'danger' })
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault()
    setDragging(false)
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length) void ingest(files)
  }

  function menuFor(book: BookRecord): MenuItem[] {
    const state = progress[book.id]
    const memberOf = new Set(groupsHolding(groups, book.id).map((one) => one.id))
    const membership: MenuItem[] = sortGroups(groups).map((group) => ({
      id: `group-${group.id}`,
      label: group.name,
      checked: memberOf.has(group.id),
      onSelect: () => moveBook(group.id, book.id),
    }))
    membership.push({
      id: 'group-new',
      label: t('reading.new_group'),
      separatorBefore: membership.length > 0,
      onSelect: () => void newGroupFor(book),
    })
    return [
      {
        id: 'groups',
        label: t('reading.move_to_group'),
        icon: <FolderInput size={13} />,
        subItems: membership,
        submenu: submenuFor(membership, 200),
      },
      { id: 'open', label: t('reading.continue_reading'), onSelect: () => navigateToPath(`/reading/${encodeURIComponent(book.id)}`) },
      ...(noteLinks.byBook[book.id]
        ? [{ id: 'note', label: t('reading.open_note'), icon: <MessageSquareQuote size={13} />, onSelect: () => openBookNote(noteLinks.byBook[book.id]) }]
        : []),
      { id: 'rename', label: t('reading.rename_book'), icon: <Pencil size={13} />, onSelect: () => void rename(book) },
      {
        id: 'finished',
        label: state?.finishedAt ? t('reading.mark_unfinished') : t('reading.mark_finished'),
        icon: <Star size={13} />,
        onSelect: () => markFinished(book.id, !state?.finishedAt),
      },
      {
        id: 'delete',
        label: t('reading.remove_book'),
        icon: <Trash2 size={13} />,
        tone: 'danger',
        separatorBefore: true,
        onSelect: () => void remove(book),
      },
    ]
  }

  /** The menu's own new-group flow: name it, then put this book straight into it. */
  async function newGroupFor(book: BookRecord): Promise<void> {
    const name = await prompt({ title: t('reading.new_group'), confirmLabel: t('reading.create_group') })
    if (name === null) return
    const answer = addGroup(name)
    if (answer.ok) moveBook(answer.groups[answer.groups.length - 1].id, book.id)
  }

  async function rename(book: BookRecord): Promise<void> {
    const next = await prompt({ title: t('reading.rename_book'), defaultValue: book.title, confirmLabel: t('common.save') })
    if (next && next.trim()) renameBook(book.id, next.trim().slice(0, 200))
  }

  async function remove(book: BookRecord): Promise<void> {
    const store = useLibrary.getState()
    const marks = store.highlights[book.id]?.length ?? 0
    const noteId = store.notes.byBook[book.id]
    const ok = await confirm({
      title: t('reading.remove_book_confirm_value0', { value0: book.title }),
      description: marks === 0
        ? t('reading.remove_book_confirm_hint')
        : t(noteId
          ? 'reading.remove_book_in_note_value0'
          : 'reading.remove_book_unsaved_value0', { value0: marks }),
      confirmLabel: t('reading.remove'),
      tone: 'danger',
    })
    if (ok) {
      // The parsed archive is cached for the session so returning to a book is instant; deleting one
      // has to drop that too, or its bytes stay reachable until the tab closes.
      dropBookHandle(book.id)
      await removeBook(book.id)
    }
  }

  async function runExport(): Promise<void> {
    const json = await exportLibrary()
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `inkstone-reading-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    toast({ title: t('reading.library_exported'), tone: 'success' })
  }

  async function runImport(file: File): Promise<void> {
    try {
      const result = await importLibrary(await file.text())
      toast({
        title: t('reading.library_imported_value0', { value0: result.books }),
        description: [
          t('reading.library_imported_highlights_value0', { value0: result.highlights }),
          result.rejected ? t('reading.library_imported_rejected_value0', { value0: result.rejected }) : null,
        ].filter(Boolean).join('\n'),
        tone: 'success',
      })
    } catch (err) {
      toast({ title: t('reading.library_import_failed'), description: err instanceof Error ? err.message : String(err), tone: 'danger' })
    }
  }

  const totalMarked = useMemo(
    () => Object.values(highlights).reduce((sum, list) => sum + list.length, 0),
    [highlights],
  )

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onDragOver={(event) => {
        if (event.dataTransfer?.types?.includes('Files')) {
          event.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <span className="min-w-0 truncate text-[13.5px] font-semibold text-[var(--text-primary)]">{t('reading.shelf')}</span>
        <span className="min-w-0 truncate text-[11.5px] tabular text-[var(--text-quaternary)]">
          {t('reading.book_count_value0', { value0: books.length })}
          {totalMarked ? <span className="hidden sm:inline">{t('reading.marked_count_value0', { value0: totalMarked })}</span> : ''}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            aria-label={t('reading.export_library')}
            icon={<Download size={13} />}
            disabled={!books.length}
            onClick={() => void runExport()}
          >
            <span className="hidden sm:inline">{t('reading.export_library')}</span>
          </Button>
          <Button size="sm" variant="secondary" aria-label={t('reading.import_library')} icon={<Upload size={13} />} onClick={() => dataInput.current?.click()}>
            <span className="hidden sm:inline">{t('reading.import_library')}</span>
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={13} />} loading={busy} onClick={() => fileInput.current?.click()}>
            {t('reading.add_books')}
          </Button>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="min-w-[160px] flex-1 md:max-w-[280px]">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('reading.search_shelf_placeholder')}
            aria-label={t('reading.search_shelf')}
          />
        </div>
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('reading.filter_all') },
            { value: 'reading', label: t('reading.filter_reading') },
            { value: 'finished', label: t('reading.filter_finished') },
            { value: 'marked', label: t('reading.filter_marked') },
          ]}
        />
        <Segmented
          size="sm"
          value={shelfView}
          onChange={(mode) => updateSettings('shelfView', mode)}
          options={[
            { value: 'adaptive', title: t('reading.shelf_view_adaptive'), label: SHELF_VIEW_ICONS.adaptive },
            { value: 'grid', title: t('reading.shelf_view_grid'), label: SHELF_VIEW_ICONS.grid },
            { value: 'list', title: t('reading.shelf_view_list'), label: SHELF_VIEW_ICONS.list },
            { value: 'covers', title: t('reading.shelf_view_covers'), label: SHELF_VIEW_ICONS.covers },
          ]}
        />
        <Segmented
          size="sm"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'recent', label: t('reading.sort_recent') },
            { value: 'added', label: t('reading.sort_added') },
            { value: 'title', label: t('reading.sort_title') },
            { value: 'progress', label: t('reading.sort_progress') },
          ]}
        />
      </div>

      {books.length ? (
        <div className="shrink-0 px-3 pt-2">
          <ShelfGroups
            active={groupFilter}
            onSelect={setGroupFilter}
            shelfBookIds={new Set(books.map((book) => book.id))}
          />
        </div>
      ) : null}

      <div className="shrink-0 px-3">
        <SyncLine />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {books.length === 0 ? (
          <EmptyShelf busy={busy} onPick={() => fileInput.current?.click()} />
        ) : visible.length === 0 ? (
          <p className="px-3 py-12 text-center text-[12.5px] text-[var(--text-quaternary)]">
            {t('reading.no_books_match')}
          </p>
        ) : view === 'list' ? (
          <div className="flex max-w-[1080px] flex-col gap-0.5">
            {visible.map((book) => (
              <ShelfRow key={book.id} {...shelfProps(book)} />
            ))}
          </div>
        ) : (
          <div
            className={cn(
              'grid gap-x-3 gap-y-5',
              view === 'covers'
                ? 'grid-cols-3 sm:grid-cols-5 md:grid-cols-7 xl:grid-cols-10'
                : 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-7',
            )}
          >
            {visible.map((book) => (
              <ShelfCard key={book.id} captionless={view === 'covers'} {...shelfProps(book)} />
            ))}
          </div>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length) void ingest(files)
          event.target.value = ''
        }}
      />
      <input
        ref={dataInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void runImport(file)
          event.target.value = ''
        }}
      />

      <Menu
        anchor={menu.point ?? { x: 0, y: 0 }}
        open={Boolean(menu.point) && Boolean(active)}
        onClose={menu.close}
        zIndex={240}
        items={active ? menuFor(active) : []}
      />

      {dragging ? (
        <div className="app-viewport-fixed pointer-events-none fixed inset-0 z-[300] flex items-center justify-center bg-[var(--scrim)]">
          <p className="rounded-[var(--r-lg)] border-2 border-dashed border-[var(--accent)] bg-[var(--bg-surface)] px-6 py-5 text-center text-[13px] font-medium">
            {t('reading.drop_files_here')}
          </p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The first-run shelf.
 *
 * It names the two formats that actually work rather than every format the reference product reads,
 * because a reader who drops a MOBI in here gets a rejection with a reason, and would have been better
 * served by being told up front.
 */
function EmptyShelf({ busy, onPick }: { busy: boolean; onPick: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-14 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[var(--text-tertiary)]">
        <Inbox size={24} />
      </span>
      <p className="font-serif text-[16px] font-semibold text-[var(--text-primary)]">{t('reading.shelf_empty_title')}</p>
      <p className="text-[13px] leading-relaxed text-[var(--text-tertiary)]">{t('reading.shelf_empty_body')}</p>
      <Button variant="primary" size="md" icon={<Plus size={14} />} loading={busy} onClick={onPick}>
        {t('reading.add_books')}
      </Button>
      <p className="text-[11.5px] text-[var(--text-quaternary)]">{t('reading.shelf_formats_hint')}</p>
    </div>
  )
}
