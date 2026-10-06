import { describe, expect, it, vi } from 'vitest';
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

const MIN_LEVEL_HEADINGS: Heading[] = [
    { level: 2, text: 'Topic 1', slug: 'topic-1', line: 1 },
    { level: 3, text: 'Subtopic 1', slug: 'subtopic-1', line: 5 },
];

const H1_HEADINGS: Heading[] = [
    { level: 1, text: 'First Chapter', slug: 'first-chapter', line: 1 },
    { level: 2, text: 'Section', slug: 'section', line: 5 },
    { level: 1, text: 'Second Chapter', slug: 'second-chapter', line: 10 },
];

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

function renderOutline(headings: Heading[], onSelect = vi.fn()) {
    return renderElement(createElement(Outline, { headings, onSelect }));
}

function expectHeadingButton(button: HTMLButtonElement, level: string, fontSize: string, fontWeight: string, paddingLeft: string): void {
    expect(button.getAttribute('data-heading-level')).toBe(level);
    expect(button.classList.contains(fontSize)).toBe(true);
    expect(button.classList.contains(fontWeight)).toBe(true);
    expect(button.style.paddingLeft).toBe(paddingLeft);
}

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

describe('Outline component', () => {
    it('returns null when headings array is empty', () => {
        const { container, unmount } = renderOutline([]);
        expect(container.firstChild).toBeNull();
        unmount();
    });

    it('renders headings with corresponding level attributes, icons, sizes and weights', () => {
        const handleSelect = vi.fn();
        const { container, unmount } = renderOutline(FOUR_LEVEL_HEADINGS, handleSelect);

        const buttons = container.querySelectorAll<HTMLButtonElement>('button[data-heading-level]');
        expect(buttons.length).toBe(4);
        expect(container.querySelectorAll<SVGElement>('button[data-heading-level] svg').length).toBe(4);

        expectHeadingButton(buttons[0], '1', 'text-[length:var(--text-13)]', 'font-semibold', '8px');
        expectHeadingButton(buttons[1], '2', 'text-[length:var(--text-12)]', 'font-medium', '18px');
        expectHeadingButton(buttons[2], '3', 'text-[length:var(--text-11-5)]', 'font-normal', '28px');
        expectHeadingButton(buttons[3], '4', 'text-[length:var(--text-11)]', 'font-normal', '38px');

        buttons[1].click();
        expect(handleSelect).toHaveBeenCalledWith(FOUR_LEVEL_HEADINGS[1]);

        unmount();
    });

    it('aligns indentation when minLevel > 1', () => {
        const { container, unmount } = renderOutline(MIN_LEVEL_HEADINGS);

        const buttons = container.querySelectorAll<HTMLButtonElement>('button[data-heading-level]');
        expect(buttons.length).toBe(2);
        expect(buttons[0].style.paddingLeft).toBe('8px');
        expect(buttons[1].style.paddingLeft).toBe('18px');

        unmount();
    });

    it('adds margin-top on subsequent H1 headings for section separation', () => {
        const { container, unmount } = renderOutline(H1_HEADINGS);

        const listItems = container.querySelectorAll('li');
        expect(listItems.length).toBe(3);
        expect(listItems[0].classList.contains('mt-1.5')).toBe(false);
        expect(listItems[2].classList.contains('mt-1.5')).toBe(true);

        unmount();
    });
});
