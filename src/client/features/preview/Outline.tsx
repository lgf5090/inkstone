import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type RefObject } from 'react';
import {
    ListTree,
    Heading1,
    Heading2,
    Heading3,
    Heading4,
    Heading5,
    Heading6,
    ChevronRight,
    Search,
    X,
    Asterisk,
    type LucideProps,
} from 'lucide-react';
import type { Heading } from '../../lib/markdown/renderer';
import { cn } from '../../lib/cn';
import { Tooltip } from '../../components/overlay';
import { t } from '../../lib/i18n';
import {
    activeHeadingIndex,
    buildOutlineTree,
    collapsedToLevel,
    computeHiddenByCollapse,
    filterTree,
    parentSlugs,
    pruneCollapsed,
    readingProgress,
    type OutlineNode,
} from './outline-tree';

const ACTIVE_BAR_W = 'w-[var(--sp-0-625)]';

const OUTLINE_INDENT_BASE = 8;
const OUTLINE_INDENT_STEP = 10;
const CHEVRON_SLOT = 14;
const ACTIVE_SCAN_OFFSET = 60;
const MAX_LEVEL_BUTTONS = 6;

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

export function Outline({ headings, onSelect, scrollerRef, className, noteId, defaultLevel = 6, showProgress = true, }: {
    headings: Heading[];
    onSelect: (heading: Heading) => void;
    scrollerRef?: RefObject<HTMLElement | null>;
    className?: string;
    noteId?: string;
    defaultLevel?: number;
    showProgress?: boolean;
}) {
    const { active, progress } = useOutlineTracking(headings, scrollerRef);
    const tree = useMemo(() => buildOutlineTree(headings), [headings]);
    const { collapsed, setCollapsed, toggle } = useOutlineCollapse(tree, noteId, defaultLevel);
    const [query, setQuery] = useState('');
    const [useRegex, setUseRegex] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const listRef = useRef<HTMLUListElement>(null);

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

    useEffect(() => {
        if (!locatedSlug || searching) return;
        listRef.current?.querySelector<HTMLElement>(`[data-slug="${CSS.escape(locatedSlug)}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [locatedSlug, searching]);

    const maxLevel = Math.min(tree.reduce((deepest, node) => Math.max(deepest, node.heading.level), 1), MAX_LEVEL_BUTTONS);
    const levelPresets = useMemo(() => {
        const presets = new Map<number, Set<string>>();
        for (let level = 1; level <= maxLevel; level++) presets.set(level, collapsedToLevel(tree, level));
        return presets;
    }, [tree, maxLevel]);
    const parents = useMemo(() => parentSlugs(tree), [tree]);
    const allCollapsed = parents.length > 0 && parents.every((slug) => collapsed.has(slug));

    if (headings.length === 0)
        return null;

    return (<nav className={cn('sticky top-0 flex max-h-full w-[168px] shrink-0 flex-col self-start overflow-hidden py-5 pr-3', className)} aria-label={t('common.outline')}>
      <div className="mb-1 flex shrink-0 items-center gap-1.5 px-2">
        <ListTree size={11} className="shrink-0 text-[var(--text-quaternary)]"/>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t('common.outline')}</span>
        {showProgress && <ProgressRing value={progress}/>}
        <button type="button" aria-expanded={searchOpen} aria-label={t('outline.toggle_search')} onClick={() => { setSearchOpen((open) => !open); setQuery(''); }} className={cn('shrink-0 rounded-[var(--r-sm)] p-0.5 text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]', searchOpen && 'bg-[var(--bg-hover)] text-[var(--text-primary)]')}>
          <Search size={11}/>
        </button>
      </div>

      {searchOpen && (<div className="mb-1 flex shrink-0 items-center gap-1 px-2">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(''); setSearchOpen(false); } }} placeholder={t('outline.filter_placeholder')} aria-label={t('outline.filter_placeholder')} className="h-5 min-w-0 flex-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1 text-[length:var(--text-10-5)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"/>
          <button type="button" role="switch" aria-checked={useRegex} aria-label={t('outline.regex')} title={t('outline.regex')} onClick={() => setUseRegex((current) => !current)} className={cn('shrink-0 rounded-[var(--r-sm)] p-0.5 transition-colors hover:bg-[var(--bg-hover)]', useRegex ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>
            <Asterisk size={11}/>
          </button>
        </div>)}

      {searching ? (<div className="mb-1 flex shrink-0 items-center gap-1 px-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          <span className="tabular flex-1">{t('outline.match_count', { count: filter.matchCount })}</span>
          <button type="button" onClick={() => setQuery('')} aria-label={t('outline.clear_filter')} className="rounded-[var(--r-sm)] p-0.5 hover:bg-[var(--bg-hover)]"><X size={10}/></button>
        </div>) : (<div className="mb-1 flex shrink-0 flex-wrap items-center gap-0.5 px-2">
          {Array.from({ length: maxLevel }, (_, offset) => offset + 1).map((level) => {
            const preset = levelPresets.get(level)!;
            return (<button key={level} type="button" title={t('outline.expand_to_level', { level })} aria-label={t('outline.expand_to_level', { level })} aria-pressed={isSameSet(collapsed, preset)} onClick={() => setCollapsed(preset)} className={cn('h-4 min-w-4 rounded-[var(--r-sm)] px-0.5 text-[length:var(--text-10-5)] tabular transition-colors hover:bg-[var(--bg-hover)]', isSameSet(collapsed, preset) ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>{level}</button>);
          })}
          <button type="button" title={allCollapsed ? t('outline.expand_all') : t('outline.collapse_all')} aria-label={allCollapsed ? t('outline.expand_all') : t('outline.collapse_all')} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(parents))} className="ml-auto shrink-0 rounded-[var(--r-sm)] p-0.5 text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ChevronRight size={11} className={cn('transition-transform duration-[var(--dur-fast)]', allCollapsed ? 'rotate-90' : '-rotate-90')}/>
          </button>
        </div>)}

      <ul ref={listRef} className="min-h-0 flex-1 space-y-px overflow-y-auto">
        {drawn.map((node) => (<OutlineRow key={`${node.heading.slug}-${node.index}`} node={node} isLocated={node.heading.slug === locatedSlug} isCollapsed={collapsed.has(node.heading.slug)} onToggle={toggle} onSelect={onSelect}/>))}
        {drawn.length === 0 && <li className="px-2 py-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('outline.no_matches')}</li>}
      </ul>
    </nav>);
}

function OutlineRow({ node, isLocated, isCollapsed, onToggle, onSelect }: {
    node: OutlineNode;
    isLocated: boolean;
    isCollapsed: boolean;
    onToggle: (slug: string) => void;
    onSelect: (heading: Heading) => void;
}) {
    const { heading, tier, hasChildren } = node;
    const typography = getHeadingTypography(heading.level, isLocated);
    const HeadingIcon = getHeadingIcon(heading.level);
    const label = heading.text || t('preview.untitled');
    return (<li className={outlineMarginTop(node)} data-heading-level={heading.level}>
      <div className="flex items-center" style={{ paddingLeft: OUTLINE_INDENT_BASE + tier * OUTLINE_INDENT_STEP }}>
        {hasChildren ? (<button type="button" aria-expanded={!isCollapsed} aria-label={isCollapsed ? t('outline.expand_heading', { title: label }) : t('outline.collapse_heading', { title: label })} onClick={() => onToggle(heading.slug)} className="flex h-5 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" style={{ width: CHEVRON_SLOT }}>
              <ChevronRight size={10} className={cn('transition-transform duration-[var(--dur-fast)]', !isCollapsed && 'rotate-90')}/>
            </button>) : (<span aria-hidden="true" className="shrink-0" style={{ width: CHEVRON_SLOT }}/>) }
        <Tooltip label={label} side="left">
          <button type="button" data-slug={heading.slug} aria-current={isLocated ? 'location' : undefined} onClick={() => onSelect(heading)} className={cn('group relative flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-sm)] pr-1.5 text-left leading-snug', 'transition-colors duration-[var(--dur-fast)]', typography.fontSize, typography.fontWeight, typography.textColor, typography.paddingY, isLocated
                    ? 'bg-[var(--accent-soft)]'
                    : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
            {isLocated && <span aria-hidden="true" className={cn('absolute top-1/2 left-0.5 h-3.5', ACTIVE_BAR_W, '-translate-y-1/2 rounded-full bg-[var(--accent)]')}/>}
            <HeadingIcon size={typography.iconSize} aria-hidden="true" className={cn('shrink-0 transition-opacity duration-[var(--dur-fast)]', typography.iconColor, !isLocated && 'group-hover:text-[var(--text-secondary)] group-hover:opacity-100')}/>
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
        </Tooltip>
      </div>
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
