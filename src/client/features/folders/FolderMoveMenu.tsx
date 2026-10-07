import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, FolderClosed, Inbox } from 'lucide-react';
import type { FolderNode } from '../../store/notes';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';

const LEVEL_WIDTH = 188;
const LEVEL_GAP = 2;
const ROW_SELECTOR = '[data-move-row]:not([disabled])';

interface OpenLevel {
    id: string;
    label: string;
    nodes: FolderNode[];
    top: number;
    left: number;
}

function prune(nodes: readonly FolderNode[], excluded: ReadonlySet<string>): FolderNode[] {
    const kept: FolderNode[] = [];
    for (const node of nodes) {
        if (excluded.has(node.id))
            continue;
        kept.push({ ...node, children: prune(node.children, excluded) });
    }
    return kept;
}

function levelLeft(rect: DOMRect): number {
    const margin = 8;
    const prefer = rect.right + LEVEL_GAP;
    if (prefer + LEVEL_WIDTH <= window.innerWidth - margin)
        return prefer;
    return Math.max(margin, Math.min(rect.left - LEVEL_WIDTH - LEVEL_GAP, window.innerWidth - margin - LEVEL_WIDTH));
}

export function FolderMoveMenu({ tree, subject, currentParentId, excludedIds, inboxFolderId, onSelect }: {
    tree: readonly FolderNode[];
    subject: FolderNode;
    currentParentId: string | null;
    excludedIds: ReadonlySet<string>;
    inboxFolderId?: string | null;
    onSelect: (parentId: string | null) => void;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const levelRefs = useRef<(HTMLDivElement | null)[]>([]);
    const [open, setOpen] = useState<OpenLevel[]>([]);
    const pendingFocus = useRef(-1);
    const levels = useMemo(() => prune(tree, excludedIds), [tree, excludedIds]);
    const byId = useMemo(() => {
        const found = new Map<string, FolderNode>();
        const walk = (nodes: FolderNode[]) => {
            for (const node of nodes) {
                found.set(node.id, node);
                walk(node.children);
            }
        };
        walk(levels);
        return found;
    }, [levels]);
    const inbox = inboxFolderId && inboxFolderId !== subject.id ? byId.get(inboxFolderId) ?? null : null;


    const reanchor = useCallback(() => {
        setOpen((current) => {
            if (current.length === 0)
                return current;
            let changed = false;
            const bounds = rootRef.current?.parentElement?.getBoundingClientRect();
            const base = bounds ? { top: bounds.top, left: bounds.left } : { top: 0, left: 0 };
            const next = current.map((level, index) => {
                const parent = index === 0 ? rootRef.current : levelRefs.current[index - 1];
                const panel = levelRefs.current[index];
                const row = parent?.querySelector<HTMLElement>(`[data-move-id="${level.id}"]`);
                if (!row || !panel)
                    return level;
                const rect = row.getBoundingClientRect();
                const box = panel.getBoundingClientRect();
                const top = Math.min(Math.max(8, rect.top - 4), Math.max(8, window.innerHeight - 8 - box.height)) - base.top;
                const left = levelLeft(rect) - base.left;
                if (top === level.top && left === level.left)
                    return level;
                changed = true;
                return { ...level, top, left };
            });
            return changed ? next : current;
        });
    }, []);

    useLayoutEffect(reanchor, [open, reanchor]);

    useEffect(() => {
        document.addEventListener('scroll', reanchor, true);
        window.addEventListener('resize', reanchor);
        return () => {
            document.removeEventListener('scroll', reanchor, true);
            window.removeEventListener('resize', reanchor);
        };
    }, [reanchor]);
    useEffect(() => {
        if (pendingFocus.current < 0)
            return;
        const level = pendingFocus.current;
        pendingFocus.current = -1;
        levelRefs.current[level]?.querySelector<HTMLButtonElement>(ROW_SELECTOR)?.focus({ preventScroll: true });
    }, [open]);

    const hover = (depth: number, node: FolderNode | null, rect: DOMRect) => {
        setOpen((current) => {
            const kept = current.slice(0, depth);
            if (!node || node.children.length === 0)
                return kept.length === current.length ? current : kept;
            if (current[depth]?.id === node.id)
                return current;
            return [...kept, {
                id: node.id,
                label: node.name,
                nodes: node.children,
                top: rect.top - 4,
                left: levelLeft(rect),
            }];
        });
    };

    const focusRow = (depth: number, step: (index: number, count: number) => number) => {
        const panel = depth === 0 ? rootRef.current : levelRefs.current[depth - 1];
        const rows = panel ? [...panel.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR)] : [];
        if (rows.length === 0)
            return;
        const at = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = step(at < 0 ? 0 : at, rows.length);
        rows[Math.min(Math.max(next, 0), rows.length - 1)]?.focus({ preventScroll: true });
    };

    const activeDepth = () => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement))
            return -1;
        for (let index = 0; index < open.length; index++) {
            if (levelRefs.current[index]?.contains(active))
                return index + 1;
        }
        return rootRef.current?.contains(active) ? 0 : -1;
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const depth = activeDepth();
        if (depth < 0)
            return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            focusRow(depth, (index, count) => (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
            return;
        }
        if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            focusRow(depth, (_index, count) => (event.key === 'Home' ? 0 : count - 1));
            return;
        }
        if (event.key !== 'ArrowRight')
            return;
        const row = document.activeElement;
        if (!(row instanceof HTMLButtonElement) || row.dataset.moveHasChildren !== '1')
            return;
        const node = byId.get(row.dataset.moveId ?? '');
        if (!node)
            return;
        event.preventDefault();
        if (open[depth]?.id === node.id)
            levelRefs.current[depth]?.querySelector<HTMLButtonElement>(ROW_SELECTOR)?.focus({ preventScroll: true });
        else
            pendingFocus.current = depth;
        hover(depth, node, row.getBoundingClientRect());
    };

    return (<div ref={rootRef} className="outline-none" onKeyDown={onKeyDown}>
      <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1">
        <span className="flex size-4 shrink-0 items-center justify-center text-[13px] leading-none" style={{ color: subject.color ?? 'var(--text-tertiary)' }} aria-hidden="true">
          {subject.icon || <FolderClosed size={13}/>}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-tertiary)]">{t("folders.move_subject_value0", { value0: subject.name })}</span>
      </div>
      <div className="max-h-[252px] overflow-y-auto border-t border-[var(--border-subtle)] pt-1" onScroll={reanchor} role="group" aria-label={t("folders.move_to")}>
        <MoveRow depth={0} id={null} label={t("folders.move_unfiled")} glyph={<Inbox size={13}/>} count={0} isCurrent={currentParentId === null} hasChildren={levels.length > 0} onHover={(rect) => hover(0, null, rect)} onSelect={() => onSelect(null)}/>
        {inbox && (<MoveRow depth={0} id={inbox.id} label={t("folders.move_inbox_value0", { value0: inbox.name })} glyph={inbox.icon || null} color={inbox.color} count={inbox.directNotes} isCurrent={currentParentId === inbox.id} hasChildren={false} onHover={(rect) => hover(0, null, rect)} onSelect={() => onSelect(inbox.id)}/>)}
        {levels.map((node) => <FolderBranch key={node.id} node={node} depth={0} currentParentId={currentParentId} onHover={hover} onSelect={onSelect}/>)}
        {levels.length === 0 && currentParentId === null && (<p className="px-2 py-4 text-center text-[11.5px] text-[var(--text-quaternary)]">{t("folders.move_empty")}</p>)}
      </div>
      {open.map((level, index) => (<div key={level.id} ref={(element) => {
        levelRefs.current[index] = element;
    }} onScroll={reanchor} className="anim-pop fixed max-h-[252px] overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)] outline-none" style={{
        top: level.top,
        left: level.left,
        width: LEVEL_WIDTH,
        zIndex: 270,
    }} role="group" aria-label={level.label}>
          {level.nodes.map((node) => <FolderBranch key={node.id} node={node} depth={index + 1} currentParentId={currentParentId} onHover={hover} onSelect={onSelect}/>)}
        </div>))}
    </div>);
}

