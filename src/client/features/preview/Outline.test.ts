import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createElement } from 'react';
import { installTestGlobals, renderElement } from '../../lib/test-render';
import { useUi } from '../../store/ui';
import { __resetOutlineHeadings, outlineHeadingsFor } from './outline-registry';
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

describe('Outline palette commands', () => {
    async function send(action: string): Promise<void> {
        await act(async () => { useUi.getState().sendOutlineCommand(action as never); });
    }

    it('expands and collapses one level at a time', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS, vi.fn(), { defaultLevel: 6 });
        expect(slugs(container)).toHaveLength(4);
        await send('level-down');
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1', 'detail-1-1-1']);
        await send('level-down');
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1']);
        await send('level-down');
        expect(slugs(container)).toEqual(['chapter-1']);
        await send('level-up');
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1']);
        unmount();
    });

    it('clamps stepping at the widest level present', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS, vi.fn(), { defaultLevel: 1 });
        expect(slugs(container)).toEqual(['chapter-1']);
        await send('level-up');
        await send('level-up');
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1', 'detail-1-1-1']);
        await send('level-up');
        expect(slugs(container)).toHaveLength(4);
        await send('level-up');
        expect(slugs(container)).toHaveLength(4);
        unmount();
    });

    it('collapses everything then expands everything', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS);
        await send('collapse-all');
        expect(slugs(container)).toEqual(['chapter-1']);
        await send('expand-all');
        expect(slugs(container)).toHaveLength(4);
        unmount();
    });

    it('returns to the configured default level', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS, vi.fn(), { defaultLevel: 2 });
        await send('expand-all');
        expect(slugs(container)).toHaveLength(4);
        await send('reset-level');
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1']);
        unmount();
    });

    it('opens and focuses the filter box', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS);
        expect(container.querySelector('input[type="search"]')).toBeNull();
        await send('focus-search');
        const input = container.querySelector<HTMLInputElement>('input[type="search"]');
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);
        unmount();
    });

    it('ignores a command replayed with the same sequence number', async () => {
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS, vi.fn(), { defaultLevel: 6 });
        await send('collapse-all');
        expect(slugs(container)).toEqual(['chapter-1']);
        await act(async () => { /* re-render without a new command */ });
        expect(slugs(container)).toEqual(['chapter-1']);
        unmount();
    });
});

describe('Outline note switching', () => {
    function renderWithNote(headings: Heading[], noteId: string, props: Record<string, unknown> = {}) {
        return renderElement(createElement(Outline, { headings, onSelect: vi.fn(), noteId, ...props }));
    }

    it('clears the filter when the note changes and keep-search is off', async () => {
        const { container, unmount, rerender } = renderWithNote(FOUR_LEVEL_HEADINGS, 'n1');
        await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${KEY.search}"]`)!);
        await type(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'detail');
        expect(container.querySelectorAll('button[data-slug]').length).toBe(3);
        rerender(createElement(Outline, { headings: BRANCH_HEADINGS, onSelect: vi.fn(), noteId: 'n2' }));
        const input = container.querySelector<HTMLInputElement>('input[type="search"]');
        expect(input?.value ?? '').toBe('');
        expect(slugs(container)).toEqual(['alpha', 'beta', 'gamma']);
        unmount();
    });

    it('keeps the filter across a note change when keep-search is on', async () => {
        const { container, unmount, rerender } = renderWithNote(FOUR_LEVEL_HEADINGS, 'n1', { keepSearch: true });
        await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${KEY.search}"]`)!);
        await type(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'eta');
        // Only "Detail 1.1.1" carries the substring; its two ancestors stay drawn as the path to it.
        expect(slugs(container)).toEqual(['chapter-1', 'section-1-1', 'detail-1-1-1']);
        rerender(createElement(Outline, { headings: BRANCH_HEADINGS, onSelect: vi.fn(), noteId: 'n2', keepSearch: true }));
        expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('eta');
        expect(slugs(container)).toEqual(['alpha', 'beta']);
        unmount();
    });

    it('lets an override win over the scroll reading', () => {
        const { container, unmount, rerender } = renderWithNote(FOUR_LEVEL_HEADINGS, 'n1', { activeOverride: 'detail-1-1-1' });
        expect(container.querySelector('button[aria-current="location"]')!.getAttribute('data-slug')).toBe('detail-1-1-1');
        rerender(createElement(Outline, { headings: FOUR_LEVEL_HEADINGS, onSelect: vi.fn(), noteId: 'n1' }));
        expect(container.querySelector('button[aria-current="location"]')).toBeNull();
        unmount();
    });

    it('publishes the active note outline for the clipboard commands', () => {
        __resetOutlineHeadings();
        expect(outlineHeadingsFor('n1')).toEqual([]);
        const { unmount } = renderWithNote(BRANCH_HEADINGS, 'n1');
        expect(outlineHeadingsFor('n1').map((h) => h.slug)).toEqual(['alpha', 'beta', 'gamma']);
        expect(outlineHeadingsFor('other')).toEqual([]);
        unmount();
        expect(outlineHeadingsFor('n1')).toEqual([]);
    });
});

