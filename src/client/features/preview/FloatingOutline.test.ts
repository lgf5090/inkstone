import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { installTestGlobals, renderElement } from '../../lib/test-render';
import { FloatingOutline } from './FloatingOutline';
import type { Heading } from '../../lib/markdown/renderer';

installTestGlobals();

const HEADINGS: Heading[] = [
    { level: 1, text: 'Alpha', slug: 'alpha', line: 0 },
    { level: 2, text: 'Beta', slug: 'beta', line: 2 },
];

function renderPanel() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const ref = { current: container };
    const root = renderElement(createElement(FloatingOutline, {
        headings: HEADINGS,
        onSelect: vi.fn(),
        scrollerRef: ref,
        noteId: 'n1',
        defaultLevel: 6,
        showProgress: true,
        keepSearch: false,
        content: '# Alpha\n\n## Beta\n',
        onContentChange: vi.fn(),
        dragEdits: false,
        autoExpand: 'off',
        tooltipSide: 'left',
        truncateLength: 0,
        markdownLabels: false,
        showReadingTime: true,
        readingSpeed: 300,
        wordCount: 2,
        containerRef: ref,
    }));
    return { ...root, dispose: () => { root.unmount(); container.remove(); } };
}

describe('FloatingOutline header controls', () => {
    function cornerButtons(root: HTMLElement): HTMLButtonElement[] {
        return Array.from(root.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'))
            .filter((button) => (button.getAttribute('aria-label') ?? '').startsWith('outline.corner_'));
    }

    it('mounts the panel with its four corner presets and a reset', () => {
        const { container, dispose } = renderPanel();
        expect(container.querySelector('[data-outline-floating]')).not.toBeNull();
        expect(cornerButtons(container).length).toBe(4);
        expect(container.querySelector('button[aria-label="outline.reset_position"]')).not.toBeNull();
        dispose();
    });

    it('keeps every button outside the element that captures the pointer', () => {
        // A click retargets to the pointer-capture element, so a control nested in the grip
        // would never receive its own click. jsdom cannot reproduce that; this pins the shape.
        const { container, dispose } = renderPanel();
        const grip = container.querySelector('.cursor-grab');
        expect(grip).not.toBeNull();
        for (const button of Array.from(container.querySelectorAll('button')))
            expect(button.closest('.cursor-grab')).toBeNull();
        dispose();
    });

    it('marks the default corner pressed and the rest not', () => {
        const { container, dispose } = renderPanel();
        const pressed = cornerButtons(container).filter((button) => button.getAttribute('aria-pressed') === 'true');
        expect(pressed.map((button) => button.getAttribute('aria-label'))).toEqual(['outline.corner_top_right']);
        dispose();
    });

    it('shows the reading time row the parent hands down', () => {
        const { container, dispose } = renderPanel();
        expect(container.textContent).toContain('outline.reading_time');
        dispose();
    });
});