function FolderBranch({ node, depth, currentParentId, onHover, onSelect }: {
    node: FolderNode;
    depth: number;
    currentParentId: string | null;
    onHover: (depth: number, node: FolderNode | null, rect: DOMRect) => void;
    onSelect: (parentId: string | null) => void;
}) {
    return <MoveRow depth={depth} id={node.id} label={node.name} glyph={node.icon || null} color={node.color} count={node.directNotes} isCurrent={currentParentId === node.id} hasChildren={node.children.length > 0} onHover={(rect) => onHover(depth, node, rect)} onSelect={() => onSelect(node.id)}/>;
}

function MoveRow({ depth, id, label, glyph, color, count, isCurrent, hasChildren, onHover, onSelect }: {
    depth: number;
    id: string | null;
    label: string;
    glyph: React.ReactNode | string | null;
    color?: string | null;
    count: number;
    isCurrent: boolean;
    hasChildren: boolean;
    onHover: (rect: DOMRect) => void;
    onSelect: () => void;
}) {
    return (<button type="button" data-move-row data-move-depth={depth} data-move-id={id ?? ''} data-move-has-children={hasChildren ? '1' : '0'} disabled={isCurrent} aria-current={isCurrent ? 'true' : undefined} onMouseEnter={(event) => onHover(event.currentTarget.getBoundingClientRect())} onFocus={(event) => onHover(event.currentTarget.getBoundingClientRect())} onClick={onSelect} className={cn('flex h-10 w-full items-center gap-2 rounded-[var(--r-sm)] pr-1 text-left text-[12.5px] transition-colors md:h-[30px]', isCurrent
            ? 'text-[var(--text-quaternary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')} style={{ paddingLeft: 4 + depth * 12 }}>
      <span className="flex size-4 shrink-0 items-center justify-center text-[13px] leading-none" style={{ color: typeof glyph === 'string' ? color ?? undefined : 'var(--text-tertiary)' }} aria-hidden="true">
        {typeof glyph === 'string' ? glyph : glyph ?? <FolderClosed size={13}/>}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {isCurrent && (<span className="shrink-0 text-[10.5px] text-[var(--text-quaternary)]">{t("folders.current_location")}</span>)}
      {!isCurrent && count > 0 && (<span className="shrink-0 text-[10.5px] tabular-nums text-[var(--text-quaternary)]">{count}</span>)}
      {isCurrent ? <Check size={13} aria-hidden="true" className="shrink-0 text-[var(--accent)]"/> : hasChildren && <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]"/>}
    </button>);
}
