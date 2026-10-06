import type { NoteSummary } from '@shared/types';
import type { VirtualTreeNamespace } from './ids';
import { TODO_TREE, parseVirtualId, quarterOfMonth, splitTodoTags, virtualId } from './ids';
import { calendarNodeName, isTodoNoteForTags, noteWeekPeriod } from './periods';
import type { CalendarNode, CalendarPeriod } from './types';

export function filterTodoNotes(notes: Iterable<NoteSummary>, tagText: string = ''): NoteSummary[] {
    const tags = splitTodoTags(tagText);
    return [...notes].filter((note) => isTodoNoteForTags(note, tags));
}

export function virtualPathSegments(id: string | null | undefined, ns: VirtualTreeNamespace): string[] | null {
    const period = parseVirtualId(id, ns);
    if (!period || period.kind === 'root')
        return null;
    switch (period.kind) {
        case 'year':
            return [String(period.year)];
        case 'quarter':
            return [String(period.year), `Q${period.quarter}`];
        case 'month':
            return [String(period.year), `Q${quarterOfMonth(period.month)}`, String(period.month).padStart(2, '0')];
        case 'week':
            return [
                String(period.year),
                `Q${quarterOfMonth(period.month)}`,
                String(period.month).padStart(2, '0'),
                `ww${String(period.week).padStart(2, '0')}`,
            ];
        default:
            return null;
    }
}

export function virtualAncestorIds(id: string | null | undefined, ns: VirtualTreeNamespace): string[] {
    const period = parseVirtualId(id, ns);
    if (!period)
        return [];
    const chain: CalendarPeriod[] = [{ kind: 'root' }];
    switch (period.kind) {
        case 'year':
            break;
        case 'quarter':
            chain.push({ kind: 'year', year: period.year });
            break;
        case 'month':
            chain.push({ kind: 'year', year: period.year }, { kind: 'quarter', year: period.year, quarter: quarterOfMonth(period.month) });
            break;
        case 'week':
            chain.push(
                { kind: 'year', year: period.year },
                { kind: 'quarter', year: period.year, quarter: quarterOfMonth(period.month) },
                { kind: 'month', year: period.year, month: period.month },
            );
            break;
        case 'root':
            break;
    }
    return chain.slice(1).map((item) => virtualId(item, ns));
}

interface VirtualCounts {
    counts: Map<string, number>;
    childrenOf: Map<string, Set<string>>;
    minYear: number;
    maxYear: number;
}

function childrenSetOf(childrenOf: Map<string, Set<string>>, id: string): Set<string> {
    let set = childrenOf.get(id);
    if (!set) {
        set = new Set();
        childrenOf.set(id, set);
    }
    return set;
}

function collectVirtualCounts(notes: Iterable<NoteSummary>, ns: VirtualTreeNamespace): VirtualCounts {
    const counts = new Map<string, number>();
    const childrenOf = new Map<string, Set<string>>();
    let minYear = Infinity;
    let maxYear = -Infinity;
    for (const note of notes) {
        if (note.deletedAt !== null)
            continue;
        const leaf = noteWeekPeriod(note.createdAt);
        const ids = [
            ns.rootId,
            virtualId({ kind: 'year', year: leaf.year }, ns),
            virtualId({ kind: 'quarter', year: leaf.year, quarter: quarterOfMonth(leaf.month) }, ns),
            virtualId({ kind: 'month', year: leaf.year, month: leaf.month }, ns),
            virtualId({ kind: 'week', year: leaf.year, month: leaf.month, week: leaf.week }, ns),
        ];
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i]!;
            counts.set(id, (counts.get(id) ?? 0) + 1);
            if (i > 0)
                childrenSetOf(childrenOf, ids[i - 1]!).add(id);
        }
        minYear = Math.min(minYear, leaf.year);
        maxYear = Math.max(maxYear, leaf.year);
    }
    return { counts, childrenOf, minYear, maxYear };
}

function nameOf(id: string, ns: VirtualTreeNamespace): string {
    const parsed = parseVirtualId(id, ns);
    return parsed ? calendarNodeName(parsed) : '';
}

function buildVirtualNode(id: string, depth: number, childrenOf: Map<string, Set<string>>, counts: Map<string, number>, ns: VirtualTreeNamespace): CalendarNode {
    const children = [...(childrenOf.get(id) ?? [])]
        .sort()
        .map((child) => buildVirtualNode(child, depth + 1, childrenOf, counts, ns));
    const count = children.length
        ? children.reduce((sum, child) => sum + child.count, 0)
        : (counts.get(id) ?? 0);
    return { id, name: nameOf(id, ns), depth, count, children };
}

