import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createElement } from 'react';
import { installTestGlobals, renderElement } from '../../lib/test-render';
import { Outline, getHeadingTypography, getHeadingIcon } from './Outline';
import type { Heading } from '../../lib/markdown/renderer';
import { Heading1, Heading2, Heading3, Heading4, Heading5, Heading6 } from 'lucide-react';

installTestGlobals();

const FOUR_LEVEL_HEADINGS: Heading[] = [
    { level: 1, text: 'Chapter 1', slug: 'chapter-1', line: 1 },
    { level: 2, text: 'Section 1.1', slug: 'section-1-1', line: 5 },
    { level: 3, text: 'Detail 1.1.1', slug: 'detail-1-1-1', line: 10 },
    { level: 4, text: 'Note A', slug: 'note-a', line: 15 },
];

const SKIPPED_LEVEL_HEADINGS: Heading[] = [
    { level: 1, text: 'Topic 1', slug: 'topic-1', line: 1 },
    { level: 3, text: 'Subtopic 1', slug: 'subtopic-1', line: 5 },
];

const BRANCH_HEADINGS: Heading[] = [
    { level: 1, text: 'Alpha', slug: 'alpha', line: 1 },
    { level: 2, text: 'Beta', slug: 'beta', line: 5 },
    { level: 2, text: 'Gamma', slug: 'gamma', line: 9 },
];

/** jsdom loads no locale bundle, so t() falls back to the key; tests match on that. */
const KEY = {
    search: 'outline.toggle_search',
    regex: 'outline.regex',
    matchCount: 'outline.match_count',
    noMatches: 'outline.no_matches',
};

function expectTypography(level: number, isActive: boolean, expected: {
    fontSize?: string;
    fontWeight?: string;
    iconSize?: number;
    textColor?: string;
    iconColor?: string;
}): void {
    const actual = getHeadingTypography(level, isActive);
    if (expected.fontSize) expect(actual.fontSize).toBe(expected.fontSize);
    if (expected.fontWeight) expect(actual.fontWeight).toBe(expected.fontWeight);
    if (expected.iconSize) expect(actual.iconSize).toBe(expected.iconSize);
    if (expected.textColor) expect(actual.textColor).toContain(expected.textColor);
    if (expected.iconColor) expect(actual.iconColor).toContain(expected.iconColor);
}

function renderOutline(headings: Heading[], onSelect = vi.fn(), props: Record<string, unknown> = {}) {
    return renderElement(createElement(Outline, { headings, onSelect, noteId: 'n1', ...props }));
}

async function click(element: HTMLElement): Promise<void> {
    await act(async () => { element.click(); });
}

function rowButtons(container: HTMLElement): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('li[data-heading-level] button[data-slug]')];
}

function slugs(container: HTMLElement): string[] {
    return rowButtons(container).map((button) => button.getAttribute('data-slug') ?? '');
}

function indentOf(button: HTMLButtonElement): string {
    const row = button.closest('div[style*="padding-left"]') as HTMLElement | null;
    return row?.style.paddingLeft ?? '';
}

function chevronFor(container: HTMLElement, slug: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`button[data-slug="${slug}"]`);
    const row = button?.closest('div[style*="padding-left"]') as HTMLElement | null;
    const chevron = row?.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!chevron) throw new Error(`no chevron rendered for ${slug}`);
    return chevron;
}

function hasChevron(container: HTMLElement, slug: string): boolean {
    const button = container.querySelector<HTMLButtonElement>(`button[data-slug="${slug}"]`);
    const row = button?.closest('div[style*="padding-left"]') as HTMLElement | null;
    return Boolean(row?.querySelector('button[aria-expanded]'));
}

function levelButtons(container: HTMLElement): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
}

