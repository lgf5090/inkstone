import type { ResolvedProperty } from '@shared/property-style';

export const PP_SHELL = 'pp-shell mb-4 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]';
export const PP_SHELL_QUIET = 'pp-shell-quiet';
export const PP_LAYOUT = 'pp-layout';
export const PP_COLUMN = 'pp-column min-w-0 flex-1';
export const PP_ICON_ROW = 'pp-icon-row';
export const PP_HEADER = 'pp-header flex h-9 items-center gap-2 border-b border-[var(--border-subtle)] px-2.5';
export const PP_HEADER_BUTTON = 'pp-header-toggle flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] font-semibold text-[var(--text-secondary)]';
export const PP_TITLE = 'truncate';
export const PP_COUNT = 'pp-count shrink-0 tabular text-[var(--text-quaternary)]';
export const PP_ROWS = 'divide-y divide-[var(--border-subtle)]';
export const PP_ROW = 'pp-row flex items-start gap-2 px-2.5 py-1.5';
export const PP_ROW_HIDDEN = 'pp-row-hidden';
export const PP_KEY_CELL = 'flex min-w-0 flex-1 items-start gap-1.5';
export const PP_KIND = 'pp-kind mt-0.5 w-3 shrink-0 text-center text-[10.5px] text-[var(--text-quaternary)]';
export const PP_KEY = 'pp-key shrink-0 rounded px-0.5 text-left text-[12px] text-[var(--text-tertiary)]';
export const PP_VALUE = 'pp-value flex min-w-0 max-w-[62%] flex-1 items-center justify-end gap-1';
export const PP_VALUE_INNER = 'flex min-w-0 items-center justify-end gap-1.5';
export const PP_SCALAR = 'pp-scalar min-w-0 truncate rounded px-1 py-0.5 text-right text-[12px] text-[var(--text-primary)]';
export const PP_MARKDOWN = 'pp-markdown min-w-0 truncate rounded px-1 py-0.5 text-right text-[12px] text-[var(--text-primary)]';
export const PP_OBJECT = 'pp-object min-w-0 truncate text-right text-[12px] text-[var(--text-tertiary)]';
export const PP_PILL = 'pp-pill flex max-w-full items-center overflow-hidden rounded-[var(--r-sm)]';
export const PP_PILLS = 'pp-pills flex min-w-0 flex-wrap items-center justify-end gap-1';
export const PP_PILL_TEXT = 'min-w-0 truncate py-0.5 pl-1.5 text-[11.5px] text-[var(--text-primary)]';
export const PP_PILL_THEME = 'bg-[var(--accent-soft)]';
export const PP_PILL_HASH = 'text-[var(--text-quaternary)]';
export const PP_SWITCH = 'pp-switch relative h-4 w-8 shrink-0 rounded-full transition-colors';
export const PP_SWITCH_ON = 'bg-[var(--accent)]';
export const PP_SWITCH_OFF = 'bg-[var(--bg-inset)] ring-1 ring-[var(--border-default)]';
export const PP_SWITCH_KNOB = 'absolute top-0.5 size-3 rounded-full bg-white shadow transition-all';
export const PP_SWITCH_KNOB_ON = 'left-4';
export const PP_SWITCH_KNOB_OFF = 'left-0.5';
export const PP_NOTE = 'px-3 py-2.5 text-[11.5px] text-[var(--text-quaternary)]';
export const PP_NOTE_DANGER = 'px-3 py-2.5 text-[11.5px] text-[var(--danger)]';

export function propertyKindGlyph(row: Pick<ResolvedProperty, 'kind' | 'dateShape'>): string {
    if (row.kind === 'boolean')
        return '✓';
    if (row.kind === 'tags' || row.kind === 'array')
        return '#';
    if (row.kind === 'number')
        return '1';
    return row.dateShape ? 'D' : 'T';
}

export function propertyRowCount(rows: Pick<ResolvedProperty, 'hidden'>[]): number {
    return rows.filter(row => !row.hidden).length;
}