const MENU_DOC = '# Alpha\n\nbody a\n\n## Beta\n\nbody b\n';
/** Line numbers must agree with MENU_DOC or a section edit lands on a blank line. */
const MENU_HEADINGS: Heading[] = [
    { level: 1, text: 'Alpha', slug: 'alpha', line: 0 },
    { level: 2, text: 'Beta', slug: 'beta', line: 4 },
];

describe('Outline row menu', () => {
    async function openMenu(container: HTMLElement, slug: string): Promise<void> {
        const button = container.querySelector<HTMLButtonElement>(`button[data-slug="${slug}"]`)!;
        await act(async () => {
            button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
        });
    }

    function menuItem(root: ParentNode, label: string): HTMLElement | undefined {
        return [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes(label));
    }

    it('offers rename and the copy variants on a right click', async () => {
        const { container, unmount } = renderOutline(MENU_HEADINGS, vi.fn(), { content: MENU_DOC, onContentChange: vi.fn() });
        await openMenu(container, 'alpha');
        const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? '');
        expect(labels.some((l) => l.includes('outline.rename'))).toBe(true);
        expect(labels.filter((l) => l.includes('outline.copy')).length).toBe(5);
        expect(labels.some((l) => l.includes('outline.delete_section'))).toBe(true);
        unmount();
    });

    it('hides the editing entries when the body is not supplied', async () => {
        const { container, unmount } = renderOutline(BRANCH_HEADINGS);
        await openMenu(container, 'alpha');
        const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? '');
        expect(labels.some((l) => l.includes('outline.rename'))).toBe(false);
        expect(labels.some((l) => l.includes('outline.delete_section'))).toBe(false);
        expect(labels.some((l) => l.includes('outline.copy_heading'))).toBe(true);
        unmount();
    });

    it('rewrites the heading line through onContentChange when demoting one level', async () => {
        const onContentChange = vi.fn();
        const { container, unmount } = renderOutline(MENU_HEADINGS, vi.fn(), { content: MENU_DOC, onContentChange });
        await openMenu(container, 'beta');
        await click(menuItem(document, 'outline.demote_level')!);
        expect(onContentChange).toHaveBeenCalledTimes(1);
        expect(onContentChange.mock.calls[0][0]).toBe('# Alpha\n\nbody a\n\n### Beta\n\nbody b\n');
        unmount();
    });

    it('rewrites the whole section for the recursive variant', async () => {
        const onContentChange = vi.fn();
        const { container, unmount } = renderOutline(MENU_HEADINGS, vi.fn(), { content: MENU_DOC, onContentChange });
        await openMenu(container, 'alpha');
        await click(menuItem(document, 'outline.promote_level_recursively')!);
        // Alpha cannot promote past level 1, so only Beta moves.
        expect(onContentChange.mock.calls[0][0]).toBe('# Alpha\n\nbody a\n\n# Beta\n\nbody b\n');
        unmount();
    });

    it('commits a rename from Enter and not from blur afterwards', async () => {
        const onContentChange = vi.fn();
        const { container, unmount } = renderOutline(MENU_HEADINGS, vi.fn(), { content: MENU_DOC, onContentChange });
        const beta = container.querySelector<HTMLButtonElement>('button[data-slug="beta"]')!;
        await act(async () => { beta.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
        const input = container.querySelector<HTMLInputElement>('input[aria-label="outline.rename"]');
        expect(input).not.toBeNull();
        input!.value = 'Renamed';
        await act(async () => {
            input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        expect(onContentChange).toHaveBeenCalledTimes(1);
        expect(onContentChange.mock.calls[0][0]).toContain('## Renamed');
        unmount();
    });

    it('cancels a rename on Escape without touching the body', async () => {
        const onContentChange = vi.fn();
        const { container, unmount } = renderOutline(MENU_HEADINGS, vi.fn(), { content: MENU_DOC, onContentChange });
        await act(async () => {
            container.querySelector<HTMLButtonElement>('button[data-slug="beta"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });
        const input = container.querySelector<HTMLInputElement>('input[aria-label="outline.rename"]')!;
        input.value = 'Changed';
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        expect(onContentChange).not.toHaveBeenCalled();
        expect(container.querySelector('input[aria-label="outline.rename"]')).toBeNull();
        unmount();
    });

    it('copies the heading with its section to the clipboard', async () => {
        const written: string[] = [];
        const previous = navigator.clipboard;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
        const { container, unmount } = renderOutline(MENU_HEADINGS, vi.fn(), { content: MENU_DOC, onContentChange: vi.fn() });
        await openMenu(container, 'alpha');
        await click(menuItem(document, 'outline.copy_with_content')!);
        // Alpha is the only level-1 heading, so its section runs to the end of the document.
        expect(written).toEqual([MENU_DOC]);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: previous });
        unmount();
    });
});

describe('Outline drag to move', () => {
    const DRAG_DOC = '# One\n\nbody one\n\n## Two\n\nbody two\n';
    const DRAG_HEADINGS: Heading[] = [
        { level: 1, text: 'One', slug: 'one', line: 0 },
        { level: 2, text: 'Two', slug: 'two', line: 4 },
    ];

    /** jsdom has no layout, so the band is chosen by stubbing the row rect and the pointer Y. */
    async function dragOnto(container: HTMLElement, fromSlug: string, toSlug: string, clientY = 15): Promise<void> {
        const from = container.querySelector<HTMLLIElement>(`button[data-slug="${fromSlug}"]`)!.closest('li')!;
        const to = container.querySelector<HTMLLIElement>(`button[data-slug="${toSlug}"]`)!.closest('li')!;
        const previous = window.HTMLElement.prototype.getBoundingClientRect;
        window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, height: 30 } as DOMRect);
        try {
            await act(async () => { from.dispatchEvent(new Event('dragstart', { bubbles: true })); });
            await act(async () => { to.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY })); });
            await act(async () => { to.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientY })); });
        }
        finally {
            window.HTMLElement.prototype.getBoundingClientRect = previous;
        }
    }

    it('marks rows draggable only when the setting is on', () => {
        const off = renderOutline(DRAG_HEADINGS, vi.fn(), { content: DRAG_DOC, onContentChange: vi.fn() });
        expect(off.container.querySelector('button[data-slug="one"]')!.closest('li')!.draggable).toBe(false);
        off.unmount();
        const on = renderOutline(DRAG_HEADINGS, vi.fn(), { content: DRAG_DOC, onContentChange: vi.fn(), dragEdits: true });
        expect(on.container.querySelector('button[data-slug="one"]')!.closest('li')!.draggable).toBe(true);
        on.unmount();
    });

    it('rewrites the body through moveSection on drop', async () => {
        const onContentChange = vi.fn();
        const { container, unmount } = renderOutline(DRAG_HEADINGS, vi.fn(), { content: DRAG_DOC, onContentChange, dragEdits: true });
        await dragOnto(container, 'two', 'one', 5);
        expect(onContentChange).toHaveBeenCalledTimes(1);
        // clientY 5 of a 30px row is the top band, so Two lands ahead of One and re-levels to One's rank.
        expect(onContentChange.mock.calls[0][0]).toBe('# Two\n\nbody two\n\n# One\n\nbody one\n');
        unmount();
    });

    it('shows a drop hint on the hovered row and clears it on dragend', async () => {
        const { container, unmount } = renderOutline(DRAG_HEADINGS, vi.fn(), { content: DRAG_DOC, onContentChange: vi.fn(), dragEdits: true });
        const from = container.querySelector('button[data-slug="two"]')!.closest('li')!;
        const to = container.querySelector('button[data-slug="one"]')!.closest('li')!;
        await act(async () => { from.dispatchEvent(new Event('dragstart', { bubbles: true })); });
        await act(async () => { to.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true })); });
        expect(to.querySelector('[data-drop-hint]')).not.toBeNull();
        await act(async () => { from.dispatchEvent(new Event('dragend', { bubbles: true })); });
        expect(container.querySelector('[data-drop-hint]')).toBeNull();
        unmount();
    });

    it('ignores a drop back onto the row being dragged', async () => {
        const onContentChange = vi.fn();
        const { container, unmount } = renderOutline(DRAG_HEADINGS, vi.fn(), { content: DRAG_DOC, onContentChange, dragEdits: true });
        await dragOnto(container, 'one', 'one');
        expect(onContentChange).not.toHaveBeenCalled();
        unmount();
    });

    it('refuses to move a parent inside its own section without touching the body', async () => {
        const onContentChange = vi.fn();
        const nested: Heading[] = [
            { level: 1, text: 'One', slug: 'one', line: 0 },
            { level: 2, text: 'Two', slug: 'two', line: 2 },
        ];
        const { container, unmount } = renderOutline(nested, vi.fn(), { content: '# One\n\n## Two\n', onContentChange, dragEdits: true });
        await dragOnto(container, 'one', 'two');
        expect(onContentChange).not.toHaveBeenCalled();
        unmount();
    });
});