async function openSearch(container: HTMLElement): Promise<HTMLInputElement> {
    await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${KEY.search}"]`)!);
    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error('search input did not open');
    return input;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('Outline heading typography and icon mapping', () => {
    it('maps levels to corresponding Lucide heading icons', () => {
        expect(getHeadingIcon(1)).toBe(Heading1);
        expect(getHeadingIcon(2)).toBe(Heading2);
        expect(getHeadingIcon(3)).toBe(Heading3);
        expect(getHeadingIcon(4)).toBe(Heading4);
        expect(getHeadingIcon(5)).toBe(Heading5);
        expect(getHeadingIcon(6)).toBe(Heading6);
        expect(getHeadingIcon(99)).toBe(Heading6);
    });

    it('maps level 1 and 2 typography', () => {
        expectTypography(1, false, { fontSize: 'text-[length:var(--text-13)]', fontWeight: 'font-semibold', iconSize: 12.5, textColor: 'var(--text-secondary)' });
        expectTypography(1, true, { fontSize: 'text-[length:var(--text-13)]', fontWeight: 'font-semibold', textColor: 'var(--accent)', iconColor: 'var(--accent)' });
        expectTypography(2, false, { fontSize: 'text-[length:var(--text-12)]', fontWeight: 'font-medium', iconSize: 11.5 });
        expectTypography(2, true, { fontSize: 'text-[length:var(--text-12)]', fontWeight: 'font-semibold' });
    });

    it('maps level 3 and 4 typography', () => {
        expectTypography(3, false, { fontSize: 'text-[length:var(--text-11-5)]', fontWeight: 'font-normal', iconSize: 11 });
        expectTypography(3, true, { fontSize: 'text-[length:var(--text-11-5)]', fontWeight: 'font-medium' });
        expectTypography(4, false, { fontSize: 'text-[length:var(--text-11)]', fontWeight: 'font-normal', iconSize: 10.5 });
        expectTypography(4, true, { fontSize: 'text-[length:var(--text-11)]', fontWeight: 'font-medium' });
    });

    it('maps level 5 and 6 typography', () => {
        expectTypography(5, false, { fontSize: 'text-[length:var(--text-10-5)]', fontWeight: 'font-normal' });
        expectTypography(6, false, { fontSize: 'text-[length:var(--text-10-5)]', fontWeight: 'font-normal' });
    });
});

describe('Outline rendering', () => {
    it('returns null when headings array is empty', () => {
        const { container, unmount } = renderOutline([]);
        expect(container.firstChild).toBeNull();
        unmount();
    });

    it('renders one row per heading carrying its level, icon and typography', () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS);
        const rows = [...container.querySelectorAll('li[data-heading-level]')];
        expect(rows.map((row) => row.getAttribute('data-heading-level'))).toEqual(['1', '2', '3', '4']);
        expect(container.querySelectorAll('li[data-heading-level] button[data-slug] svg').length).toBe(4);
        const buttons = rowButtons(container);
        expect(buttons[0]!.classList.contains('text-[length:var(--text-13)]')).toBe(true);
        expect(buttons[1]!.classList.contains('text-[length:var(--text-12)]')).toBe(true);
        expect(buttons[3]!.classList.contains('text-[length:var(--text-11)]')).toBe(true);
        unmount();
    });

    it('indents by visual tier, so a skipped level only steps in once', () => {
        const { container, unmount } = renderOutline(SKIPPED_LEVEL_HEADINGS);
        const buttons = rowButtons(container);
        expect(indentOf(buttons[0]!)).toBe('8px');
        expect(indentOf(buttons[1]!)).toBe('18px');
        unmount();
    });

    it('indents a four-level chain one step per tier', () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS);
        expect(rowButtons(container).map(indentOf)).toEqual(['8px', '18px', '28px', '38px']);
        unmount();
    });

    it('gives a chevron only to rows that actually have children', () => {
        const { container, unmount } = renderOutline(BRANCH_HEADINGS);
        expect(hasChevron(container, 'alpha')).toBe(true);
        expect(hasChevron(container, 'beta')).toBe(false);
        expect(hasChevron(container, 'gamma')).toBe(false);
        unmount();
    });

    it('jumps to the heading whose row was clicked', async () => {
        const onSelect = vi.fn();
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS, onSelect);
        await click(rowButtons(container)[1]!);
        expect(onSelect).toHaveBeenCalledWith(FOUR_LEVEL_HEADINGS[1]);
        unmount();
    });

    it('adds margin-top on subsequent H1 headings for section separation', () => {
        const { container, unmount } = renderOutline([
            { level: 1, text: 'First', slug: 'first', line: 1 },
            { level: 2, text: 'Sub', slug: 'sub', line: 2 },
            { level: 1, text: 'Second', slug: 'second', line: 3 },
        ]);
        const rows = container.querySelectorAll('li[data-heading-level]');
        expect(rows[0]!.classList.contains('mt-1.5')).toBe(false);
        expect(rows[2]!.classList.contains('mt-1.5')).toBe(true);
        unmount();
    });
});

