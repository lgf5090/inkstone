import { LIMITS } from '@shared/constants';
import type { DateRangeFilter, Folder, NoteSummary, Tag } from '@shared/types';
import { parseDateKey } from '../lib/time';

export function adjustTagCountsForNoteEdit(
    tags: Tag[],
    previous: readonly string[],
    next: readonly string[],
): Tag[] {
    const before = new Set(previous.map(tagNameKey));
    const after = new Set(next.map(tagNameKey));
    let changed = false;
    const out = tags.map((tag) => {
        const key = tagNameKey(tag.name);
        const delta = (after.has(key) ? 1 : 0) - (before.has(key) ? 1 : 0);
        if (delta === 0)
            return tag;
        changed = true;
        return { ...tag, count: Math.max(0, tag.count + delta) };
    });
    return changed ? out : tags;
}

export function tagNameKey(name: string): string {
    return name.normalize('NFKC').toLocaleLowerCase();
}

export function equalStringArrays(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

// The window is resolved to two instants once per recompute rather than to a day key
// per note: the old predicate built a Date and a `YYYY-MM-DD` string for every row.
// The upper bound is the start of the day AFTER `end`, so a 23-hour DST day cannot
// shave the closing hour off the range the way a fixed day length would.
// The upper edge is asked of the Date constructor as `day + 1`, never read off a parsed
// end-of-range Date and nudged with `setDate`: where a zone puts the clock forward at
// midnight (America/Santiago 2026-09-06 has no 00:00), the parsed date has already
// normalised to 01:00 and `setDate` carries that hour onto the next day, widening the
// window by an hour the reader never selected.
export interface DayWindow {
    from: number;
    to: number;
}
export function dayWindow(range: DateRangeFilter | null): DayWindow | null {
    if (!range)
        return null;
    const [endYear, endMonth, endDay] = range.end.split('-').map(Number);
    return { from: parseDateKey(range.start).getTime(), to: new Date(endYear, endMonth - 1, endDay + 1).getTime() };
}
export function inDayWindow(note: NoteSummary, days: DayWindow | null): boolean {
    if (!days)
        return true;
    return note.updatedAt >= days.from && note.updatedAt < days.to;
}

export interface FolderNode extends Folder {
    children: FolderNode[];
    depth: number;
    directNotes: number;
    totalNotes: number;
}
export function buildFolderTree(folders: Folder[], direct: ReadonlyMap<string, number>): FolderNode[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const byParent = new Map<string, Folder[]>();
    const compare = (a: Folder, b: Folder) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    for (const folder of folders) {
        const key = folder.parentId ?? '';
        const list = byParent.get(key) ?? [];
        list.push(folder);
        byParent.set(key, list);
    }
    for (const list of byParent.values())
        list.sort(compare);
    const visited = new Set<string>();
    const build = (folder: Folder, depth: number, parentId: string | null): FolderNode | null => {
        if (visited.has(folder.id))
            return null;
        visited.add(folder.id);
        const children = depth + 1 < LIMITS.folderDepthMax
            ? (byParent.get(folder.id) ?? []).flatMap((child) => {
                const node = build(child, depth + 1, folder.id);
                return node ? [node] : [];
            })
            : [];
        const directNotes = direct.get(folder.id) ?? 0;
        const totalNotes = directNotes + children.reduce((sum, child) => sum + child.totalNotes, 0);
        return { ...folder, parentId, children, depth, directNotes, totalNotes };
    };
    const roots = folders
        .filter((folder) => folder.parentId === null || !byId.has(folder.parentId))
        .sort(compare)
        .flatMap((folder) => {
        const node = build(folder, 0, null);
        return node ? [node] : [];
    });
    for (const folder of folders.toSorted(compare)) {
        if (visited.has(folder.id))
            continue;
        const node = build(folder, 0, null);
        if (node)
            roots.push(node);
    }
    return roots.sort(compare);
}
