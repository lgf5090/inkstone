import { t } from '../i18n';
import type { CalendarPeriod } from './types';

export const CALENDAR_ROOT_ID = 'cal';

export const TODO_ROOT_ID = 'todo';

export const INBOX_ROOT_ID = 'inbox';

export interface VirtualTreeNamespace {
    rootId: string;
    prefix: string;
}

export const CALENDAR_TREE: VirtualTreeNamespace = { rootId: CALENDAR_ROOT_ID, prefix: 'cal:' };

export const TODO_TREE: VirtualTreeNamespace = { rootId: TODO_ROOT_ID, prefix: 'todo:' };

export const INBOX_TREE: VirtualTreeNamespace = { rootId: INBOX_ROOT_ID, prefix: 'inbox:' };

const TREES: readonly VirtualTreeNamespace[] = [CALENDAR_TREE, TODO_TREE, INBOX_TREE];

export const TREE_ROW_INDENT_BASE = 6;
export const TREE_ROW_INDENT_STEP = 13;

export function treeRowIndent(level: number): number {
    return TREE_ROW_INDENT_BASE + level * TREE_ROW_INDENT_STEP;
}

export function virtualTreeRowIndent(depth: number): number {
    return treeRowIndent(depth + 1);
}

export function splitTodoTags(tagText: string): string[] {
    return tagText.split(',').map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean);
}

export function resolveTodoTag(pref: string | null | undefined): string {
    return pref?.trim() || t("sidebar.todo_default_tag");
}

function matchesNamespace(id: string | null | undefined, ns: VirtualTreeNamespace): boolean {
    return id === ns.rootId || Boolean(id?.startsWith(ns.prefix));
}

export function isCalendarFolderId(id: string | null | undefined): boolean {
    return matchesNamespace(id, CALENDAR_TREE);
}

export function isTodoFolderId(id: string | null | undefined): boolean {
    return matchesNamespace(id, TODO_TREE);
}

export function isInboxFolderId(id: string | null | undefined): boolean {
    return matchesNamespace(id, INBOX_TREE);
}

export function isVirtualFolderId(id: string | null | undefined): boolean {
    return TREES.some((tree) => matchesNamespace(id, tree));
}

export function virtualId(period: CalendarPeriod, ns: VirtualTreeNamespace): string {
    switch (period.kind) {
        case 'root':
            return ns.rootId;
        case 'year':
            return `${ns.prefix}${period.year}`;
        case 'quarter':
            return `${ns.prefix}${period.year}:q${period.quarter}`;
        case 'month':
            return `${ns.prefix}${period.year}:q${quarterOfMonth(period.month)}:${String(period.month).padStart(2, '0')}`;
        case 'week':
            return `${ns.prefix}${period.year}:q${quarterOfMonth(period.month)}:${String(period.month).padStart(2, '0')}:w${String(period.week).padStart(2, '0')}`;
    }
}

export function parseVirtualId(id: string | null | undefined, ns: VirtualTreeNamespace): CalendarPeriod | null {
    if (!id)
        return null;
    if (id === ns.rootId)
        return { kind: 'root' };
    if (!id.startsWith(ns.prefix))
        return null;
    const parts = id.slice(ns.prefix.length).split(':');
    if (parts.length < 1 || parts.length > 4)
        return null;
    if (!/^\d{4}$/.test(parts[0] ?? ''))
        return null;
    const year = Number(parts[0]);
    if (parts.length === 1)
        return { kind: 'year', year };
    const quarter = quarterOfPart(parts[1]);
    if (quarter === null)
        return null;
    if (parts.length === 2)
        return { kind: 'quarter', year, quarter };
    const month = monthOfPart(parts[2]);
    if (month === null)
        return null;
    if (parts.length === 3)
        return { kind: 'month', year, month };
    const week = Number(/^w(\d{2})$/.exec(parts[3] ?? '')?.[1]);
    if (!Number.isInteger(week) || week < 1 || week > 53)
        return null;
    return { kind: 'week', year, month, week };
}

function quarterOfPart(part: string | undefined): number | null {
    const match = /^q([1-4])$/.exec(part ?? '');
    return match ? Number(match[1]) : null;
}

function monthOfPart(part: string | undefined): number | null {
    const match = /^(0[1-9]|1[0-2])$/.exec(part ?? '');
    return match ? Number(match[1]) : null;
}

export function quarterOfMonth(month: number): number {
    return Math.floor((month - 1) / 3) + 1;
}
