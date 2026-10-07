import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type DragEvent as ReactDragEvent, type RefObject } from 'react';
import {
    ListTree,
    Heading1,
    Heading2,
    Heading3,
    Heading4,
    Heading5,
    Heading6,
    ChevronRight,
    Copy,
    Pencil,
    Trash2,
    ChevronsUpDown,
    Search,
    X,
    Asterisk,
    type LucideProps,
} from 'lucide-react';
import type { Heading } from '../../lib/markdown/renderer';
import { renderMarkdown, renderOutlineLabel } from '../../lib/markdown/renderer';
import { createPortal } from 'react-dom';
import { popoverPosition, type AnchorRect } from './outline-float';
import { cn } from '../../lib/cn';
import { Menu, Tooltip, confirm, useContextMenu, type MenuItem } from '../../components/overlay';
import {
    changeHeadingLevel,
    changeSectionLevels,
    deleteSection,
    descendantIndices,
    renameHeading,
    sectionRange,
    siblingIndices,
    moveSection,
    dropPositionFor,
    type DropPosition,
} from './outline-sections';
import { t } from '../../lib/i18n';
import {
    activeHeadingIndex,
    ancestorIndices,
    buildOutlineTree,
    clamp,
    collapsedToLevel,
    computeHiddenByCollapse,
    filterTree,
    parentSlugs,
    pruneCollapsed,
    rawHeadingLabel,
    readingProgress,
    truncateHeading,
    type OutlineNode,
} from './outline-tree';
import { publishOutlineHeadings } from './outline-registry';
import { DEFAULT_READING_SPEED_WPM, readingMinutes } from '@shared/markdown-utils';
import { useUi } from '../../store/ui';

const ACTIVE_BAR_W = 'w-[var(--sp-0-625)]';

const OUTLINE_INDENT_BASE = 8;
const OUTLINE_INDENT_STEP = 10;
const CHEVRON_SLOT = 14;
const ACTIVE_SCAN_OFFSET = 60;
const MAX_LEVEL_BUTTONS = 6;
const PEEK_CHAR_LIMIT = 4000;
const PEEK_BOX = { width: 300, height: 240 };

const HEADING_ICONS: Record<number, ComponentType<LucideProps>> = {
    1: Heading1,
    2: Heading2,
    3: Heading3,
    4: Heading4,
    5: Heading5,
    6: Heading6,
};

export function getHeadingIcon(level: number): ComponentType<LucideProps> {
    return HEADING_ICONS[level] ?? Heading6;
}

export function getHeadingTypography(level: number, isActive: boolean) {
    switch (level) {
        case 1:
            return {
                fontSize: 'text-[length:var(--text-13)]',
                fontWeight: 'font-semibold',
                textColor: isActive ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]',
                iconSize: 12.5,
                iconColor: isActive ? 'text-[var(--accent)] opacity-100' : 'text-[var(--text-tertiary)] opacity-80',
                paddingY: 'py-1',
            };
        case 2:
            return {
                fontSize: 'text-[length:var(--text-12)]',
                fontWeight: isActive ? 'font-semibold' : 'font-medium',
                textColor: isActive ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]/85',
                iconSize: 11.5,
                iconColor: isActive ? 'text-[var(--accent)] opacity-100' : 'text-[var(--text-quaternary)] opacity-80',
                paddingY: 'py-1',
            };
        case 3:
            return {
                fontSize: 'text-[length:var(--text-11-5)]',
                fontWeight: isActive ? 'font-medium' : 'font-normal',
                textColor: isActive ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]',
                iconSize: 11,
                iconColor: isActive ? 'text-[var(--accent)] opacity-100' : 'text-[var(--text-quaternary)] opacity-70',
                paddingY: 'py-0.5',
            };
        case 4:
            return {
                fontSize: 'text-[length:var(--text-11)]',
                fontWeight: isActive ? 'font-medium' : 'font-normal',
                textColor: isActive ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]',
                iconSize: 10.5,
                iconColor: isActive ? 'text-[var(--accent)] opacity-100' : 'text-[var(--text-quaternary)] opacity-60',
                paddingY: 'py-0.5',
            };
        default:
            return {
                fontSize: 'text-[length:var(--text-10-5)]',
                fontWeight: isActive ? 'font-medium' : 'font-normal',
                textColor: isActive ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]',
                iconSize: 10,
                iconColor: isActive ? 'text-[var(--accent)] opacity-100' : 'text-[var(--text-quaternary)] opacity-60',
                paddingY: 'py-0.5',
            };
    }
}

function isSameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    if (left.size !== right.size) return false;
    for (const value of left)
        if (!right.has(value)) return false;
    return true;
}

interface OutlineTracking {
    active: string | null;
    progress: number;
}

function useOutlineTracking(headings: Heading[], scrollerRef?: RefObject<HTMLElement | null>): OutlineTracking {
    const [state, setState] = useState<OutlineTracking>({ active: null, progress: 0 });
    const rafRef = useRef(0);
    useEffect(() => {
        const scroller = scrollerRef?.current ?? document.querySelector<HTMLElement>('[data-preview-scroller]');
        if (!scroller || headings.length === 0)
            return;
        let measured: { headings: Heading[]; slugs: string[]; tops: number[]; height: number } | null = null;
        const measure = () => {
            const slugs: string[] = [];
            const tops: number[] = [];
            for (const heading of headings) {
                const el = scroller.querySelector<HTMLElement>(`#${CSS.escape(heading.slug)}`);
                if (!el)
                    continue;
                slugs.push(heading.slug);
                tops.push(el.offsetTop);
            }
            measured = { headings, slugs, tops, height: scroller.scrollHeight };
            return measured;
        };
        const onScroll = () => {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(() => {
                if (!measured || measured.headings !== headings || measured.height !== scroller.scrollHeight)
                    measure();
                const { slugs, tops } = measured!;
                const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
                const found = activeHeadingIndex(tops, scroller.scrollTop + ACTIVE_SCAN_OFFSET, atBottom);
                const nextActive = found >= 0 ? slugs[found] ?? null : headings[0]?.slug ?? null;
                // A scroll tick lands here every frame; quantising the ring to whole percent and
                // bailing when neither field moved keeps a long outline from re-rendering per frame.
                const nextProgress = Math.round(readingProgress(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight) * 100) / 100;
                setState((current) => current.active === nextActive && current.progress === nextProgress
                    ? current
                    : { active: nextActive, progress: nextProgress });
            });
        };
        onScroll();
        scroller.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            scroller.removeEventListener('scroll', onScroll);
            cancelAnimationFrame(rafRef.current);
        };
    }, [headings, scrollerRef]);
    return state;
}

/**
 * Expansion survives typing: the set is keyed by heading slug and only shed when those headings
 * stop being parents, so adding a heading elsewhere never reflows what the reader folded away.
 */
function useOutlineCollapse(tree: OutlineNode[], noteId: string | undefined, defaultLevel: number) {
    const [collapsed, setCollapsed] = useState<Set<string>>(() => collapsedToLevel(tree, defaultLevel));
    const treeRef = useRef(tree);
    treeRef.current = tree;
    const appliedRef = useRef(`${noteId ?? ''}|${defaultLevel}`);
    useLayoutEffect(() => {
        const key = `${noteId ?? ''}|${defaultLevel}`;
        if (appliedRef.current === key)
            return;
        appliedRef.current = key;
        setCollapsed(collapsedToLevel(treeRef.current, defaultLevel));
    }, [noteId, defaultLevel]);
    useLayoutEffect(() => {
        setCollapsed((current) => pruneCollapsed(tree, current));
    }, [tree]);
    const toggle = useCallback((slug: string) => {
        setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(slug))
                next.delete(slug);
            else
                next.add(slug);
            return next;
        });
    }, []);
    return { collapsed, setCollapsed, toggle };
}