describe('Outline collapsing', () => {
    it('hides a subtree when its parent chevron is clicked', async () => {
        const { container, unmount } = renderOutline(BRANCH_HEADINGS);
        expect(slugs(container)).toEqual(['alpha', 'beta', 'gamma']);
        await click(chevronFor(container, 'alpha'));
        expect(slugs(container)).toEqual(['alpha']);
        unmount();
    });

    it('reveals the subtree again on a second click', async () => {
        const { container, unmount } = renderOutline(BRANCH_HEADINGS);
        await click(chevronFor(container, 'alpha'));
        expect(slugs(container)).toEqual(['alpha']);
        await click(chevronFor(container, 'alpha'));
        expect(slugs(container)).toEqual(['alpha', 'beta', 'gamma']);
        unmount();
    });

    it('opens only the top level when defaultLevel is 1', () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS, vi.fn(), { defaultLevel: 1 });
        expect(slugs(container)).toEqual(['chapter-1']);
        unmount();
    });

    it('opens everything when defaultLevel is left at its widest', () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS, vi.fn(), { defaultLevel: 6 });
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1', 'detail-1-1-1', 'note-a']);
        unmount();
    });

    it('collapses to a chosen level from the toolbar', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS);
        const toolbar = levelButtons(container);
        expect(toolbar.length).toBe(4);
        await click(toolbar[1]!);
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1']);
        expect(levelButtons(container)[1]!.getAttribute('aria-pressed')).toBe('true');
        unmount();
    });

    it('keeps expansion across an unrelated heading being added', async () => {
        const { container, unmount, rerender } = renderOutline(BRANCH_HEADINGS);
        await click(chevronFor(container, 'alpha'));
        expect(slugs(container)).toEqual(['alpha']);
        rerender(createElement(Outline, {
            headings: [...BRANCH_HEADINGS, { level: 2, text: 'Delta', slug: 'delta', line: 12 }],
            onSelect: vi.fn(),
            noteId: 'n1',
        }));
        expect(slugs(container)).toEqual(['alpha']);
        unmount();
    });

    it('resets expansion when a different note is shown', async () => {
        const { container, unmount, rerender } = renderOutline(BRANCH_HEADINGS);
        await click(chevronFor(container, 'alpha'));
        expect(slugs(container)).toEqual(['alpha']);
        rerender(createElement(Outline, { headings: BRANCH_HEADINGS, onSelect: vi.fn(), noteId: 'n2', defaultLevel: 6 }));
        expect(slugs(container)).toEqual(['alpha', 'beta', 'gamma']);
        unmount();
    });
});

describe('Outline filtering', () => {
    it('shows only matches and the ancestors leading to them', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS);
        await type(await openSearch(container), 'note a');
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1', 'detail-1-1-1', 'note-a']);
        unmount();
    });

    it('drops branches that hold no match', async () => {
        const { container, unmount } = renderOutline([
            { level: 1, text: 'Keep', slug: 'keep', line: 1 },
            { level: 2, text: 'Keeper', slug: 'keeper', line: 2 },
            { level: 1, text: 'Drop', slug: 'drop', line: 3 },
        ]);
        await type(await openSearch(container), 'keep');
        expect(slugs(container)).toEqual(['keep', 'keeper']);
        unmount();
    });

    it('reports a match count separate from the rows drawn', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS);
        await type(await openSearch(container), 'detail');
        expect(container.textContent).toContain(KEY.matchCount);
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1', 'detail-1-1-1']);
        unmount();
    });

    it('says so when nothing matches', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS);
        await type(await openSearch(container), 'zzzz');
        expect(container.textContent).toContain(KEY.noMatches);
        expect(rowButtons(container).length).toBe(0);
        unmount();
    });

    it('matches a regular expression when the regex switch is on', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS);
        const input = await openSearch(container);
        await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${KEY.regex}"]`)!);
        await type(input, '^chapter');
        expect(slugs(container)).toEqual(['chapter-1']);
        unmount();
    });

    it('keeps every row visible while the expression is still unparseable', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS);
        const input = await openSearch(container);
        await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${KEY.regex}"]`)!);
        await type(input, '^chapter(');
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1', 'detail-1-1-1', 'note-a']);
        unmount();
    });
});
