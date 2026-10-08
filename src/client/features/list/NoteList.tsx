import { APP_SHORTCUTS, NOTE_LIST_SHORTCUTS } from '../../lib/shortcuts';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowDownWideNarrow, CalendarDays, CheckSquare2, Columns2, Copy, FileCode, FileDown, FileText, FolderInput, Link2, MoreHorizontal, Pin, PictureInPicture2, PinOff, PanelLeft, Plus, RotateCcw, Search, Star, StarOff, Trash2, X, Zap, } from 'lucide-react';
import type { NoteSummary, SearchHit, SortKey, ViewKind } from '@shared/types';
import { cn } from '../../lib/cn';
import { groupLabel, parseDateKey } from '../../lib/time';
import { useDebounced, useNow } from '../../lib/hooks';
import { api } from '../../lib/api';
import { fuzzyFilter, splitByRanges } from '../../lib/fuzzy';
import { useBreakpoint } from '../../lib/hooks';
import { matches, prettyCombo } from '../../lib/hotkeys';
import { exportNoteAsHtml, exportNoteAsMarkdown, exportNoteAsPdf } from '../../lib/export-note';
import { IconButton, Logo } from '../../components/primitives';
import { Menu, Tooltip, confirm, useContextMenu, type MenuItem } from '../../components/overlay';
import { Empty, NoteListSkeleton } from '../../components/feedback';
import { useUi } from '../../store/ui';
import { useQuickAdd } from '../../store/quickadd';
import { createContextualNote, useNotes, useVisibleNotes } from '../../store/notes';
import { folderPathLabel } from '../../lib/folders';
import { writeNoteDrag } from '../../lib/note-drag';
import { isVirtualFolderId, virtualFolderLabel } from '../../lib/calendar-tree';
import { openNoteFloatingWindow } from './note-floating-window';
import { FolderPicker } from '../folders/FolderPicker';
import { TemplateQuickActions } from '../templates/quick-actions';
import { OmnisearchEntry } from '../omnisearch/OmnisearchEntry';
import { t, useLocale, type MessageKey } from "../../lib/i18n";
import { MobileLibraryFilters } from '../shell/MobileLibraryFilters';
import { removeTagFromNote } from '../tags/tagMutations';
import { pinyinIsLoaded, usePinyinVersion, warmPinyinKeys } from '../../lib/pinyin'