export function Outline({ headings, onSelect, scrollerRef, className, noteId, defaultLevel = 6, showProgress = true, activeOverride, keepSearch = false, content, onContentChange, dragEdits = false, autoExpand = 'off', tooltipSide = 'left', truncateLength = 0, markdownLabels = false, showReadingTime = false, readingSpeed = DEFAULT_READING_SPEED_WPM, wordCount = 0, hoverPeek = false, }: {
    headings: Heading[];
    onSelect: (heading: Heading) => void;
    scrollerRef?: RefObject<HTMLElement | null>;
    className?: string;
    noteId?: string;
    defaultLevel?: number;
    showProgress?: boolean;
    /** Slug chosen from the editor cursor; wins over the preview-scroll reading. */
    activeOverride?: string | null;
    keepSearch?: boolean;
    /** Raw note body; the row menu edits it through the pure section helpers. */
    content?: string;
    onContentChange?: (next: string) => void;
    /** Off by default: dragging rewrites the note body. */
    dragEdits?: boolean;
    autoExpand?: 'off' | 'ancestors';
    tooltipSide?: 'left' | 'right';
    truncateLength?: number;
    /** Renders each heading's own inline markdown, read back from its source line. */
    markdownLabels?: boolean;
    showReadingTime?: boolean;
    readingSpeed?: number;
    /** The note's stored word count, so the estimate costs nothing per keystroke. */
    wordCount?: number;
    /** Hold Ctrl (or Option/Command) over a row to preview the section under it. */
    hoverPeek?: boolean;
}) {
    const tracked = useOutlineTracking(headings, scrollerRef);
    const active = activeOverride ?? tracked.active;
    const { progress } = tracked;
    const tree = useMemo(() => buildOutlineTree(headings), [headings]);
    const { collapsed, setCollapsed, toggle } = useOutlineCollapse(tree, noteId, defaultLevel);
    const [query, setQuery] = useState('');
    const [useRegex, setUseRegex] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [level, setLevel] = useState(defaultLevel);
    const listRef = useRef<HTMLUListElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const command = useUi((state) => state.outlineCommand);
    // Seeded with the command already in the store so remounting never replays a stale request.
    const appliedCommandRef = useRef<number>(command?.seq ?? 0);
    const pendingSearchFocusRef = useRef(false);

    const maxLevel = Math.min(tree.reduce((deepest, node) => Math.max(deepest, node.heading.level), 1), MAX_LEVEL_BUTTONS);

    useEffect(() => {
        publishOutlineHeadings(noteId, headings);
        return () => { publishOutlineHeadings(undefined, []); };
    }, [noteId, headings]);

    const lastQueryNoteRef = useRef(noteId);
    useEffect(() => {
        if (keepSearch || lastQueryNoteRef.current === noteId)
            return;
        lastQueryNoteRef.current = noteId;
        setQuery('');
    }, [noteId, keepSearch]);

    useEffect(() => {
        if (!command || appliedCommandRef.current === command.seq)
            return;
        appliedCommandRef.current = command.seq;
        if (command.action === 'focus-search')
            pendingSearchFocusRef.current = true;
        switch (command.action) {
            case 'focus-search':
                setSearchOpen(true);
                break;
            case 'expand-all':
                setLevel(maxLevel);
                setCollapsed(new Set());
                break;
            case 'collapse-all':
                setLevel(1);
                setCollapsed(collapsedToLevel(tree, 1));
                break;
            case 'reset-level':
                setLevel(defaultLevel);
                setCollapsed(collapsedToLevel(tree, defaultLevel));
                break;
            case 'level-up':
            case 'level-down': {
                // A shallower document would otherwise need dead presses before anything moves.
                const effective = Math.min(level, maxLevel);
                const next = clamp(effective + (command.action === 'level-up' ? 1 : -1), 1, maxLevel);
                setLevel(next);
                setCollapsed(collapsedToLevel(tree, next));
                break;
            }
        }
    }, [command, tree, level, maxLevel, defaultLevel, setCollapsed]);

    useEffect(() => {
        if (!searchOpen || !pendingSearchFocusRef.current)
            return;
        pendingSearchFocusRef.current = false;
        searchRef.current?.focus();
    }, [searchOpen]);

    const hidden = useMemo(() => computeHiddenByCollapse(tree, collapsed), [tree, collapsed]);
    const searching = query.trim().length > 0;
    const filter = useMemo(() => filterTree(tree, query, useRegex), [tree, query, useRegex]);
    const drawn = tree.filter((_, index) => filter.visible[index] !== false && (searching || hidden[index] !== true));

    const locatedSlug = useMemo(() => {
        if (!active) return null;
        const index = tree.findIndex((node) => node.heading.slug === active);
        if (index < 0 || hidden[index] !== true) return active;
        let parent = tree[index]!.parentIndex;
        while (parent >= 0 && hidden[parent] === true) parent = tree[parent]!.parentIndex;
        return parent >= 0 ? tree[parent]!.heading.slug : active;
    }, [active, tree, hidden]);

    // Reveals only the branch being read; sibling branches keep whatever state the reader left them in.
    useEffect(() => {
        if (autoExpand !== 'ancestors' || !active || searching)
            return;
        const index = tree.findIndex((node) => node.heading.slug === active);
        if (index < 0)
            return;
        const ancestors = ancestorIndices(tree, index).filter((parent) => collapsed.has(tree[parent]!.heading.slug));
        if (ancestors.length === 0)
            return;
        setCollapsed((current) => {
            const next = new Set(current);
            for (const parent of ancestors) next.delete(tree[parent]!.heading.slug);
            return next;
        });
    }, [autoExpand, active, tree, searching, collapsed, setCollapsed]);

    useEffect(() => {
        if (!locatedSlug || searching) return;
        listRef.current?.querySelector<HTMLElement>(`[data-slug="${CSS.escape(locatedSlug)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [locatedSlug, searching]);

    const lines = useMemo(() => (content === undefined ? [] : content.split('\n')), [content]);
    const editable = content !== undefined && Boolean(onContentChange) && lines.length > 0;
    const [hoverRow, setHoverRow] = useState<{ index: number; rect: AnchorRect } | null>(null);
    const [modifierDown, setModifierDown] = useState(false);
    useEffect(() => {
        if (!hoverPeek)
            return;
        // The reference arms the peek with a held modifier, so the row's own tooltip is untouched.
        const isPeekKey = (event: KeyboardEvent) => event.key === 'Control' || event.key === 'Meta' || event.key === 'Alt';
        const down = (event: KeyboardEvent) => {
            if (isPeekKey(event)) setModifierDown(true);
        };
        const up = (event: KeyboardEvent) => {
            if (isPeekKey(event)) setModifierDown(false);
        };
        const clear = () => setModifierDown(false);
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        window.addEventListener('blur', clear);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
            window.removeEventListener('blur', clear);
        };
    }, [hoverPeek]);
    useEffect(() => {
        if (!hoverPeek)
            return;
        const drop = () => setHoverRow(null);
        const scroller = scrollerRef?.current ?? document.querySelector<HTMLElement>('[data-preview-scroller]');
        scroller?.addEventListener('scroll', drop, { passive: true });
        listRef.current?.addEventListener('scroll', drop);
        return () => {
            scroller?.removeEventListener('scroll', drop);
            listRef.current?.removeEventListener('scroll', drop);
        };
    }, [hoverPeek, scrollerRef]);
    const peekIndex = hoverPeek && modifierDown ? hoverRow?.index ?? null : null;
    const peek = useMemo(() => {
        if (peekIndex === null || hoverRow === null || content === undefined)
            return null;
        const range = sectionRange(headings, peekIndex, lines.length);
        const body = lines.slice(range.start + 1, range.end).join('\n').trim();
        if (!body)
            return null;
        const clipped = body.length > PEEK_CHAR_LIMIT ? `${body.slice(0, PEEK_CHAR_LIMIT)}\n\n…` : body;
        return { title: headings[peekIndex]?.text ?? '', html: renderMarkdown(clipped).html };
    }, [peekIndex, hoverRow, content, headings, lines]);

    const peekAt = peek && hoverRow
        ? popoverPosition(hoverRow.rect, PEEK_BOX, { width: window.innerWidth, height: window.innerHeight }, tooltipSide)
        : null;

    const levelPresets = useMemo(() => {
        const presets = new Map<number, Set<string>>();
        for (let depth = 1; depth <= maxLevel; depth++) presets.set(depth, collapsedToLevel(tree, depth));
        return presets;
    }, [tree, maxLevel]);
    const parents = useMemo(() => parentSlugs(tree), [tree]);
    const allCollapsed = parents.length > 0 && parents.every((slug) => collapsed.has(slug));

    const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
    const toast = useUi((state) => state.toast);
    const applyLines = (next: string[]) => {
        onContentChange?.(next.join('\n'));
    };
    const copyText = (text: string) => {
        if (!text) return;
        void navigator.clipboard.writeText(text);
        toast({ title: t('outline.copied'), tone: 'success' });
    };
    const headingLines = (indices: number[]) => indices.map((i) => lines[headings[i]!.line] ?? '').join('\n');
    const buildMenu = (node: OutlineNode): MenuItem[] => {
        const index = node.index;
        const range = sectionRange(headings, index, lines.length);
        const descendants = descendantIndices(headings, index);
        const items: MenuItem[] = [];
        if (searching) return items;
        if (editable) items.push({ id: 'rename', label: t('outline.rename'), icon: <Pencil size={13}/>, onSelect: () => setRenamingIndex(index) });
        items.push({ id: 'copy', label: t('outline.copy_heading'), icon: <Copy size={13}/>, onSelect: () => copyText(node.heading.text) });
        items.push({ id: 'copy-line', label: t('outline.copy_heading_line'), icon: <Copy size={13}/>, onSelect: () => copyText(lines[range.start] ?? '') });
        if (node.hasChildren) {
            items.push({ id: 'copy-children', label: t('outline.copy_with_children'), icon: <Copy size={13}/>, onSelect: () => copyText(headingLines([index, ...descendants])) });
            items.push({ id: 'copy-content', label: t('outline.copy_with_content'), icon: <Copy size={13}/>, onSelect: () => copyText(lines.slice(range.start, range.end).join('\n')) });
        }
        items.push({ id: 'copy-siblings', label: t('outline.copy_with_siblings'), icon: <Copy size={13}/>, onSelect: () => copyText(headingLines(siblingIndices(headings, index))) });
        if (editable) {
            items.push({ id: 'sep-level', label: '', separatorBefore: true });
            items.push({ id: 'level-promote', label: t('outline.promote_level'), icon: <ChevronsUpDown size={13}/>, onSelect: () => applyLines(changeHeadingLevel(lines, node.heading, node.heading.level - 1)) });
            items.push({ id: 'level-demote', label: t('outline.demote_level'), icon: <ChevronsUpDown size={13}/>, onSelect: () => applyLines(changeHeadingLevel(lines, node.heading, node.heading.level + 1)) });
            if (node.hasChildren) {
                items.push({ id: 'level-promote-rec', label: t('outline.promote_level_recursively'), icon: <ChevronsUpDown size={13}/>, onSelect: () => applyLines(changeSectionLevels(lines, headings, index, -1)) });
                items.push({ id: 'level-demote-rec', label: t('outline.demote_level_recursively'), icon: <ChevronsUpDown size={13}/>, onSelect: () => applyLines(changeSectionLevels(lines, headings, index, 1)) });
            }
            items.push({ id: 'delete', label: t('outline.delete_section'), icon: <Trash2 size={13}/>, separatorBefore: true, onSelect: () => void deleteSectionWithConfirm(index) });
        }
        return items;
    };
    const deleteSectionWithConfirm = async (index: number) => {
        const nested = descendantIndices(headings, index).length;
        const ok = await confirm({
            title: t('outline.delete_heading', { title: headings[index]!.text || t('preview.untitled') }),
            description: nested ? t('outline.delete_nested', { count: nested }) : t('outline.delete_no_nested'),
            confirmLabel: t('common.delete'),
            tone: 'danger',
        });
        if (ok) applyLines(deleteSection(lines, headings, index));
    };
    const commitRename = (index: number, title: string) => {
        const heading = headings[index]!;
        setRenamingIndex(null);
        const trimmed = title.trim();
        if (!trimmed || trimmed === heading.text) return;
        applyLines(renameHeading(lines, heading, trimmed));
    };

    const [dragFrom, setDragFrom] = useState<number | null>(null);
    const [dropAt, setDropAt] = useState<{ index: number; position: DropPosition } | null>(null);
    const canDrag = dragEdits && editable;
    const finishDrop = (to: number, position: DropPosition) => {
        const from = dragFrom;
        setDragFrom(null);
        setDropAt(null);
        if (from === null || from === to) return;
        const next = moveSection(lines, headings, from, to, position);
        if (next === null) {
            toast({ title: t('outline.cannot_move_inside'), tone: 'warning' });
            return;
        }
        applyLines(next);
    };

    if (headings.length === 0)
        return null;

    return (<>
      <nav className={cn('sticky top-0 flex max-h-full w-[168px] shrink-0 flex-col self-start overflow-hidden py-5 pr-3', className)} aria-label={t('common.outline')}>
      <div className="mb-1 flex shrink-0 items-center gap-1.5 px-2">
        <ListTree size={11} className="shrink-0 text-[var(--text-quaternary)]"/>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t('common.outline')}</span>
        {showProgress && <ProgressRing value={progress}/>}
        <button type="button" aria-expanded={searchOpen} aria-label={t('outline.toggle_search')} onClick={() => { setSearchOpen((open) => !open); setQuery(''); }} className={cn('shrink-0 rounded-[var(--r-sm)] p-0.5 text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]', searchOpen && 'bg-[var(--bg-hover)] text-[var(--text-primary)]')}>
          <Search size={11}/>
        </button>
      </div>

      {searchOpen && (<div className="mb-1 flex shrink-0 items-center gap-1 px-2">
          <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(''); setSearchOpen(false); } }} placeholder={t('outline.filter_placeholder')} aria-label={t('outline.filter_placeholder')} className="h-5 min-w-0 flex-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1 text-[length:var(--text-10-5)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"/>
          <button type="button" role="switch" aria-checked={useRegex} aria-label={t('outline.regex')} title={t('outline.regex')} onClick={() => setUseRegex((current) => !current)} className={cn('shrink-0 rounded-[var(--r-sm)] p-0.5 transition-colors hover:bg-[var(--bg-hover)]', useRegex ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>
            <Asterisk size={11}/>
          </button>
        </div>)}

      {searching ? (<div className="mb-1 flex shrink-0 items-center gap-1 px-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          <span className="tabular flex-1">{t('outline.match_count', { count: filter.matchCount })}</span>
          <button type="button" onClick={() => setQuery('')} aria-label={t('outline.clear_filter')} className="rounded-[var(--r-sm)] p-0.5 hover:bg-[var(--bg-hover)]"><X size={10}/></button>
        </div>) : (<div className="mb-1 flex shrink-0 flex-wrap items-center gap-0.5 px-2">
          {Array.from({ length: maxLevel }, (_, offset) => offset + 1).map((depth) => {
            const preset = levelPresets.get(depth)!;
            return (<button key={depth} type="button" title={t('outline.expand_to_level', { level: depth })} aria-label={t('outline.expand_to_level', { level: depth })} aria-pressed={isSameSet(collapsed, preset)} onClick={() => { setLevel(depth); setCollapsed(preset); }} className={cn('h-4 min-w-4 rounded-[var(--r-sm)] px-0.5 text-[length:var(--text-10-5)] tabular transition-colors hover:bg-[var(--bg-hover)]', isSameSet(collapsed, preset) ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>{depth}</button>);
          })}
          <button type="button" title={allCollapsed ? t('outline.expand_all') : t('outline.collapse_all')} aria-label={allCollapsed ? t('outline.expand_all') : t('outline.collapse_all')} onClick={() => { setLevel(allCollapsed ? maxLevel : 1); setCollapsed(allCollapsed ? new Set() : new Set(parents)); }} className="ml-auto shrink-0 rounded-[var(--r-sm)] p-0.5 text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ChevronRight size={11} className={cn('transition-transform duration-[var(--dur-fast)]', allCollapsed ? 'rotate-90' : '-rotate-90')}/>
          </button>
        </div>)}

      <ul ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto">
        {drawn.map((node) => (<OutlineRow key={`${node.heading.slug}-${node.index}`} node={node} isLocated={node.heading.slug === locatedSlug} isCollapsed={collapsed.has(node.heading.slug)} onToggle={toggle} onSelect={onSelect} tooltipSide={tooltipSide} truncateLength={truncateLength} markdownLabels={markdownLabels} sourceLine={lines[node.heading.line]} hoverPeek={hoverPeek} onHoverRow={(index, rect) => setHoverRow({ index, rect })} onLeaveRow={() => setHoverRow(null)} buildMenu={buildMenu} menuEnabled={!searching} canRename={editable} renaming={renamingIndex === node.index} onStartRename={() => setRenamingIndex(node.index)} onCommitRename={commitRename} onCancelRename={() => setRenamingIndex(null)} canDrag={canDrag} dragging={dragFrom === node.index} dropHint={dropAt?.index === node.index ? dropAt.position : null} onDragStartRow={() => setDragFrom(node.index)} onDragEndRow={() => { setDragFrom(null); setDropAt(null); }} onDragOverRow={(index, position) => setDropAt((current) => current?.index === index && current.position === position ? current : { index, position })} onDropRow={finishDrop}/>))}
        {drawn.length === 0 && <li className="px-2 py-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('outline.no_matches')}</li>}
      </ul>

      {showReadingTime && (<div className="mt-1 shrink-0 px-2 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
          {t('outline.reading_time', { minutes: readingMinutes(wordCount, readingSpeed) })}
        </div>)}
      </nav>
      {peek && peekAt && createPortal((<aside data-outline-peek role="note" aria-label={t('outline.peek_label', { title: peek.title })} className="ink-prose fixed z-[520] overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] text-[length:var(--text-11)] shadow-[var(--shadow-pop)]" style={{ left: peekAt.left, top: peekAt.top, width: PEEK_BOX.width, maxHeight: PEEK_BOX.height, padding: 8, margin: 0 }} dangerouslySetInnerHTML={{ __html: peek.html }}/>), document.body)}
    </>);
}

function OutlineRow({ node, isLocated, isCollapsed, onToggle, onSelect, tooltipSide, truncateLength, markdownLabels, sourceLine, hoverPeek, onHoverRow, onLeaveRow, buildMenu, menuEnabled, canRename, renaming, onStartRename, onCommitRename, onCancelRename, canDrag, dragging, dropHint, onDragStartRow, onDragEndRow, onDragOverRow, onDropRow }: {
    node: OutlineNode;
    isLocated: boolean;
    isCollapsed: boolean;
    onToggle: (slug: string) => void;
    onSelect: (heading: Heading) => void;
    tooltipSide: 'left' | 'right';
    truncateLength: number;
    markdownLabels: boolean;
    hoverPeek: boolean;
    onHoverRow: (index: number, rect: AnchorRect) => void;
    onLeaveRow: () => void;
    /** The heading's own source line, so the label can be re-rendered as markdown. */
    sourceLine?: string;
    buildMenu: (node: OutlineNode) => MenuItem[];
    menuEnabled: boolean;
    canRename: boolean;
    canDrag: boolean;
    dragging: boolean;
    dropHint: DropPosition | null;
    onDragStartRow: () => void;
    onDragEndRow: () => void;
    onDragOverRow: (index: number, position: DropPosition) => void;
    onDropRow: (index: number, position: DropPosition) => void;
    renaming: boolean;
    onStartRename: () => void;
    onCommitRename: (index: number, title: string) => void;
    onCancelRename: () => void;
}) {
    const { heading, tier, hasChildren } = node;
    const typography = getHeadingTypography(heading.level, isLocated);
    const HeadingIcon = getHeadingIcon(heading.level);
    const label = heading.text || t('preview.untitled');
    const shown = truncateHeading(label, truncateLength);
    const markup = useMemo(() => {
        if (!markdownLabels) return '';
        const raw = rawHeadingLabel(sourceLine);
        if (raw === null) return '';
        // Truncation cuts the markdown source before it is rendered, never the markup after.
        const rendered = renderOutlineLabel(truncateHeading(raw, truncateLength));
        // A math or embed-only heading sanitises down to bare tags; the plain label is the better row.
        return rendered.replace(/<[^>]*>/g, '').trim() ? rendered : '';
    }, [markdownLabels, sourceLine, truncateLength]);
    const menu = useContextMenu();
    // Guards the blur that follows an Enter commit, which would otherwise rename twice.
    const committedRef = useRef(false);
    const items = menu.point ? buildMenu(node) : [];
    const beginDrag = (event: ReactDragEvent<HTMLLIElement>) => {
        if (!canDrag) return;
        event.dataTransfer?.setData('text/plain', heading.text);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        onDragStartRow();
    };
    return (<li className={cn('relative', outlineMarginTop(node), dragging && 'opacity-45')} data-heading-level={heading.level} draggable={canDrag} onDragStart={beginDrag} onDragEnd={onDragEndRow} onDragOver={(event) => {
            if (!canDrag) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            const rect = event.currentTarget.getBoundingClientRect();
            onDragOverRow(node.index, dropPositionFor(event.clientY, rect.top, rect.height));
        }} onDrop={(event) => {
            if (!canDrag) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onDropRow(node.index, dropPositionFor(event.clientY, rect.top, rect.height));
        }} onContextMenu={(event) => {
            if (!menuEnabled) return;
            menu.onContextMenu(event);
        }}>
      {dropHint && (<span aria-hidden="true" data-drop-hint={dropHint} className={cn('pointer-events-none absolute left-0 right-0 z-10 bg-[var(--accent)]', dropHint === 'inside' ? 'inset-y-0 rounded-[var(--r-sm)] opacity-20' : dropHint === 'before' ? 'top-0 h-0.5' : 'bottom-0 h-0.5')}/>)}
      <div className="flex items-center" style={{ paddingLeft: OUTLINE_INDENT_BASE + tier * OUTLINE_INDENT_STEP }}>
        {hasChildren ? (<button type="button" aria-expanded={!isCollapsed} aria-label={isCollapsed ? t('outline.expand_heading', { title: label }) : t('outline.collapse_heading', { title: label })} onClick={() => onToggle(heading.slug)} className="flex h-5 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" style={{ width: CHEVRON_SLOT }}>
              <ChevronRight size={10} className={cn('transition-transform duration-[var(--dur-fast)]', !isCollapsed && 'rotate-90')}/>
            </button>) : (<span aria-hidden="true" className="shrink-0" style={{ width: CHEVRON_SLOT }}/>) }
        {renaming ? (<input aria-label={t('outline.rename')} autoFocus defaultValue={heading.text} onFocus={() => {
                committedRef.current = false;
            }} onBlur={(event) => {
                if (committedRef.current) return;
                committedRef.current = true;
                onCommitRename(node.index, event.currentTarget.value);
            }} onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    committedRef.current = true;
                    onCommitRename(node.index, event.currentTarget.value);
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    committedRef.current = true;
                    onCancelRename();
                }
            }} onDoubleClick={(event) => event.stopPropagation()} className="h-5 min-w-0 flex-1 rounded-[var(--r-sm)] border border-[var(--accent)] bg-[var(--bg-surface)] px-1 text-[length:var(--text-11-5)] text-[var(--text-primary)] outline-none"/>) : (<Tooltip label={label} side={tooltipSide}>            <button type="button" data-slug={heading.slug} aria-current={isLocated ? 'location' : undefined} onClick={() => onSelect(heading)} onDoubleClick={canRename ? onStartRename : undefined} onMouseEnter={hoverPeek ? (event) => { const rect = event.currentTarget.getBoundingClientRect(); onHoverRow(node.index, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }); } : undefined} onMouseLeave={hoverPeek ? onLeaveRow : undefined} className={cn('group relative flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-sm)] pr-1.5 text-left leading-snug', 'transition-colors duration-[var(--dur-fast)]', typography.fontSize, typography.fontWeight, typography.textColor, typography.paddingY, isLocated
                    ? 'bg-[var(--accent-soft)]'
                    : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
              {isLocated && <span aria-hidden="true" className={cn('absolute top-1/2 left-0.5 h-3.5', ACTIVE_BAR_W, '-translate-y-1/2 rounded-full bg-[var(--accent)]')}/>}
              <HeadingIcon size={typography.iconSize} aria-hidden="true" className={cn('shrink-0 transition-opacity duration-[var(--dur-fast)]', typography.iconColor, !isLocated && 'group-hover:text-[var(--text-secondary)] group-hover:opacity-100')}/>
              {markup ? (<span className="min-w-0 flex-1 truncate" data-outline-markup="true" dangerouslySetInnerHTML={{ __html: markup }}/>) : (<span className="min-w-0 flex-1 truncate">{shown}</span>)}
            </button>
          </Tooltip>)}
      </div>
      {menu.point && <Menu anchor={menu.point} open onClose={menu.close} items={items}/>}
    </li>);
}

function ProgressRing({ value }: { value: number }) {
    const radius = 5;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.min(Math.max(value, 0), 1);
    return (<span className="shrink-0" role="img" aria-label={t('outline.reading_progress', { percent: Math.round(clamped * 100) })}>
        <svg width={13} height={13} viewBox="0 0 13 13" aria-hidden="true" className="-rotate-90">
          <circle cx={6.5} cy={6.5} r={radius} fill="none" stroke="var(--border-strong)" strokeWidth={1.5}/>
          <circle cx={6.5} cy={6.5} r={radius} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - clamped)}/>
        </svg>
      </span>);
}

function outlineMarginTop(node: OutlineNode): string {
    if (node.index === 0) return '';
    return node.heading.level === 1 ? 'mt-1.5' : '';
}
