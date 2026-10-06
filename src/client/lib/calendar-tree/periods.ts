import type { NoteSummary } from '@shared/types';
import { dateKey } from '../time';
import type { VirtualTreeNamespace } from './ids';
import { TODO_TREE, quarterOfMonth, splitTodoTags, parseVirtualId } from './ids';
import type { CalendarPeriod } from './types';

export function calendarNodeName(period: CalendarPeriod): string {
    switch (period.kind) {
        case 'root':
            return '';
        case 'year':
            return String(period.year);
        case 'quarter':
            return `Q${period.quarter}`;
        case 'month':
            return String(period.month).padStart(2, '0');
        case 'week':
            return `ww${String(period.week).padStart(2, '0')}`;
    }
}

export function isoWeekOf(date: Date): { year: number; week: number } {
    const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    thursday.setDate(thursday.getDate() + 4 - (thursday.getDay() || 7));
    const yearStart = new Date(thursday.getFullYear(), 0, 1);
    const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return { year: thursday.getFullYear(), week };
}

export function mondayOfWeek(year: number, week: number): Date {
    const jan4 = new Date(year, 0, 4);
    const jan4Day = jan4.getDay() || 7;
    const week1Monday = jan4.getDate() - (jan4Day - 1);
    return new Date(year, 0, week1Monday + (week - 1) * 7);
}

export function noteWeekPeriod(ts: number): { year: number; month: number; week: number } {
    const date = new Date(ts);
    const { year, week } = isoWeekOf(date);
    const thursday = mondayOfWeek(year, week);
    thursday.setDate(thursday.getDate() + 3);
    return { year, month: thursday.getMonth() + 1, week };
}

export function calendarPeriodMatchesNote(period: CalendarPeriod, note: NoteSummary): boolean {
    if (period.kind === 'root')
        return true;
    const leaf = noteWeekPeriod(note.createdAt);
    switch (period.kind) {
        case 'year':
            return leaf.year === period.year;
        case 'quarter':
            return leaf.year === period.year && quarterOfMonth(leaf.month) === period.quarter;
        case 'month':
            return leaf.year === period.year && leaf.month === period.month;
        case 'week':
            return leaf.year === period.year && leaf.month === period.month && leaf.week === period.week;
        default:
            return true;
    }
}

export function isTodoNoteForTags(note: NoteSummary, tags: readonly string[]): boolean {
    return tags.length > 0 && note.tags.some((tag) => tags.includes(tag));
}

export function virtualPeriodMatchesNote(period: CalendarPeriod, note: NoteSummary, ns: VirtualTreeNamespace, tagText: string): boolean {
    if (ns === TODO_TREE && !isTodoNoteForTags(note, splitTodoTags(tagText)))
        return false;
    return calendarPeriodMatchesNote(period, note);
}

export function virtualPeriodKeyRange(id: string | null | undefined, ns: VirtualTreeNamespace): { start: string; end: string } | null {
    const period = parseVirtualId(id, ns);
    if (!period || period.kind === 'root')
        return null;
    const start = new Date(0);
    const end = new Date(0);
    switch (period.kind) {
        case 'year':
            start.setFullYear(period.year, 0, 1);
            end.setFullYear(period.year, 11, 31);
            break;
        case 'quarter': {
            const firstMonth = (period.quarter - 1) * 3;
            start.setFullYear(period.year, firstMonth, 1);
            end.setFullYear(period.year, firstMonth + 3, 0);
            break;
        }
        case 'month':
            start.setFullYear(period.year, period.month - 1, 1);
            end.setFullYear(period.year, period.month, 0);
            break;
        case 'week': {
            const monday = mondayOfWeek(period.year, period.week);
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            return { start: dateKey(monday), end: dateKey(sunday) };
        }
        default:
            return null;
    }
    return { start: dateKey(start), end: dateKey(end) };
}
