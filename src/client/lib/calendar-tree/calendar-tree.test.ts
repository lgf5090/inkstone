import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n, t } from '../../lib/i18n';
import type { NoteSummary } from '@shared/types';
import {
    CALENDAR_TREE,
    TODO_TREE,
    buildVirtualTree,
    buildVirtualTreeCached,
    calendarNodeName,
    calendarPeriodMatchesNote,
    isCalendarFolderId,
    isInboxFolderId,
    isTodoFolderId,
    isVirtualFolderId,
    noteWeekPeriod,
    parseVirtualId,
    splitTodoTags,
    virtualAncestorIds,
    virtualFolderLabel,
    virtualId,
    virtualPathSegments,
    virtualPeriodKeyRange,
    virtualTreeNamespace,
} from './index';
import { quarterOfMonth } from './ids';

function note(id: string, createdAt: number, tags: string[] = [], folderId: string | null = 'f1'): NoteSummary {
    return {
        id, title: id, excerpt: '', folderId, tags, isPinned: false, isStarred: false, isArchived: false,
        wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt, updatedAt: createdAt, deletedAt: null,
    };
}

const at = (iso: string) => new Date(`${iso}T12:00:00`).getTime();

beforeAll(async () => {
    await initI18n();
});

describe('ISO week bucketing', () => {
    it.each([
        ['2026-01-01', { year: 2026, month: 1, week: 1 }],
        ['2024-12-30', { year: 2025, month: 1, week: 1 }],
        ['2026-12-31', { year: 2026, month: 12, week: 53 }],
        ['2021-01-01', { year: 2020, month: 12, week: 53 }],
        ['2026-10-06', { year: 2026, month: 10, week: 41 }],
    ])('places %s in the documented period', (iso, expected) => {
        expect(noteWeekPeriod(at(iso))).toEqual(expected);
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
        'month %i falls in the expected quarter', (month) => {
            expect(quarterOfMonth(month)).toBe(Math.ceil(month / 3));
        },
    );
});

describe('virtual id codec', () => {
    it('round-trips every period kind', () => {
        const periods = [
            { kind: 'root' },
            { kind: 'year', year: 2026 },
            { kind: 'quarter', year: 2026, quarter: 4 },
            { kind: 'month', year: 2026, month: 10 },
            { kind: 'week', year: 2026, month: 10, week: 41 },
        ] as const;
        for (const period of periods) {
            const id = virtualId(period, CALENDAR_TREE);
            expect(parseVirtualId(id, CALENDAR_TREE)).toEqual(period);
            expect(parseVirtualId(id, TODO_TREE)).toBeNull();
        }
        expect(virtualId({ kind: 'month', year: 2026, month: 10 }, CALENDAR_TREE)).toBe('cal:2026:q4:10');
        expect(virtualId({ kind: 'week', year: 2026, month: 10, week: 41 }, TODO_TREE)).toBe('todo:2026:q4:10:w41');
    });

    it('rejects malformed or foreign ids instead of guessing', () => {
        for (const bad of ['', 'cal:', 'cal:26', 'cal:2026:q9', 'cal:2026:q4:13', 'cal:2026:q4:10:w0', 'cal:2026:q4:10:w54', 'other:2026']) {
            expect(parseVirtualId(bad, CALENDAR_TREE)).toBeNull();
        }
        expect(parseVirtualId(null, CALENDAR_TREE)).toBeNull();
    });

    it('classifies namespaces without crossing them', () => {
        expect(isCalendarFolderId('cal:2026')).toBe(true);
        expect(isCalendarFolderId('cal')).toBe(true);
        expect(isCalendarFolderId('todo:2026')).toBe(false);
        expect(isTodoFolderId('todo')).toBe(true);
        expect(isInboxFolderId('inbox')).toBe(true);
        expect(isInboxFolderId('inbox:2026')).toBe(true);
        expect(isVirtualFolderId('01m46wsqw0je8f19vypr4jb0sh')).toBe(false);
        expect(virtualTreeNamespace('todo:2026:q4')).toBe(TODO_TREE);
        expect(virtualTreeNamespace('f1')).toBeNull();
    });

    it('lists ancestors and path segments for a deep node', () => {
        const id = 'cal:2026:q4:10:w41';
        expect(virtualAncestorIds(id, CALENDAR_TREE)).toEqual(['cal:2026', 'cal:2026:q4', 'cal:2026:q4:10']);
        expect(virtualAncestorIds('cal', CALENDAR_TREE)).toEqual([]);
        expect(virtualPathSegments(id, CALENDAR_TREE)).toEqual(['2026', 'Q4', '10', 'ww41']);
        expect(virtualPathSegments('cal', CALENDAR_TREE)).toBeNull();
    });

    it('names nodes and labels them for the list header', () => {
        expect(calendarNodeName({ kind: 'week', year: 2026, month: 10, week: 41 })).toBe('ww41');
        expect(virtualFolderLabel('cal:2026:q4:10')).toBe(`${t('sidebar.calendar_folder')} / 2026 / Q4 / 10`);
        expect(virtualFolderLabel('cal')).toBe(t('sidebar.calendar_folder'));
        expect(virtualFolderLabel('todo:2026')).toBe(`${t('sidebar.todo_folder')} / 2026`);
        expect(virtualFolderLabel('f1')).toBeNull();
    });

    it('spans the documented date range of each period', () => {
        expect(virtualPeriodKeyRange('cal:2026:q4:10', CALENDAR_TREE)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
        expect(virtualPeriodKeyRange('cal:2026:q4:10:w41', CALENDAR_TREE)).toEqual({ start: '2026-10-05', end: '2026-10-11' });
        expect(virtualPeriodKeyRange('cal:2026', CALENDAR_TREE)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
        expect(virtualPeriodKeyRange('cal', CALENDAR_TREE)).toBeNull();
    });
});

describe('buildVirtualTree', () => {
    const notes = [
        note('a', at('2026-10-06')),
        note('b', at('2026-10-08')),
        note('c', at('2025-03-04')),
        note('gone', at('2026-10-07'), [], 'f1'),
    ];
    const live = notes.filter((item) => item.id !== 'gone');

    it('rolls counts up from the week leaf to the year root', () => {
        const years = buildVirtualTree(live, CALENDAR_TREE);
        expect(years.map((node) => node.name)).toEqual(['2025', '2026']);
        const [first, second] = years;
        expect(first?.count).toBe(1);
        expect(second?.count).toBe(2);
        const quarter = second!.children[0]!;
        expect(quarter.name).toBe('Q4');
        const month = quarter.children[0]!;
        expect(month.name).toBe('10');
        const week = month.children[0]!;
        expect(week.name).toBe('ww41');
        expect(week.count).toBe(2);
        expect(week.depth).toBe(3);
    });

    it('fills the year-to-month skeleton when empty periods are requested', () => {
        const years = buildVirtualTree(live, CALENDAR_TREE, true);
        expect(years.map((node) => node.name)).toEqual(['2025', '2026']);
        const emptyYear = years.find((node) => node.name === '2025')!;
        expect(emptyYear.children).toHaveLength(4);
        expect(emptyYear.children.map((node) => node.count)).toEqual([1, 0, 0, 0]);
        const q1 = emptyYear.children[0]!;
        expect(q1.children.map((node) => node.name)).toEqual(['01', '02', '03']);
        expect(q1.children[0]!.children).toEqual([]);
    });

    it('keeps the todo tree to notes carrying one of the configured tags', () => {
        const tagged = [note('t1', at('2026-10-06'), ['chore']), note('t2', at('2026-10-06'), ['todo']), note('x', at('2026-10-06'), ['reading'])];
        const wanted = splitTodoTags('chore,todo');
        expect(wanted).toEqual(['chore', 'todo']);
        const years = buildVirtualTree(tagged.filter((item) => wanted.some((tag) => item.tags.includes(tag))), TODO_TREE);
        expect(years.reduce((sum, node) => sum + node.count, 0)).toBe(2);
    });

    it('matches a note against any ancestor period', () => {
        const target = note('a', at('2026-10-06'));
        expect(calendarPeriodMatchesNote({ kind: 'root' }, target)).toBe(true);
        expect(calendarPeriodMatchesNote({ kind: 'year', year: 2026 }, target)).toBe(true);
        expect(calendarPeriodMatchesNote({ kind: 'quarter', year: 2026, quarter: 4 }, target)).toBe(true);
        expect(calendarPeriodMatchesNote({ kind: 'month', year: 2026, month: 10 }, target)).toBe(true);
        expect(calendarPeriodMatchesNote({ kind: 'week', year: 2026, month: 10, week: 41 }, target)).toBe(true);
        expect(calendarPeriodMatchesNote({ kind: 'month', year: 2026, month: 11 }, target)).toBe(false);
        expect(calendarPeriodMatchesNote({ kind: 'year', year: 2025 }, target)).toBe(false);
    });

    it('keeps the built tree identity while only unrelated note fields change', () => {
        const map: Record<string, NoteSummary> = Object.fromEntries(live.map((item) => [item.id, item]));
        const first = buildVirtualTreeCached(map, CALENDAR_TREE, false);
        const renamed: Record<string, NoteSummary> = { ...map, a: { ...map.a!, title: 'renamed', excerpt: 'longer' } };
        expect(buildVirtualTreeCached(renamed, CALENDAR_TREE, false)).toBe(first);
        const retyped: Record<string, NoteSummary> = { ...renamed, b: { ...renamed.b!, wordCount: 99 } };
        expect(buildVirtualTreeCached(retyped, CALENDAR_TREE, false)).toBe(first);
        const moved: Record<string, NoteSummary> = { ...retyped, a: { ...retyped.a!, createdAt: at('2019-01-01') } };
        const rebuilt = buildVirtualTreeCached(moved, CALENDAR_TREE, false);
        expect(rebuilt).not.toBe(first);
        expect(rebuilt.map((node) => node.name)).toEqual(['2019', '2025', '2026']);
        const trashed: Record<string, NoteSummary> = { ...moved, c: { ...moved.c!, deletedAt: 7 } };
        expect(buildVirtualTreeCached(trashed, CALENDAR_TREE, false).map((node) => node.name)).toEqual(['2019', '2026']);
    });
});