const searchKeyCache = new Map<string, { rev: number; title: string; body: string; tags: string; text: string }>();
/** The concatenated key is the only copied string; bound it by characters, not entries. */
const SEARCH_KEY_CACHE_MAX_CHARS = 4_000_000;
let searchKeyCacheChars = 0;
function searchKeyOfNote(n: NoteSummary, contents: Record<string, string> | null): string {
    const body = contents ? contents[n.id] ?? n.excerpt : n.excerpt;
    const tags = n.tags.join(' ');
    const cached = searchKeyCache.get(n.id);
    if (cached && cached.rev === n.rev && cached.title === n.title && cached.body === body && cached.tags === tags) return cached.text;
    // One field per line: the matcher reads the first line of a haystack too long to have initials of
    // its own, and that line has to be the title, not the title plus the beginning of the excerpt.
    const text = `${n.title}\n${body}\n${tags}`;
    const previous = searchKeyCache.get(n.id);
    if (previous)
        searchKeyCacheChars -= previous.text.length;
    searchKeyCache.set(n.id, { rev: n.rev, title: n.title, body, tags, text });
    searchKeyCacheChars += text.length;
    if (searchKeyCacheChars > SEARCH_KEY_CACHE_MAX_CHARS) {
        searchKeyCache.clear();
        searchKeyCacheChars = 0;
    }
    return text;
}
const VIEW_MESSAGE_KEYS: Record<ViewKind, MessageKey> = {
    all: 'navigation.all_notes',
    recent: 'navigation.recently_edited',
    starred: 'navigation.favorites',
    unfiled: 'navigation.unfiled',
  untagged: 'navigation.untagged',
    archived: 'navigation.archive',
    trash: 'navigation.trash',
    folder: 'navigation.folder',
    tag: 'navigation.tag',
};
const EMPTY_HIGHLIGHT: [
    number,
    number
][] = [];
const VIRTUAL_WINDOW_SIZE = 80;
const VIRTUAL_OVERSCAN = 15;
export function NoteList() {
    const locale = useLocale();
    const breakpoint = useBreakpoint();
    const quickAddOn = useQuickAdd((s) => s.settings.enabled);
    const view = useUi((s) => s.view);
    const searchList = useUi((s) => s.searchList);
    const searchRequest = useUi((s) => s.searchRequest);
    const folderId = useUi((s) => s.folderId);
    const tagFilters = useUi((s) => s.tags);
    const dateFilter = useUi((s) => s.dateFilter);
    const setDateFilter = useUi((s) => s.setDateFilter);
    const sort = useUi((s) => s.sort);
    const order = useUi((s) => s.order);
    const density = useUi((s) => s.density);
    const setSort = useUi((s) => s.setSort);
    const activeNoteId = useUi((s) => s.activeNoteId);
    const toggleNavDrawer = useUi((s) => s.toggleNavDrawer);
    const notes = useVisibleNotes();
    const allNotes = useNotes((s) => s.notes);
    // Body text only ever reaches the search key through this record, so the memo has to
    // depend on it; reading it imperatively left freshly-opened notes unsearchable.
    const contents = useNotes((s) => (searchList ? s.contents : null));
    const folders = useNotes((s) => s.folders);
    const tags = useNotes((s) => s.tags);
    const loading = useNotes((s) => s.loading);
    const hydrated = useNotes((s) => s.hydrated);
    const openNote = useNotes((s) => s.openNote);
    const { emptyTrash, emptyingTrash } = useEmptyTrash();
    const filter = useUi((s) => s.searchQuery);
    const setFilter = useUi((s) => s.setSearchQuery);
    const deferredFilter = useDeferredValue(filter);
    const debouncedFilter = useDebounced(filter.trim(), 180);
    const filterRef = useRef<HTMLInputElement>(null);
    const [remote, setRemote] = useState<{ query: string; results: SearchHit[]; failed?: boolean } | null>(null);
    const [sortMenuOpen, setSortMenuOpen] = useState(false);
    const sortButtonRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [startIndex, setStartIndex] = useState(0);
    const nowMinute = useNow();
    const tagColors = useMemo(() => new Map((tags ?? []).map((item) => [item.name, item.color])), [tags]);

    // Crossing the tablet/desktop width is a layout change, not a new context: wiping the
    // query there loses a search the user is still typing.
    // Leaving a folder or a tag view changes what the box means, so the query goes with it.
    // Entering global search does not: a menu writes an expression there and flips the flag in
    // the same action, and clearing it one effect later would drop what was just asked for.
    useEffect(() => setFilter(''), [view, folderId, tagFilters]);
    useEffect(() => {
        if (searchList) filterRef.current?.focus();
    }, [searchList, searchRequest]);
    useEffect(() => {
        if (!searchList || !debouncedFilter) {
            setRemote(null);
            return;
        }
        const controller = new AbortController();
        api.search(debouncedFilter, 100, controller.signal).then((response) => {
            if (!controller.signal.aborted) setRemote({ query: debouncedFilter, results: response.results });
        }).catch(() => {
            if (!controller.signal.aborted) setRemote({ query: debouncedFilter, results: [], failed: true });
        });
        return () => controller.abort();
    }, [searchList, debouncedFilter]);
    const title = useMemo(() => {
        if (searchList) return t('shell.search_all_notes');
        if (view === 'folder')
            return virtualFolderLabel(folderId) ?? ((folderId ? folderPathLabel(folders, folderId) : '') || t("navigation.folder"));
        if (view === 'tag')
            return tagFilters.map((name) => `#${name}`).join(' + ');
        return t(VIEW_MESSAGE_KEYS[view]);
    }, [view, folderId, tagFilters, folders, locale, searchList]);
    const dayFilterText = useMemo(() => {
        if (!dateFilter) return '';
        const format = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' });
        const start = format.format(parseDateKey(dateFilter.start));
        if (dateFilter.start === dateFilter.end)
            return t('notes.filtering_by_day_value0', { value0: start });
        return t('notes.filtering_by_day_range_value0', { value0: start, value1: format.format(parseDateKey(dateFilter.end)) });
    }, [dateFilter, locale]);
    const dayFilterChip = dateFilter ? (<div data-day-filter-chip className="mt-1 flex min-w-0 items-center gap-1 self-start rounded-full border border-[var(--border-subtle)] py-0.5 pr-0.5 pl-1.5 text-[10.5px] text-[var(--text-tertiary)]">
      <CalendarDays size={11} className="shrink-0 text-[var(--text-quaternary)]"/>
      <span className="min-w-0 truncate">{dayFilterText}</span>
      <IconButton label={t('notes.clear_day_filter')} size="sm" className="size-5" onClick={() => setDateFilter(null)}>
        <X size={10}/>
      </IconButton>
    </div>) : null;
    // Browsing the search panel shows the same collection as the sidebar, but typing into it
    // means "find the note", and the server layer already answers that including archived
    // notes; scoping the local layer to the view made archived notes findable online and
    // invisible offline.
    const searchScope = useMemo(
        () => (searchList ? Object.values(allNotes).filter((item) => !item.deletedAt) : notes),
        [searchList, allNotes, notes]);
    const pinyinVersion = usePinyinVersion()
    const filtered = useMemo(() => {
        if (!deferredFilter.trim())
            return notes.map((note) => ({ note, ranges: EMPTY_HIGHLIGHT }));
        const local = fuzzyFilter(searchScope, deferredFilter, (n) => searchKeyOfNote(n, contents), 200).map(({ item, match }) => ({
            note: item,
            ranges: match.ranges.filter(([s]) => s < item.title.length),
        }));
        if (!searchList || remote?.query !== deferredFilter.trim()) return local;
        const seen = new Set(local.map(({ note }) => note.id));
        return [...local, ...remote.results.flatMap((hit) => {
            const note = allNotes[hit.note.id] ?? hit.note;
            if (seen.has(note.id) || note.deletedAt) return [];
            seen.add(note.id);
            return [{ note, ranges: EMPTY_HIGHLIGHT }];
        })];
    }, [notes, searchScope, deferredFilter, searchList, remote, allNotes, contents, pinyinVersion]);
    useEffect(() => {
        // Deriving the whole vault's readings costs about 0.06ms a title, so on the first keystroke it
        // is one 120ms task for 2000 notes. Idle spreads the same work into a few milliseconds per
        // tick; a search typed before the walk finishes is not wrong, because the matcher derives
        // whatever the warm-up has not reached yet.
        if (!pinyinIsLoaded())
            return;
        return warmPinyinKeys(searchScope.map((note) => note.title));
    }, [searchScope, pinyinVersion]);
    const filteredIds = useMemo(() => filtered.map((item) => item.note.id), [filtered]);
    const filteredIdsRef = useRef(filteredIds);
    filteredIdsRef.current = filteredIds;
    const itemHeight = density === 'compact' ? 42 : 72;
    const isVirtual = filtered.length > VIRTUAL_WINDOW_SIZE;
    const safeStartIndex = isVirtual ? Math.max(0, Math.min(startIndex, filtered.length - VIRTUAL_WINDOW_SIZE)) : 0;
    const endIndex = isVirtual ? Math.min(filtered.length, safeStartIndex + VIRTUAL_WINDOW_SIZE) : filtered.length;
    const topSpacerHeight = safeStartIndex * itemHeight;
    const bottomSpacerHeight = Math.max(0, (filtered.length - endIndex) * itemHeight);
    const rendered = useMemo(() => isVirtual ? filtered.slice(safeStartIndex, endIndex) : filtered, [filtered, isVirtual, safeStartIndex, endIndex]);
    const renderedIds = useMemo(() => new Set(rendered.map((item) => item.note.id)), [rendered]);
    // Only rendered rows ask for their position, so the map covers the window instead of
    // allocating one entry per note on every filter change.
    const filteredPositions = useMemo(
        () => new Map(rendered.map((item, index) => [item.note.id, safeStartIndex + index + 1])),
        [rendered, safeStartIndex]);
    const groups = useMemo(() => groupNotes(rendered, sort, view === 'trash', nowMinute, filtered.some((i) => i.note.isPinned)), [rendered, sort, view, locale, nowMinute, filtered]);
    useEffect(() => {
        setStartIndex(0);
        listRef.current?.scrollTo?.({ top: 0 });
    }, [view, folderId, tagFilters, deferredFilter, sort, order, density]);
    useEffect(() => {
        if (!activeNoteId)
            return;
        const activeIndex = filteredIds.indexOf(activeNoteId);
        if (activeIndex < 0)
            return;
        if (isVirtual && (activeIndex < safeStartIndex || activeIndex >= endIndex)) {
            const targetStart = Math.max(0, activeIndex - Math.floor(VIRTUAL_WINDOW_SIZE / 2));
            setStartIndex(targetStart);
            listRef.current?.scrollTo?.({ top: activeIndex * itemHeight });
        }
    }, [activeNoteId, filteredIds, isVirtual, safeStartIndex, endIndex, itemHeight]);
    const onListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
        if (filtered.length <= VIRTUAL_WINDOW_SIZE)
            return;
        const top = event.currentTarget.scrollTop;
        const approxIndex = Math.floor(top / itemHeight);
        const targetStart = Math.max(0, approxIndex - VIRTUAL_OVERSCAN);
        setStartIndex((prev) => (Math.abs(prev - targetStart) >= 5 ? targetStart : prev));
    }, [filtered.length, itemHeight]);
    useEffect(() => {
        if (!activeNoteId)
            return;
        listRef.current
            ?.querySelector<HTMLElement>(`[data-note-id="${activeNoteId}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [activeNoteId, safeStartIndex, endIndex, view, folderId, tagFilters]);
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.target !== event.currentTarget || event.nativeEvent.isComposing)
            return;
        if (matches(event.nativeEvent, NOTE_LIST_SHORTCUTS.delete) && view !== 'trash') {
            event.preventDefault();
            if (event.repeat) return;
            const ui = useUi.getState();
            const ids = ui.selectedIds.length ? ui.selectedIds : activeNoteId ? [activeNoteId] : [];
            const targets = ids.filter((id) => filteredIds.includes(id));
            void (async () => {
                if (targets.length > 1 && !await confirm({
                    title: t('notes.move_value0_notes_to_trash', { value0: targets.length }),
                    description: t('notes.restore_it_from_trash_at_any_time'),
                    confirmLabel: t('common.move_to_trash'), tone: 'danger',
                })) return;
                for (const id of targets) await useNotes.getState().deleteNote(id);
            })();
            return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (event.key === 'Escape') {
            useUi.getState().setSelected(activeNoteId ? [activeNoteId] : []);
            return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
            return;
        event.preventDefault();
        const index = filteredIds.indexOf(activeNoteId ?? '');
        const next = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? filteredIds.length - 1
                : event.key === 'ArrowDown'
                    ? index + 1
                    : index - 1;
        const target = filteredIds[Math.max(0, Math.min(filteredIds.length - 1, next))];
        if (target)
            void openNote(target);
    };
    const selectRange = useCallback((targetId: string) => {
        const ids = filteredIdsRef.current;
        const ui = useUi.getState();
        const anchor = ui.selectedIds[0] ?? ui.activeNoteId;
        const from = ids.indexOf(anchor ?? '');
        const to = ids.indexOf(targetId);
        if (from < 0 || to < 0) {
            ui.setSelected([targetId]);
            return;
        }
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        ui.setSelected(ids.slice(lo, hi + 1));
    }, []);
    const sortItems: MenuItem[] = view === 'recent' || view === 'trash' ? [
        {
            id: 'fixed-order',
            label: view === 'trash' ? t("notes.recently_deleted_first") : t("notes.recently_edited_first"),
            checked: true,
            disabled: true,
        },
        {
            id: 'density',
            label: density === 'comfortable' ? t("notes.compact_list") : t("notes.comfortable_list"),
            separatorBefore: true,
            onSelect: () => useUi.getState().setDensity(density === 'comfortable' ? 'compact' : 'comfortable'),
        },
    ] : [
        { id: 'updated', label: t("notes.modified"), checked: sort === 'updated', onSelect: () => setSort('updated') },
        { id: 'created', label: t("notes.created"), checked: sort === 'created', onSelect: () => setSort('created') },
        { id: 'title', label: t("notes.title"), checked: sort === 'title', onSelect: () => setSort('title', 'asc') },
        {
            id: 'order',
            label: order === 'desc' ? t("notes.sort_ascending") : t("notes.sort_descending"),
            separatorBefore: true,
            onSelect: () => setSort(sort, order === 'desc' ? 'asc' : 'desc'),
        },
        {
            id: 'density',
            label: density === 'comfortable' ? t("notes.compact_list") : t("notes.comfortable_list"),
            onSelect: () => useUi.getState().setDensity(density === 'comfortable' ? 'compact' : 'comfortable'),
        },
    ];
    return (<section className={cn('relative flex h-full min-h-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-base)]', breakpoint === 'mobile' && 'mobile-note-list')}>
      <header className="shrink-0 px-3 pt-3 pb-2">
        {breakpoint === 'mobile' && <div className="mobile-library-brand"><Logo size={22}/><span>{t('common.product_name')}</span></div>}
        {breakpoint === 'mobile' && dayFilterChip}
        {breakpoint !== 'mobile' && <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-[14.5px] font-semibold tracking-[-0.016em] text-[var(--text-primary)]">{title}</h2>
            {view === 'folder' && !isVirtualFolderId(folderId) && <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-quaternary)]">{t("folders.includes_subfolders")}</p>}
            {dayFilterChip}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {breakpoint === 'tablet' && (<Tooltip label={t("notes.open_navigation")}>
                <IconButton label={t("notes.open_navigation")} size="sm" onClick={() => toggleNavDrawer(true)}>
                  <PanelLeft size={14}/>
                </IconButton>
              </Tooltip>)}
            <Tooltip label={t("notes.sort_and_display")}>
              <IconButton label={t("notes.sort_and_display")} size="sm" ref={sortButtonRef} onClick={() => setSortMenuOpen(true)}>
                <ArrowDownWideNarrow size={14}/>
              </IconButton>
            </Tooltip>
            {view !== 'trash' && view !== 'archived' && <TemplateQuickActions/>}
            {view !== 'trash' && view !== 'archived' && (<Tooltip label={t("common.new_note")} combo={APP_SHORTCUTS.newNote}>
                <IconButton label={t("common.new_note")} size="sm" onClick={() => void createContextualNote()}>
                  <Plus size={15}/>
                </IconButton>
              </Tooltip>)}
            <Tooltip label={t('navigation.close_list')} combo={APP_SHORTCUTS.toggleList}>
              <IconButton label={t('navigation.close_list')} size="sm" onClick={() => useUi.getState().toggleList()}><X size={14}/></IconButton>
            </Tooltip>
          </div>
        </div>}

        {(breakpoint === 'mobile' || searchList) && <div className={breakpoint === 'mobile' ? 'mobile-library-toolbar' : undefined}>
          <div className={cn('relative', breakpoint === 'mobile' && 'mobile-note-search')}>
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-quaternary)]"/>
            <input ref={filterRef} aria-label={searchList ? t('shell.search_all_notes') : t("notes.filter_in_this_view")} value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Escape')
                  setFilter('');
              if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  const first = filtered[0]?.note.id;
                  if (first)
                      void openNote(first);
                  listRef.current?.focus();
              }
          }} placeholder={searchList ? t('shell.search_all_notes') : t("notes.filter_in_this_view")} className={cn('h-10 w-full rounded-[var(--r-md)] border border-transparent bg-[var(--bg-inset)] md:h-[30px]', 'pr-9 pl-8 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] md:pr-7 md:pl-7', 'transition-[border-color,box-shadow] duration-[var(--dur-fast)]', 'focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none')}/>
            {filter && (<Tooltip label={t("notes.clear_filters")} side="left">
                <button type="button" onClick={() => setFilter('')} aria-label={t("notes.clear_filters")} className="absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]">
                  <X size={12}/>
                </button>
              </Tooltip>)}
          </div>
          {breakpoint === 'mobile' && <><OmnisearchEntry mobile className="mobile-library-omnisearch"/><Tooltip label={t("notes.sort_and_display")}>
            <IconButton label={t("notes.sort_and_display")} size="sm" className="mobile-library-sort" ref={sortButtonRef} onClick={() => setSortMenuOpen(true)}>
              <ArrowDownWideNarrow size={17}/>
            </IconButton>
          </Tooltip>
          {quickAddOn && (<Tooltip label={t('quickadd.launcher_title')}>
              <IconButton label={t('quickadd.launcher_title')} size="sm" className="mobile-library-quickadd" onClick={() => useUi.getState().togglePanel('quickadd')}>
                <Zap size={17}/>
              </IconButton>
            </Tooltip>)}
          {view !== 'trash' && view !== 'archived' && <TemplateQuickActions iconSize={17} className="mobile-library-templates"/>}
          {view !== 'trash' && view !== 'archived' && (<Tooltip label={t("common.new_note")} combo={APP_SHORTCUTS.newNote}>
              <IconButton label={t("common.new_note")} size="sm" className="mobile-library-compose" onClick={() => void createContextualNote()}>
                <Plus size={19}/>
              </IconButton>
            </Tooltip>)}
          </>}
        </div>}

        {searchList && filter.trim() && (remote?.query !== filter.trim() || remote.failed) && <p role="status" className="mt-2 text-[11.5px] text-[var(--text-tertiary)]">{remote?.query === filter.trim() && remote.failed ? t('navigation.local_search_only') : t('navigation.searching')}</p>}

        {breakpoint === 'mobile' && <MobileLibraryFilters />}

        {view === 'trash' && notes.length > 0 && (<button type="button" disabled={emptyingTrash} aria-busy={emptyingTrash} onClick={() => void emptyTrash()} className="mt-2 w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] py-1.5 text-[11.5px] text-[var(--text-tertiary)] transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:pointer-events-none disabled:opacity-50">{t("notes.empty_trash")}{notes.length}{t("notes.notes_93aeb9")}</button>)}
      </header>

      <div key={`${view}:${folderId ?? ''}:${tagFilters.join('+')}`} ref={listRef} onScroll={onListScroll} data-note-list role="listbox" aria-label={title} aria-multiselectable="true" aria-activedescendant={activeNoteId && renderedIds.has(activeNoteId) ? `note-option-${activeNoteId}` : undefined} tabIndex={0} onKeyDown={onKeyDown} className="anim-view-content min-h-0 flex-1 overflow-y-auto px-2 pb-4 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]">
        {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} aria-hidden="true" />}
        {!hydrated && loading ? (<NoteListSkeleton />) : filtered.length === 0 ? (<ListEmpty view={view} filtering={Boolean(filter)} dayFiltering={Boolean(dateFilter)}/>) : (groups.map((group) => (<div key={group.key} role="group" aria-label={group.label ?? title}>
              {group.label && (<div className="px-2 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
                  {group.label}
                </div>)}
              <div role="presentation" className="space-y-px">
                {group.items.map(({ note, ranges }) => (<NoteRow key={note.id} note={note} highlight={ranges} density={density} tagColors={tagColors} position={filteredPositions.get(note.id) ?? 1} total={filtered.length} onRangeSelect={selectRange}/>))}
              </div>
            </div>)))}
        {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight }} aria-hidden="true" />}
      </div>

      <BulkBar />

      <Menu anchor={sortButtonRef} open={sortMenuOpen} onClose={() => setSortMenuOpen(false)} items={sortItems} align="end"/>
    </section>);
}
const NoteRow = memo(function NoteRow({ note, highlight, density, tagColors, position, total, onRangeSelect, }: {
    note: NoteSummary;
    highlight: [
        number,
        number
    ][];
    density: 'comfortable' | 'compact';
    tagColors: Map<string, string | null>;
    position: number;
    total: number;
    onRangeSelect: (noteId: string) => void;
}) {
    const breakpoint = useBreakpoint();
    const locale = useLocale();
    const toast = useUi((s) => s.toast);
    const active = useUi((s) => s.activeNoteId === note.id);
    const openInSecondary = useUi((s) => s.workspaceSecondaryNoteId === note.id);
    const selectedIds = useUi((s) => s.selectedIds);
    const selected = selectedIds.includes(note.id);
    const selectionHighlighted = selected && (selectedIds.length > 1 || !active);
    const toggleSelected = useUi((s) => s.toggleSelected);
    const openView = useUi((s) => s.openView);
    const openNote = useNotes((s) => s.openNote);
    const patchNote = useNotes((s) => s.patchNote);
    const deleteNote = useNotes((s) => s.deleteNote);
    const restoreNote = useNotes((s) => s.restoreNote);
    const purgeNote = useNotes((s) => s.purgeNote);
    const duplicateNote = useNotes((s) => s.duplicateNote);
    const folders = useNotes((s) => s.folders);
    const menu = useContextMenu();
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [moveOpen, setMoveOpen] = useState(false);
    const purgeRef = useRef(false);
    const [purging, setPurging] = useState(false);
    const inTrash = Boolean(note.deletedAt);
    const purge = async () => {
        if (purgeRef.current)
            return;
        purgeRef.current = true;
        setPurging(true);
        try {
            const ok = await confirm({
                title: t("notes.permanently_delete_this_note"),
                description: t("notes.this_operation_cannot_be_undone"),
                confirmLabel: t("notes.delete_permanently"),
                tone: 'danger',
            });
            if (ok)
                await purgeNote(note.id);
        }
        finally {
            purgeRef.current = false;
            setPurging(false);
        }
    };
    const exportNote = async (format: 'md' | 'html' | 'pdf') => {
        const state = useNotes.getState();
        let content = state.contents[note.id];
        if (content === undefined) {
            await state.openNote(note.id);
            content = useNotes.getState().contents[note.id];
            if (content === undefined) {
                toast({ title: t("common.export_failed"), tone: 'danger' });
                return;
            }
        }
        const payload = { title: note.title, content };
        if (format === 'md') {
            exportNoteAsMarkdown(payload);
            return;
        }
        try {
            if (format === 'html')
                await exportNoteAsHtml(payload, locale);
            else
                await exportNoteAsPdf(payload, locale);
        }
        catch (err) {
            toast({
                title: t("common.export_failed"),
                description: err instanceof Error ? err.message : String(err),
                tone: 'danger',
            });
        }
    };
    const copyText = async (value: string, successMessage: 'notes.title_copied' | 'notes.id_copied' | 'notes.direct_link_copied') => {
        try {
            await navigator.clipboard.writeText(value);
            toast({ title: t(successMessage), tone: 'success' });
        }
        catch {
            toast({ title: t('preview.could_not_copy'), tone: 'danger' });
        }
    };
    const noteActions: MenuItem[] = inTrash
        ? [
            { id: 'restore', label: t("common.restore"), icon: <RotateCcw size={13}/>, separatorBefore: true, onSelect: () => void restoreNote(note.id) },
            {
                id: 'purge',
                label: t("notes.delete_permanently"),
                icon: <Trash2 size={13}/>,
                tone: 'danger',
                separatorBefore: true,
                disabled: purging,
                onSelect: () => void purge(),
            },
        ]
        : [
            ...(breakpoint === 'desktop' ? [{
                id: 'open-side',
                label: t("notes.open_to_side"),
                icon: <Columns2 size={13}/>,
                separatorBefore: true,
                onSelect: () => void openNote(note.id, { pane: 'secondary' }),
            } satisfies MenuItem] : []),
            ...(breakpoint === 'mobile' ? [{
                id: 'multi-select',
                label: t("notes.add_to_selection"),
                icon: <CheckSquare2 size={13}/>,
                separatorBefore: true,
                disabled: selectedIds.includes(note.id),
                onSelect: () => toggleSelected(note.id, true),
            } satisfies MenuItem] : []),
            {
                id: 'pin',
                label: note.isPinned ? t("notes.unpin") : t("notes.pin"),
                icon: note.isPinned ? <PinOff size={13}/> : <Pin size={13}/>,
                separatorBefore: breakpoint !== 'desktop' && breakpoint !== 'mobile',
                onSelect: () => void patchNote(note.id, { isPinned: !note.isPinned }),
            },
            {
                id: 'star',
                label: note.isStarred ? t("common.remove_from_favorites") : t("navigation.favorites"),
                icon: note.isStarred ? <StarOff size={13}/> : <Star size={13}/>,
                combo: active ? APP_SHORTCUTS.star : undefined,
                onSelect: () => void patchNote(note.id, { isStarred: !note.isStarred }),
            },
            { id: 'duplicate', label: t("notes.create_a_copy"), icon: <Copy size={13}/>, onSelect: () => void duplicateNote(note.id) },
            {
                id: 'archive',
                label: note.isArchived ? t("common.unarchive") : t("navigation.archive"),
                icon: <Archive size={13}/>,
                onSelect: () => void patchNote(note.id, { isArchived: !note.isArchived }),
            },
            {
                id: 'move',
                label: t("notes.move_to_folder"),
                icon: <FolderInput size={13}/>,
                separatorBefore: true,
                onSelect: () => setMoveOpen(true),
            },
            { id: 'export-md', label: t("workspace.export_markdown"), icon: <FileText size={13}/>, separatorBefore: true, onSelect: () => void exportNote('md') },
            { id: 'export-html', label: t("workspace.export_html"), icon: <FileCode size={13}/>, onSelect: () => void exportNote('html') },
            { id: 'export-pdf', label: t("workspace.export_pdf"), icon: <FileDown size={13}/>, onSelect: () => void exportNote('pdf') },
            {
                id: 'delete',
                label: t("common.move_to_trash"),
                icon: <Trash2 size={13}/>,
                tone: 'danger',
                separatorBefore: true,
                onSelect: () => void deleteNote(note.id),
            },
        ];
    const items: MenuItem[] = [
        { id: 'copy-title', label: t('notes.copy_title'), icon: <Copy size={13}/>, onSelect: () => void copyText(note.title || t('common.untitled_note'), 'notes.title_copied') },
        { id: 'copy-id', label: t('notes.copy_id'), icon: <Copy size={13}/>, onSelect: () => void copyText(note.id, 'notes.id_copied') },
        { id: 'copy-direct-link', label: t('notes.copy_direct_link'), icon: <Link2 size={13}/>, onSelect: () => void copyText(new URL(`/n/${encodeURIComponent(note.id)}`, window.location.origin).href, 'notes.direct_link_copied') },
        ...noteActions,
    ];
    const titleParts = splitByRanges(note.title || t("common.untitled_note"), highlight);
    return (<>
      <div id={`note-option-${note.id}`} role="option" aria-selected={active || selected} aria-posinset={position} aria-setsize={total} tabIndex={-1} data-note-id={note.id} draggable style={{ contentVisibility: 'auto', containIntrinsicSize: density === 'compact' ? 'auto 42px' : 'auto 72px' }} onDragStart={(e) => {
            writeNoteDrag(e, selectedIds.length > 1 && selectedIds.includes(note.id) ? selectedIds : [note.id]);
        }} onClick={(event) => {
            if (event.altKey && breakpoint === 'desktop') {
                event.preventDefault();
                void openNote(note.id, { pane: 'secondary' });
                return;
            }
            if (event.metaKey || event.ctrlKey) {
                toggleSelected(note.id, true);
                return;
            }
            if (event.shiftKey) {
                event.preventDefault();
                onRangeSelect(note.id);
                return;
            }
            void openNote(note.id);
        }} onContextMenu={(event) => {
            setMenuOpen(false);
            menu.onContextMenu(event);
        }} className={cn('motion-note-row group relative cursor-default rounded-[var(--r-md)] border border-transparent px-2.5 pr-11 transition-[background-color,border-color,box-shadow,transform] duration-[var(--dur-fast)] md:pr-[68px]', density === 'compact' ? 'py-[7px]' : 'py-2.5', selectionHighlighted
            ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/40'
            : active
                ? 'border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]'
                : openInSecondary
                    ? 'border-[var(--accent)]/35 bg-[var(--accent-soft)]/45'
                : 'hover:bg-[var(--bg-hover)]')}>
        <div className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {note.isPinned && <Pin size={10} className="anim-mark-enter shrink-0 text-[var(--accent)]"/>}
              <h3 className={cn('min-w-0 flex-1 truncate text-[13px] leading-snug', active
            ? 'font-semibold text-[var(--accent)]'
            : 'font-medium text-[var(--text-primary)]')}>
                {titleParts.map((part, i) => part.hit ? (<mark key={i} className="ink-hit">
                      {part.text}
                    </mark>) : (<span key={i}>{part.text}</span>))}
              </h3>
              {note.isStarred && <Star size={10} className="anim-mark-enter shrink-0 fill-current text-[var(--warning)]"/>}
            </div>

            {density === 'comfortable' && note.excerpt && (<p className="truncate-2 mt-1 text-[11.5px] leading-[1.5] text-[var(--text-tertiary)]">
                {note.excerpt}
              </p>)}

            {note.tags.length > 0 && density === 'comfortable' && (<div className="group/tags mt-1.5 flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[10.5px] text-[var(--text-tertiary)]">
                {note.tags.map((tag) => (<span key={tag} className="flex max-w-[70%] shrink-0 items-center gap-px truncate">
                    <button type="button" onClick={(event) => {
                            event.stopPropagation();
                            openView('tag', { tag });
                        }} className="truncate hover:underline" style={{ color: tagColors.get(tag) ?? undefined }}>
                      #{tag}
                    </button>
                    <button type="button" aria-label={t("notes.remove_tag_value0", { value0: tag })} onClick={(event) => {
                            event.stopPropagation();
                            void removeTagFromNote(note.id, tag);
                        }} className="shrink-0 text-[var(--text-quaternary)] opacity-0 transition-opacity hover:text-[var(--danger)] focus-visible:opacity-100 group-hover/tags:opacity-100">
                      <X size={9}/>
                    </button>
                  </span>))}
              </div>)}
          </div>
        </div>
        {breakpoint === 'desktop' && (<div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Tooltip label={t("notes.open_to_side")} side="left">
              <IconButton label={t("notes.open_to_side")} size="sm" active={openInSecondary} onClick={(event) => {
                  event.stopPropagation();
                  void openNote(note.id, { pane: 'secondary' });
              }}>
                <Columns2 size={14}/>
              </IconButton>
            </Tooltip>
            <Tooltip label={t("notes.open_in_floating_window")} side="left">
              <IconButton label={t("notes.open_in_floating_window")} size="sm" onClick={(event) => {
                  event.stopPropagation();
                  openNoteFloatingWindow(note, event.currentTarget.closest('[data-note-id]')?.getBoundingClientRect() ?? null);
              }}>
                <PictureInPicture2 size={14}/>
              </IconButton>
            </Tooltip>
          </div>)}
        {breakpoint === 'mobile' && (<Tooltip label={t("common.more_actions")} side="left">
            <IconButton ref={menuButtonRef} label={t("common.more_actions")} size="sm" onClick={(event) => {
                  event.stopPropagation();
                  menu.close();
                  setMenuOpen(true);
              }} className="absolute top-1.5 right-1.5">
              <MoreHorizontal size={16}/>
            </IconButton>
          </Tooltip>)}
      </div>

      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items}/>}
      <Menu anchor={menuButtonRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} align="end" width={240}/>
      {moveOpen && <FolderPicker open title={t("notes.move_to_folder")} folders={folders} currentId={note.folderId} rootLabel={t("notes.remove_from_folder")} onSelect={(folderId) => void patchNote(note.id, { folderId })} onClose={() => setMoveOpen(false)}/>}
    </>);
});
function BulkBar() {
    const selectedIds = useUi((s) => s.selectedIds);
    const setSelected = useUi((s) => s.setSelected);
    const patchNote = useNotes((s) => s.patchNote);
    const deleteNote = useNotes((s) => s.deleteNote);
    const folders = useNotes((s) => s.folders);
    const notes = useNotes((s) => s.notes);
    const toast = useUi((s) => s.toast);
    const [folderPickerOpen, setFolderPickerOpen] = useState(false);
    const busyRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const ids = selectedIds.filter((id) => notes[id]);
    if (ids.length < 2)
        return null;
    const allStarred = ids.every((id) => notes[id]?.isStarred);
    const firstFolderId = notes[ids[0]!]?.folderId ?? null;
    const commonFolderId = ids.every((id) => notes[id]?.folderId === firstFolderId) ? firstFolderId : undefined;
    const clear = () => {
        const currentActiveId = useUi.getState().activeNoteId;
        setSelected(currentActiveId ? [currentActiveId] : []);
    };
    const performAll = async (fn: (id: string) => Promise<void>, label: string) => {
        for (const id of ids)
            await fn(id);
        toast({ title: t("notes.value0_value1_notes", { value0: label, value1: ids.length }), tone: 'success' });
        clear();
    };
    const runAll = async (task: () => Promise<void>) => {
        if (busyRef.current)
            return;
        busyRef.current = true;
        setBusy(true);
        try {
            await task();
        }
        catch (err) {
            toast({ title: t("common.action_failed"), description: err instanceof Error ? err.message : String(err), tone: 'danger' });
        }
        finally {
            busyRef.current = false;
            setBusy(false);
        }
    };
    return (<div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-3">
      <div className="anim-rise pointer-events-auto flex items-center gap-1 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 pl-3 shadow-[var(--shadow-pop)]">
        <span className="mr-1 text-[11.5px] whitespace-nowrap text-[var(--text-secondary)]">{t("notes.selected")}<span className="tabular font-medium">{ids.length}</span>{t("notes.notes")}</span>
        <Tooltip label={allStarred ? t("common.remove_from_favorites") : t("navigation.favorites")}>
          <IconButton label={t("navigation.favorites")} size="sm" disabled={busy} onClick={() => void runAll(() => performAll((id) => patchNote(id, { isStarred: !allStarred }), allStarred ? t("notes.removed_from_favorites") : t("notes.added_to_favorites")))}>
            <Star size={13} className={allStarred ? 'fill-current' : undefined}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t("notes.move_to_folder")}>
          <IconButton label={t("notes.move_to_folder")} size="sm" disabled={busy} onClick={() => setFolderPickerOpen(true)}>
            <FolderInput size={13}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t("navigation.archive")}>
          <IconButton label={t("navigation.archive")} size="sm" disabled={busy} onClick={() => void runAll(() => performAll((id) => patchNote(id, { isArchived: true }), t("notes.archived")))}>
            <Archive size={13}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t("common.move_to_trash")}>
          <IconButton label={t("common.move_to_trash")} size="sm" disabled={busy} className="text-[var(--text-tertiary)] hover:text-[var(--danger)]" onClick={() => void runAll(async () => {
            const ok = await confirm({
                title: t("notes.move_value0_notes_to_trash", { value0: ids.length }),
                description: t("notes.restore_it_from_trash_at_any_time"),
                confirmLabel: t("common.move_to_trash"),
                tone: 'danger',
            });
            if (ok)
                await performAll((id) => deleteNote(id), t("notes.deleted"));
        })}>
            <Trash2 size={13}/>
          </IconButton>
        </Tooltip>
        <span className="mx-0.5 h-4 w-px bg-[var(--border-subtle)]"/>
        <Tooltip label={t("notes.deselect")}>
          <IconButton label={t("notes.deselect")} size="sm" disabled={busy} onClick={clear}>
            <X size={13}/>
          </IconButton>
        </Tooltip>
      </div>

      {folderPickerOpen && <FolderPicker open title={t("notes.move_to_folder")} folders={folders} currentId={commonFolderId} rootLabel={t("notes.remove_from_folder")} onSelect={(folderId) => void runAll(() => performAll((id) => patchNote(id, { folderId }), folderId ? t("notes.moved") : t("notes.moved_out")))} onClose={() => setFolderPickerOpen(false)}/>}
    </div>);
}
function ListEmpty({ view, filtering, dayFiltering }: {
    view: string;
    filtering: boolean;
    dayFiltering: boolean;
}) {
    const shortcut = (combo: string) => prettyCombo(combo).join('+');
    if (filtering) {
        return <Empty art="search" title={t("notes.no_matching_notes")} description={t("notes.try_another_search_or_press_shortcut_to_search_everywhere", { shortcut: shortcut(APP_SHORTCUTS.search) })}/>;
    }
    if (dayFiltering) {
        return (<Empty art="search" title={t("notes.no_notes_on_this_day")} description={t("notes.no_notes_on_this_day_desc")} action={<button type="button" onClick={() => useUi.getState().setDateFilter(null)} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)] px-3 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
            <X size={13}/>{t("notes.clear_day_filter")}</button>}/>);
    }
    const config: Record<string, {
        art: 'notes' | 'starred' | 'trash' | 'archive' | 'folder' | 'tag';
        title: string;
        desc: string;
    }> = {
        all: { art: 'notes', title: t("notes.no_notes_yet"), desc: t("notes.press_shortcut_or_the_plus_button_to_write_your_first_note", { shortcut: shortcut(APP_SHORTCUTS.newNote) }) },
        recent: { art: 'notes', title: t("notes.nothing_has_been_edited_recently"), desc: t("notes.write_something_and_it_will_appear_here") },
        starred: { art: 'starred', title: t("notes.no_favorites_yet"), desc: t("notes.right_click_a_note_or_press_shortcut_to_favorite_it", { shortcut: shortcut(APP_SHORTCUTS.star) }) },
        unfiled: { art: 'folder', title: t("notes.every_note_is_filed"), desc: t("notes.everything_is_neatly_organized") },
        archived: { art: 'archive', title: t("notes.archive_is_empty"), desc: t("notes.keep_notes_here_when_you_want_them_out_of_the_way_but_not_deleted") },
        trash: { art: 'trash', title: t("notes.trash_is_empty"), desc: t("notes.deleted_notes_remain_until_you_restore_or_clear_them") },
        folder: { art: 'folder', title: t("notes.this_folder_is_still_empty"), desc: t("notes.drag_notes_in_or_create_new_ones_here") },
        untagged: { art: 'tag', title: t("notes.every_note_has_a_tag"), desc: t("notes.write_tags_in_the_note_to_link_them_automatically") },
        tag: { art: 'tag', title: t("notes.there_are_no_notes_with_this_tag"), desc: t("notes.write_tags_in_the_note_to_link_them_automatically") },
    };
    const item = config[view] ?? config.all!;
    return (<Empty art={item.art} title={item.title} description={item.desc} action={view !== 'trash' && view !== 'archived' ? (<button type="button" onClick={() => void createContextualNote()} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)] px-3 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
            <Plus size={13}/>{t("common.new_note")}</button>) : undefined}/>);
}
interface Group {
    key: string;
    label: string | null;
    items: {
        note: NoteSummary;
        ranges: [
            number,
            number
        ][];
    }[];
}
function groupNotes(items: {
    note: NoteSummary;
    ranges: [
        number,
        number
    ][];
}[], sort: SortKey, isTrash: boolean, now: number, hasPinnedInFullList?: boolean): Group[] {
    const pinned = isTrash ? [] : items.filter((i) => i.note.isPinned);
    const rest = isTrash ? items : items.filter((i) => !i.note.isPinned);
    const groups: Group[] = [];
    if (pinned.length)
        groups.push({ key: 'pinned', label: t("notes.pin"), items: pinned });
    if (sort === 'updated' || sort === 'created' || isTrash) {
        let currentKey: string | null = null;
        let bucket: Group | null = null;
        for (const item of rest) {
            const stamp = isTrash
                ? (item.note.deletedAt ?? item.note.updatedAt)
                : sort === 'created'
                    ? item.note.createdAt
                    : item.note.updatedAt;
            const label = groupLabel(stamp, now);
            if (label !== currentKey) {
                currentKey = label;
                bucket = { key: `${label}-${groups.length}`, label, items: [] };
                groups.push(bucket);
            }
            bucket?.items.push(item);
        }
    }
    else if (rest.length) {
        const hasPinned = hasPinnedInFullList ?? Boolean(pinned.length);
        groups.push({ key: 'rest', label: hasPinned ? t("notes.other") : null, items: rest });
    }
    return groups.filter((g) => g.items.length);
}
function useEmptyTrash() {
    const emptyTrashAction = useNotes((s) => s.emptyTrash);
    const toast = useUi((s) => s.toast);
    const [emptyingTrash, setEmptyingTrash] = useState(false);
    const busyRef = useRef(false);
    const emptyTrash = async () => {
        if (busyRef.current)
            return;
        busyRef.current = true;
        setEmptyingTrash(true);
        try {
            const ok = await confirm({
                title: t("common.empty_trash"),
                description: t("notes.every_note_inside_will_be_permanently_deleted_and_cannot_be_recovered"),
                confirmLabel: t("common.clear"),
                tone: 'danger',
            });
            if (!ok)
                return;
            const purged = await emptyTrashAction();
            if (purged === null)
                return;
            toast({
                title: t("common.permanently_deleted_value0_notes", { value0: purged }),
                tone: 'success',
            });
        }
        catch (err) {
            toast({ title: t("notes.clearing_failed"), description: err instanceof Error ? err.message : String(err), tone: 'danger' });
        }
        finally {
            busyRef.current = false;
            setEmptyingTrash(false);
        }
    };
    return { emptyTrash, emptyingTrash };
}
