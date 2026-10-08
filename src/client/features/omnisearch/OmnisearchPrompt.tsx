import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownRight, FileText, FolderOpen, ImageIcon, ScanSearch, X } from 'lucide-react';
import type { ParsedOmnisearchQuery } from '@shared/omnisearch-query';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { useBreakpoint, useDebounced } from '../../lib/hooks';
import { IconButton, Kbd } from '../../components/primitives';
import { Tooltip, useDialogFocus, useEscape, useLockScroll } from '../../components/overlay';
import { createContextualNote, useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { useSession } from '../../store/session';
import { useLongPress } from '../workspace/context-menu/use-long-press';
import { omnisearchIndexer, type IndexerStatus } from './indexer';
import { closeOmnisearch, type OmnisearchMode } from './store';
import { docIdForNote, fileIdOfDoc, noteIdOfDoc } from './engine';
import { buildExcerpt, findMatches, groupOffsets } from './excerpt';
import { insertAtActiveCursor, revealInNote } from './reveal';
import { initialQueryOf, loadHistory, pushHistory } from './history';
import type { Excerpt, OmnisearchResult } from './types';
const ROW_CLASS = 'flex w-full items-start gap-2.5 rounded-[var(--r-md)] px-2.5 py-2 text-left';
const ROW_ACTIVE_CLASS = `${ROW_CLASS} bg-[var(--accent-soft)]`;
const SEARCH_DELAY_MS = 120;
const IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|svg)$/;
function useIndexerStatus(): IndexerStatus {
    return useSyncExternalStore(omnisearchIndexer.subscribe, omnisearchIndexer.getStatus, omnisearchIndexer.getStatus);
}
function rangesOf(text: string, terms: readonly string[], ignoreDiacritics: boolean): [number, number][] {
    return findMatches(text, terms, {
        ignoreDiacritics,
        limit: 64,
    }).map((match) => [match.offset, match.offset + match.term.length]);
}
function Highlighted({ text, terms, ignoreDiacritics }: {
    text: string;
    terms: readonly string[];
    ignoreDiacritics: boolean;
}) {
    const ranges = useMemo(() => rangesOf(text, terms, ignoreDiacritics), [text, terms, ignoreDiacritics]);
    if (!ranges.length) return <>{text}</>;
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    ranges.forEach(([start, end], index) => {
        if (start < cursor) return;
        if (start > cursor) parts.push(<span key={`p${index}`}>{text.slice(cursor, start)}</span>);
        parts.push(<mark className="ink-hit" key={`h${index}`}>{text.slice(start, end)}</mark>);
        cursor = end;
    });
    if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);
    return <>{parts}</>;
}
function ExcerptBody({ excerpt, terms, ignoreDiacritics }: {
    excerpt: Excerpt;
    terms: readonly string[];
    ignoreDiacritics: boolean;
}) {
    if (!excerpt.lines.length) return null;
    return (<div className="mt-0.5 space-y-px text-[11.5px] leading-relaxed text-[var(--text-quaternary)]">
        {excerpt.leading && <span aria-hidden="true">…</span>}
        {excerpt.lines.slice(0, 4).map((line, index) => (<div key={index} className="overflow-hidden text-ellipsis whitespace-nowrap">
            <Highlighted text={line.text} terms={terms} ignoreDiacritics={ignoreDiacritics}/>
          </div>))}
        {excerpt.trailing && <span aria-hidden="true">…</span>}
      </div>);
}
interface Cursor {
    index: number;
    fromPointer: boolean;
}
const ResultRow = memo(function ResultRow({ result, active, index, listId, terms, ignoreDiacritics, showExcerpt, onHover, onInvoke, onHold, }: {
    result: OmnisearchResult;
    active: boolean;
    index: number;
    listId: string;
    terms: readonly string[];
    ignoreDiacritics: boolean;
    showExcerpt: boolean;
    onHover: (index: number) => void;
    onInvoke: (result: OmnisearchResult, meta: {
        pane: boolean;
    }) => void;
    onHold: (result: OmnisearchResult) => void;
}) {
    const longPress = useLongPress(() => onHold(result));
    const { doc } = result;
    const isFile = doc.kind === 'file';
    const title = doc.displayTitle || doc.title;
    return (<button id={`${listId}-option-${index}`} type="button" role="option" aria-selected={active} tabIndex={-1} data-index={index} {...longPress.handlers} onMouseEnter={() => onHover(index)} onClick={(event) => onInvoke(result, {
        pane: event.metaKey || event.ctrlKey,
    })} className={active ? ROW_ACTIVE_CLASS : ROW_CLASS}>
        <span className={cn('mt-0.5 shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>
          {isFile ? <ImageIcon size={14}/> : <FileText size={14}/>}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {result.isEmbed && (<Tooltip label={t('omnisearch.embedded_in')}>
                <CornerDownRight size={12} className="shrink-0 text-[var(--text-quaternary)]"/>
              </Tooltip>)}
            <span className="min-w-0 truncate text-[13px] text-[var(--text-primary)]">
              <Highlighted text={title} terms={terms} ignoreDiacritics={ignoreDiacritics}/>
              {!doc.displayTitle && !isFile && (<span className="text-[var(--text-quaternary)]">.{doc.ext}</span>)}
            </span>
            {result.matchCount > 1 && (<span className="shrink-0 text-[10.5px] tabular text-[var(--text-quaternary)]">
                {t('omnisearch.match_count', {
                    value0: result.matchCount,
                })}
              </span>)}
          </span>
          {doc.folder && !isFile && (<span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-quaternary)]">
              <FolderOpen size={11} className="shrink-0"/>
              <span className="min-w-0 truncate">
                <Highlighted text={doc.folder} terms={terms} ignoreDiacritics={ignoreDiacritics}/>
              </span>
            </span>)}
          {showExcerpt && !result.isEmbed && (<ExcerptBody excerpt={result.excerpt} terms={terms} ignoreDiacritics={ignoreDiacritics}/>)}
        </span>
      </button>);
});
interface FileRow {
    offset: number;
    length: number;
    excerpt: Excerpt;
}
export function OmnisearchPrompt({ mode, seed, noteId }: {
    mode: OmnisearchMode;
    seed: string;
    noteId: string | null;
}) {
    const breakpoint = useBreakpoint();
    const search = useSession((s) => s.settings.search);
    const updateSettings = useSession((s) => s.updateSettings);
    const status = useIndexerStatus();
    const notes = useNotes((s) => s.notes);
    const activeNoteId = useUi((s) => s.activeNoteId);
    const openNote = useNotes((s) => s.openNote);
    const setLightbox = useUi((s) => s.setLightbox);
    const toast = useUi((s) => s.toast);
    const [scope, setScope] = useState<OmnisearchMode>(mode);
    const [query, setQuery] = useState(seed);
    const [cursor, setCursor] = useState<Cursor>({
        index: 0,
        fromPointer: false,
    });
    const [results, setResults] = useState<OmnisearchResult[]>([]);
    const [fileRows, setFileRows] = useState<FileRow[]>([]);
    const [parsed, setParsed] = useState<ParsedOmnisearchQuery | null>(null);
    const [searching, setSearching] = useState(false);
    const [history, setHistory] = useState<string[]>([]);
    const historyIndex = useRef(0);
    const runId = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const listId = useId();
    const labelId = useId();
    const fileNoteId = scope === 'file' ? noteId ?? activeNoteId : null;
    const debounced = useDebounced(query, SEARCH_DELAY_MS, scope);
    useEscape(true, () => closeOmnisearch());
    useLockScroll(true);
    useDialogFocus(true, panelRef, inputRef);
    useEffect(() => {
        let cancelled = false;
        void loadHistory().then((items) => {
            if (cancelled) return;
            setHistory(items);
            if (seed) return;
            // Prefill only while the field is still empty: the promise can land after the reader has
            // typed, and overwriting the field would eat their keystrokes.
            const prefill = initialQueryOf(items, useSession.getState().settings.search.showPreviousQueryResults);
            setQuery((current) => (current ? current : prefill));
        });
        return () => {
            cancelled = true;
        };
    }, [seed]);
    useEffect(() => {
        if (scope === 'file' && !activeNoteId && !noteId) setScope('vault');
    }, [activeNoteId, noteId, scope]);
    useEffect(() => {
        const text = debounced.trim();
        const run = ++runId.current;
        if (!text && scope === 'vault') {
            setResults([]);
            setParsed(null);
            setSearching(false);
            return;
        }
        setSearching(true);
        void (async () => {
            const outcome = await omnisearchIndexer.query(text, fileNoteId ? {
                singleDocId: docIdForNote(fileNoteId),
            } : {});
            const rows = fileNoteId ? await buildFileRows(outcome.query, fileNoteId, useSession.getState().settings.search.ignoreDiacritics) : [];
            if (run !== runId.current) return;
            setParsed(outcome.query);
            setResults(outcome.results);
            setFileRows(rows);
            setCursor({
                index: 0,
                fromPointer: false,
            });
            setSearching(false);
        })();
    }, [debounced, fileNoteId, scope]);
    const terms = useMemo(() => parsed ? [...parsed.terms, ...parsed.exact, ...parsed.boostedTags] : [], [parsed]);
    const rows = scope === 'file' ? fileRows.length : results.length;
    const move = useCallback((offset: number) => {
        if (!rows) return;
        setCursor((current) => {
            const index = (current.index + offset + rows) % rows;
            return index === current.index && !current.fromPointer ? current : {
                index,
                fromPointer: false,
            };
        });
    }, [rows]);
    useEffect(() => {
        if (cursor.fromPointer) return;
        listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor.index}"]`)?.scrollIntoView({
            block: 'nearest',
        });
    }, [cursor, rows]);
    const openResult = useCallback((result: OmnisearchResult, options: {
        pane?: boolean;
        background?: boolean;
    } = {}) => {
        void pushHistory(query);
        closeOmnisearch();
        const fileId = fileIdOfDoc(result.id);
        if (fileId) {
            if (IMAGE_EXT.test(result.doc.ext)) setLightbox({
                src: `/api/files/${fileId}`,
                alt: result.doc.title,
            });
            else if (result.doc.noteId) void openNote(result.doc.noteId);
            else toast({
                title: t('omnisearch.file_without_note'),
            });
            return;
        }
        const target = noteIdOfDoc(result.id);
        if (!target) return;
        const activate = !options.background;
        void openNote(target, options.pane ? {
            pane: 'secondary',
            activate,
        } : {
            activate,
        });
        const match = result.matches[0];
        const offset = match?.offset ?? 0;
        void revealInNote(target, offset, offset + (match?.term.length ?? 0), activate);
    }, [openNote, query, setLightbox, toast]);
    const openAtOffset = useCallback((row: FileRow | undefined, pane?: boolean) => {
        if (!row || !fileNoteId) return;
        void pushHistory(query);
        closeOmnisearch();
        void openNote(fileNoteId, pane ? {
            pane: 'secondary',
        } : {});
        void revealInNote(fileNoteId, row.offset, row.offset + row.length, !pane);
    }, [fileNoteId, openNote, query]);
    const create = useCallback(() => {
        const title = query.trim();
        if (!title) return;
        void pushHistory(query);
        closeOmnisearch();
        void createContextualNote({
            title,
        });
    }, [query]);
    const insertLink = useCallback(() => {
        const result = results[cursor.index];
        if (!result) return;
        if (!insertAtActiveCursor(`[[${result.doc.displayTitle || result.doc.title}]]`)) {
            toast({
                title: t('command.no_editor_to_edit'),
                tone: 'warning',
            });
            return;
        }
        void pushHistory(query);
        closeOmnisearch();
    }, [cursor.index, query, results, toast]);
    const switchScope = useCallback(() => {
        if (scope === 'file') {
            setScope('vault');
            return;
        }
        const result = results[cursor.index];
        const target = result ? noteIdOfDoc(result.id) : '';
        if (result && !target) return;
        setScope('file');
    }, [cursor.index, results, scope]);
    const cycleHistory = useCallback((offset: number) => {
        const items = history.filter(Boolean);
        if (!items.length) return;
        historyIndex.current = (historyIndex.current + offset + items.length) % items.length;
        setQuery(items[historyIndex.current] ?? '');
    }, [history]);
    const toggleExcerpts = useCallback(() => {
        void updateSettings({
            search: {
                showExcerpt: !useSession.getState().settings.search.showExcerpt,
            },
        });
    }, [updateSettings]);
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.nativeEvent.isComposing) return;
        const mod = event.metaKey || event.ctrlKey;
        const vimNavigation = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
        if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            cycleHistory(event.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (event.key === 'ArrowDown' || (vimNavigation && (event.key === 'n' || event.key === 'j'))) {
            event.preventDefault();
            move(1);
            return;
        }
        if (event.key === 'ArrowUp' || (vimNavigation && (event.key === 'p' || event.key === 'k'))) {
            event.preventDefault();
            move(-1);
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            switchScope();
            return;
        }
        if (mod && !event.altKey && !event.shiftKey && (event.key === 'g' || event.key === 'G')) {
            event.preventDefault();
            toggleExcerpts();
            return;
        }
        if (mod && !event.altKey && !event.shiftKey && (event.key === 'o' || event.key === 'O')) {
            event.preventDefault();
            if (scope === 'file') openAtOffset(fileRows[cursor.index] ?? fileRows[0], true);
            else {
                const result = results[cursor.index];
                if (result) openResult(result, {
                    pane: true,
                    background: true,
                });
            }
            return;
        }
        if (event.key !== 'Enter') return;
        // The commit is the whole gesture; leaving the default would let a keystroke that opened a
        // notice answer it a moment later.
        event.preventDefault();
        if (event.altKey && scope === 'vault') {
            insertLink();
            return;
        }
        if (event.shiftKey) {
            create();
            return;
        }
        if (scope === 'file') {
            openAtOffset(fileRows[cursor.index], mod);
            return;
        }
        const result = results[cursor.index];
        if (result) openResult(result, {
            pane: mod,
        });
    };
    const statusLine = useMemo(() => {
        if (!search.enabled) return t('omnisearch.index_off');
        if (status.phase === 'failed' && status.error) return t('omnisearch.index_failed', {
            value0: status.error,
        });
        if (status.busy || status.phase === 'indexing' || status.phase === 'loading' || status.phase === 'writing') {
            return t('omnisearch.indexing', {
                value0: status.indexed,
                value1: status.available,
            });
        }
        if (status.deferred > 0) return t('omnisearch.index_deferred', {
            value0: status.deferred,
            value1: status.indexed,
        });
        if (status.cacheFailed) return t('omnisearch.cache_failed');
        return '';
    }, [search.enabled, status]);
    const empty = !searching && rows === 0;
    const placeholder = scope === 'file' ? t('omnisearch.placeholder_file') : t('omnisearch.placeholder_vault');
    const activeRowId = rows ? `${listId}-option-${Math.min(cursor.index, rows - 1)}` : undefined;
    return createPortal(<div className="app-viewport-fixed fixed z-[240] flex items-end justify-center md:items-start md:px-4 md:pt-[11vh]">
        <div className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={() => closeOmnisearch()} aria-hidden="true"/>

        <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={labelId} tabIndex={-1} className="anim-pop relative flex h-[min(84dvh,var(--app-viewport-height,100dvh))] w-full max-w-[720px] flex-col overflow-hidden rounded-t-[var(--r-2xl)] border border-b-0 border-[var(--border-default)] bg-[var(--bg-overlay)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-modal)] outline-none md:h-auto md:max-h-[78vh] md:rounded-[var(--r-2xl)] md:border-b md:pb-0" data-omnisearch-scope={scope}>
          <h2 id={labelId} className="sr-only">{placeholder}</h2>
          <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 md:px-4">
            <ScanSearch size={16} className="shrink-0 text-[var(--text-quaternary)]"/>
            <input ref={inputRef} role="combobox" aria-label={placeholder} aria-expanded="true" aria-controls={listId} aria-activedescendant={activeRowId} aria-autocomplete="list" autoComplete="off" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} className="h-9 min-w-0 flex-1 bg-transparent text-[14.5px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] focus:outline-none"/>
            {query && (<IconButton label={t('common.clear')} size="sm" onClick={() => {
                    setQuery('');
                    inputRef.current?.focus();
                }}>
                <X size={14}/>
              </IconButton>)}
            <span className="hidden shrink-0 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-tertiary)] md:inline-flex">
              {scope === 'file' ? t('omnisearch.scope_file') : t('omnisearch.scope_vault')}
            </span>
          </div>

          {statusLine && (<p role="status" className="border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] px-4 py-1.5 text-[11px] text-[var(--text-tertiary)]">
              {statusLine}
            </p>)}

          <div ref={listRef} id={listId} role="listbox" aria-label={placeholder} className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {scope === 'file' && fileNoteId && (<div className="px-2.5 py-1 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
                {notes[fileNoteId]?.title || t('common.untitled_note')}
              </div>)}
            {scope === 'file' ? fileRows.map((row, index) => (<FileRowView key={`${row.offset}-${index}`} row={row} index={index} active={index === cursor.index} listId={listId} terms={terms} ignoreDiacritics={search.ignoreDiacritics} onHover={(next) => setCursor({
                        index: next,
                        fromPointer: true,
                    })} onInvoke={(pane) => openAtOffset(row, pane)}/>)) : results.map((result, index) => (<ResultRow key={`${result.id}-${index}`} result={result} index={index} active={index === cursor.index} listId={listId} terms={terms} ignoreDiacritics={search.ignoreDiacritics} showExcerpt={search.showExcerpt} onHover={(next) => setCursor((current) => current.index === next && current.fromPointer ? current : {
                        index: next,
                        fromPointer: true,
                    })} onInvoke={(item, meta) => openResult(item, {
                        pane: meta.pane,
                    })} onHold={(item) => openResult(item, {
                        pane: true,
                    })}/>))}
            {empty && (<div className="px-3 py-10 text-center text-[12.5px] text-[var(--text-quaternary)]">
                {query.trim() ? t('omnisearch.no_results') : t('omnisearch.type_to_search')}
                {parsed?.trash && (<p className="mt-1 text-[11.5px]">{t('omnisearch.trash_hint')}</p>)}
              </div>)}
            {searching && rows > 0 && (<div className="px-3 py-2 text-center text-[11.5px] text-[var(--text-quaternary)]">{t('navigation.searching')}</div>)}
          </div>

          <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2 text-[10.5px] text-[var(--text-quaternary)]">
            {breakpoint === 'mobile' ? (<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <button type="button" onClick={switchScope} className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1">
                  {scope === 'file' ? t('omnisearch.scope_vault') : t('omnisearch.scope_file')}
                </button>
                <button type="button" onClick={create} disabled={!query.trim()} className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1 disabled:opacity-40">
                  {t('omnisearch.create_note')}
                </button>
                <button type="button" onClick={toggleExcerpts} className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1">
                  {t('omnisearch.toggle_excerpts')}
                </button>
              </div>) : (<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
                <Hint keys={['↑', '↓']} label={t('omnisearch.hint_navigate')}/>
                <Hint keys={['Alt', '↑', '↓']} label={t('omnisearch.hint_history')}/>
                <Hint keys={['↵']} label={t('common.open')}/>
                <Hint keys={['Tab']} label={t('omnisearch.hint_switch')}/>
                <Hint combo="mod+enter" label={t('omnisearch.hint_new_pane')}/>
                <Hint combo="mod+o" label={t('omnisearch.hint_background')}/>
                <Hint keys={['Shift', '↵']} label={t('omnisearch.hint_create')}/>
                {search.showCreateButton && scope === 'vault' && (<span className="min-w-0 truncate">
                    {t('omnisearch.create_note_named', {
                        value0: query.trim(),
                    })}
                  </span>)}
              </div>)}
            <span className="ml-auto hidden shrink-0 md:inline-flex"><Kbd keys={['Esc']}/></span>
          </div>
        </div>
      </div>, document.body);
}
function Hint({ keys, combo, label }: {
    keys?: string[];
    combo?: string;
    label: string;
}) {
    return (<span className="flex shrink-0 items-center gap-1.5">
        <Kbd keys={keys} combo={combo}/>
        <span>{label}</span>
      </span>);
}
function FileRowView({ row, index, active, listId, terms, ignoreDiacritics, onHover, onInvoke }: {
    row: FileRow;
    index: number;
    active: boolean;
    listId: string;
    terms: readonly string[];
    ignoreDiacritics: boolean;
    onHover: (index: number) => void;
    onInvoke: (pane?: boolean) => void;
}) {
    return (<button id={`${listId}-option-${index}`} type="button" role="option" aria-selected={active} tabIndex={-1} data-index={index} onMouseEnter={() => onHover(index)} onClick={(event) => onInvoke(event.metaKey || event.ctrlKey)} className={active ? ROW_ACTIVE_CLASS : ROW_CLASS}>
        <span className="min-w-0 flex-1">
          <span className="block text-[10.5px] tabular text-[var(--text-quaternary)]">
            {t('omnisearch.at_offset', {
                value0: row.offset,
            })}
          </span>
          <ExcerptBody excerpt={row.excerpt} terms={terms} ignoreDiacritics={ignoreDiacritics}/>
        </span>
      </button>);
}
async function buildFileRows(query: ParsedOmnisearchQuery, noteId: string, ignoreDiacritics: boolean): Promise<FileRow[]> {
    const body = await omnisearchIndexer.resolveBody(docIdForNote(noteId));
    const terms = [...query.terms, ...query.exact];
    if (!body || !terms.length) return [];
    const matches = findMatches(body, terms, {
        ignoreDiacritics,
    });
    return groupOffsets(matches).slice(0, 80).map((offset) => {
        const term = matches.find((match) => match.offset === offset)?.term ?? terms[0]!;
        return {
            offset,
            length: term.length,
            // No before/after override: groupOffsets() swallows every match inside the default window,
            // so the row has to render that same window or a swallowed match becomes unreachable.
            excerpt: buildExcerpt(body, offset, {
                ignoreDiacritics,
                keepLineReturns: true,
                plainText: false,
                terms,
            }),
        };
    });
}