describe('Outline reading preferences', () => {
    const NESTED: Heading[] = [
        { level: 1, text: 'Alpha', slug: 'alpha', line: 0 },
        { level: 2, text: 'Beta', slug: 'beta', line: 2 },
        { level: 3, text: 'Gamma', slug: 'gamma', line: 4 },
    ];

    it('truncates the row text to the limit plus one ellipsis', () => {
        const { container, unmount } = renderOutline([{ level: 1, text: 'A very long heading indeed', slug: 'long', line: 0 }], vi.fn(), { truncateLength: 10 });
        expect(container.querySelector('button[data-slug="long"]')!.textContent).toBe('A very lo…');
        unmount();
    });

    it('leaves the row text whole when truncation is off', () => {
        const { container, unmount } = renderOutline([{ level: 1, text: 'A very long heading indeed', slug: 'long', line: 0 }]);
        expect(container.querySelector('button[data-slug="long"]')!.textContent).toBe('A very long heading indeed');
        unmount();
    });

    it('does not auto-expand ancestors by default', async () => {
        const { container, unmount } = renderOutline(NESTED, vi.fn(), { defaultLevel: 1 });
        expect(slugs(container)).toEqual(['alpha']);
        await act(async () => { useUi.setState({ outlineCommand: { action: 'expand-all', seq: 9001 } }); });
        await act(async () => { useUi.setState({ outlineCommand: { action: 'collapse-all', seq: 9002 } }); });
        expect(slugs(container)).toEqual(['alpha']);
        unmount();
    });

    it('reveals the ancestors of a newly active heading when auto-expand is on', async () => {
        // Only the active heading changes here: no expand command is sent, so a missing
        // auto-expand rule leaves the tree folded and this test red.
        const { container, unmount, rerender } = renderOutline(NESTED, vi.fn(), { defaultLevel: 1, autoExpand: 'ancestors' });
        expect(slugs(container)).toEqual(['alpha']);
        rerender(createElement(Outline, { headings: NESTED, onSelect: vi.fn(), noteId: 'n1', defaultLevel: 1, autoExpand: 'ancestors', activeOverride: 'gamma' }));
        expect(slugs(container)).toEqual(['alpha', 'beta', 'gamma']);
        unmount();
    });

    it('keeps a sibling branch folded while auto-expanding', async () => {
        // Opening Alpha must reveal both its children, but Delta stays folded so Epsilon
        // stays hidden: only the ancestors of the active row are pulled open.
        const FIVE: Heading[] = [
            { level: 1, text: 'Alpha', slug: 'alpha', line: 0 },
            { level: 2, text: 'Beta', slug: 'beta', line: 2 },
            { level: 3, text: 'Gamma', slug: 'gamma', line: 4 },
            { level: 2, text: 'Delta', slug: 'delta', line: 6 },
            { level: 3, text: 'Epsilon', slug: 'epsilon', line: 8 },
        ];
        const { container, unmount, rerender } = renderOutline(FIVE, vi.fn(), { defaultLevel: 1, autoExpand: 'ancestors' });
        expect(slugs(container)).toEqual(['alpha']);
        rerender(createElement(Outline, { headings: FIVE, onSelect: vi.fn(), noteId: 'n1', defaultLevel: 1, autoExpand: 'ancestors', activeOverride: 'gamma' }));
        expect(slugs(container)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
        unmount();
    });
});

describe('Outline markdown labels', () => {
    const MD_HEADINGS: Heading[] = [
        { level: 1, text: 'Bold Ship', slug: 'ship', line: 0 },
        { level: 2, text: 'Plain', slug: 'plain', line: 4 },
    ];
    const MD_BODY = '# **Bold** Ship\n\nbody\n\n## Plain\n';

    function labelSpan(container: HTMLElement, slug: string): HTMLElement {
        return container.querySelector<HTMLButtonElement>(`button[data-slug="${slug}"]`)!.querySelector('span:last-child')!;
    }

    it('renders the emphasis written in the heading line', () => {
        const { container, unmount } = renderOutline(MD_HEADINGS, vi.fn(), { content: MD_BODY, markdownLabels: true });
        expect(labelSpan(container, 'ship').getAttribute('data-outline-markup')).toBe('true');
        expect(labelSpan(container, 'ship').innerHTML).toBe('<strong>Bold</strong> Ship');
        unmount();
    });

    it('stays on the parsed plain text while the preference is off', () => {
        const { container, unmount } = renderOutline(MD_HEADINGS, vi.fn(), { content: MD_BODY });
        expect(container.querySelector('[data-outline-markup]')).toBeNull();
        expect(labelSpan(container, 'ship').textContent).toBe('Bold Ship');
        unmount();
    });

    it('falls back to plain text for a heading the source line cannot supply', () => {
        const { container, unmount } = renderOutline(MD_HEADINGS, vi.fn(), { content: 'Just a title\n----------\n', markdownLabels: true });
        expect(container.querySelector('[data-outline-markup]')).toBeNull();
        expect(labelSpan(container, 'ship').textContent).toBe('Bold Ship');
        unmount();
    });

    it('truncates the markdown source rather than the rendered markup', () => {
        const { container, unmount } = renderOutline(MD_HEADINGS, vi.fn(), { content: MD_BODY, markdownLabels: true, truncateLength: 8 });
        const span = labelSpan(container, 'ship');
        expect(span.textContent).not.toContain('Ship');
        expect(span.innerHTML).not.toContain('<strong>');
        unmount();
    });

    it('keeps the untitled label when markdown renders away to nothing', () => {
        const { container, unmount } = renderOutline([{ level: 1, text: '', slug: 'math', line: 0 }], vi.fn(), { content: '# $x^2$', markdownLabels: true });
        expect(container.querySelector('[data-outline-markup]')).toBeNull();
        expect(labelSpan(container, 'math').textContent).toBe('preview.untitled');
        unmount();
    });
});

describe('Outline reading time footer', () => {
    const ONE: Heading[] = [{ level: 1, text: 'One', slug: 'one', line: 0 }];

    it('renders the estimate row when the preference is on', () => {
        const { container, unmount } = renderOutline(ONE, vi.fn(), { showReadingTime: true, wordCount: 450, readingSpeed: 300 });
        expect(container.textContent).toContain('outline.reading_time');
        unmount();
    });

    it('leaves the estimate row out by default', () => {
        const { container, unmount } = renderOutline(ONE, vi.fn());
        expect(container.textContent).not.toContain('outline.reading_time');
        unmount();
    });
});

describe('Outline hover peek', () => {
    const PEEK: Heading[] = [
        { level: 1, text: 'Alpha', slug: 'alpha', line: 0 },
        { level: 2, text: 'Beta', slug: 'beta', line: 4 },
    ];
    const BODY = '# Alpha\n\nalpha body text\n\n## Beta\n\nbeta body\n';

    async function hover(slug: string): Promise<void> {
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' })); });
        const row = document.querySelector<HTMLElement>(`button[data-slug="${slug}"]`)!;
        await act(async () => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    }

    function peek(): Element | null {
        return document.body.querySelector('[data-outline-peek]');
    }

    it('stays closed without the modifier held', async () => {
        const { unmount } = renderOutline(PEEK, vi.fn(), { content: BODY, hoverPeek: true });
        const row = document.querySelector<HTMLElement>('button[data-slug="beta"]')!;
        await act(async () => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
        expect(peek()).toBeNull();
        await act(async () => { unmount(); });
    });

    it('shows the section under the heading while Ctrl is held', async () => {
        const { unmount } = renderOutline(PEEK, vi.fn(), { content: BODY, hoverPeek: true });
        await hover('beta');
        const card = peek();
        expect(card).not.toBeNull();
        expect(card!.textContent).toContain('beta body');
        expect(card!.getAttribute('aria-label')).toBe('outline.peek_label');
        await act(async () => { unmount(); });
    });

    it('closes when the modifier is released', async () => {
        const { unmount } = renderOutline(PEEK, vi.fn(), { content: BODY, hoverPeek: true });
        await hover('beta');
        expect(peek()).not.toBeNull();
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' })); });
        expect(peek()).toBeNull();
        await act(async () => { unmount(); });
    });

    it('shows the whole branch for a parent heading, subsection text included', async () => {
        const { container, unmount } = renderOutline(PEEK, vi.fn(), { content: BODY, hoverPeek: true });
        await hover('alpha');
        const card = peek();
        expect(card!.textContent).toContain('alpha body text');
        expect(card!.textContent).toContain('beta body');
        expect(card!.querySelector('h2')!.textContent).toContain('Beta');
        expect(container.ownerDocument.body.querySelectorAll('[data-outline-peek]').length).toBe(1);
        await act(async () => { unmount(); });
    });

    it('stays silent when the preference is off', async () => {
        const { unmount } = renderOutline(PEEK, vi.fn(), { content: BODY });
        await hover('beta');
        expect(peek()).toBeNull();
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' })); });
        await act(async () => { unmount(); });
    });
});

describe('Outline heading text direction', () => {
    const ROW: Heading[] = [{ level: 1, text: 'שלום world', slug: 'bidi', line: 0 }];

    function labelSpan(container: HTMLElement): HTMLElement {
        return container.querySelector<HTMLButtonElement>('button[data-slug="bidi"]')!.querySelector('span:last-child')!;
    }

    it('pins the label to the interface direction by default', () => {
        const { container, unmount } = renderOutline(ROW, vi.fn());
        expect(labelSpan(container).getAttribute('dir')).toBe('ltr');
        unmount();
    });

    it('hands the direction to the heading text when asked', () => {
        const { container, unmount } = renderOutline(ROW, vi.fn(), { textDirection: 'text' });
        expect(labelSpan(container).getAttribute('dir')).toBe('auto');
        unmount();
    });

    it('applies the same direction to a markdown-rendered label', () => {
        const { container, unmount } = renderOutline(ROW, vi.fn(), { content: '# **שלום** world\n', markdownLabels: true, textDirection: 'text' });
        const span = container.querySelector<HTMLElement>('[data-outline-markup]')!;
        expect(span.getAttribute('dir')).toBe('auto');
        expect(span.innerHTML).toBe('<strong>שלום</strong> world');
        unmount();
    });
});