function buildEmptyVirtualTree(collected: VirtualCounts, ns: VirtualTreeNamespace): CalendarNode[] {
    const { childrenOf, counts, minYear, maxYear } = collected;
    if (!Number.isFinite(minYear))
        return [];
    const years: CalendarNode[] = [];
    for (let year = minYear; year <= maxYear; year++) {
        const quarters: CalendarNode[] = [];
        for (let quarter = 1; quarter <= 4; quarter++) {
            const months: CalendarNode[] = [];
            const firstMonth = (quarter - 1) * 3 + 1;
            for (let month = firstMonth; month < firstMonth + 3; month++) {
                const id = virtualId({ kind: 'month', year, month }, ns);
                const weeks = [...(childrenOf.get(id) ?? [])]
                    .sort()
                    .map((child) => buildVirtualNode(child, 3, childrenOf, counts, ns));
                months.push({ id, name: calendarNodeName({ kind: 'month', year, month }), depth: 2, count: counts.get(id) ?? 0, children: weeks });
            }
            const qId = virtualId({ kind: 'quarter', year, quarter }, ns);
            quarters.push({
                id: qId,
                name: calendarNodeName({ kind: 'quarter', year, quarter }),
                depth: 1,
                count: months.reduce((sum, month) => sum + month.count, 0),
                children: months,
            });
        }
        years.push({
            id: virtualId({ kind: 'year', year }, ns),
            name: calendarNodeName({ kind: 'year', year }),
            depth: 0,
            count: quarters.reduce((sum, quarter) => sum + quarter.count, 0),
            children: quarters,
        });
    }
    return years;
}

export function buildVirtualTree(notes: Iterable<NoteSummary>, ns: VirtualTreeNamespace, includeEmpty = false): CalendarNode[] {
    const collected = collectVirtualCounts(notes, ns);
    if (!includeEmpty)
        return buildVirtualNode(ns.rootId, -1, collected.childrenOf, collected.counts, ns).children;
    return buildEmptyVirtualTree(collected, ns);
}

export interface VirtualTreeCacheSlot {
    notes: Record<string, NoteSummary>;
    todoTags: readonly string[] | null;
    children: CalendarNode[];
}

export const virtualTreeSlots = new Map<string, VirtualTreeCacheSlot>();

export function sameTodoTags(a: readonly string[] | null, b: readonly string[] | null): boolean {
    if (a === b)
        return true;
    if (!a || !b)
        return false;
    return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

export function virtualTreeInputsEqual(
    prev: Record<string, NoteSummary>,
    next: Record<string, NoteSummary>,
    todoTags: readonly string[] | null,
): boolean {
    if (prev === next)
        return true;
    let prevSize = 0;
    for (const id in prev) {
        prevSize++;
        const before = prev[id];
        const after = next[id];
        if (!before || !after)
            return false;
        if (before === after)
            continue;
        if (before.createdAt !== after.createdAt || (before.deletedAt === null) !== (after.deletedAt === null))
            return false;
        if (todoTags && isTodoNoteForTags(before, todoTags) !== isTodoNoteForTags(after, todoTags))
            return false;
    }
    let nextSize = 0;
    for (const _key in next)
        nextSize++;
    return prevSize === nextSize;
}

export const virtualTreeVerdicts = new WeakMap<object, Map<string, { prev: Record<string, NoteSummary>; stable: boolean }>>();

export function buildVirtualTreeCached(
    notes: Record<string, NoteSummary>,
    ns: VirtualTreeNamespace,
    includeEmpty: boolean,
    todoTags: readonly string[] | null = null,
): CalendarNode[] {
    const key = `${ns.rootId}|${includeEmpty ? 'e' : 'c'}`;
    const cached = virtualTreeSlots.get(key);
    const same = Boolean(cached && sameTodoTags(cached.todoTags, todoTags));
    let isStable = false;
    if (same) {
        let perMap = virtualTreeVerdicts.get(notes);
        if (!perMap) {
            perMap = new Map();
            virtualTreeVerdicts.set(notes, perMap);
        }
        const verdict = perMap.get(key);
        if (verdict && verdict.prev === cached!.notes) {
            isStable = verdict.stable;
        }
        else {
            isStable = virtualTreeInputsEqual(cached!.notes, notes, todoTags);
            perMap.set(key, { prev: cached!.notes, stable: isStable });
        }
    }
    if (same && isStable)
        return cached!.children;
    const values = ns === TODO_TREE && todoTags && todoTags.length
        ? Object.values(notes).filter((note) => isTodoNoteForTags(note, todoTags))
        : Object.values(notes);
    const children = buildVirtualTree(values, ns, includeEmpty);
    virtualTreeSlots.set(key, { notes, todoTags, children });
    return children;
}
