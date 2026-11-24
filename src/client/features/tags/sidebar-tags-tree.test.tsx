// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '@shared/types';
import { initI18n, t } from '../../lib/i18n';
import { renderElement, type RenderedElement } from '../../lib/test-render';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { SidebarTags } from './SidebarTags';

vi.mock('../../lib/api', () => ({
    api: {
        tags: {
            create: vi.fn(async () => ({})),
            patch: vi.fn(async () => ({ ok: true, renamed: 0 })),
            move: vi.fn(async () => ({ ok: true })),
            remove: vi.fn(async () => ({ ok: true, affected: 0 })),
        },
    },
}));

vi.mock('../../store/notes', async () => {
    const { create } = await import('zustand');
    const useNotes = create(() => ({ tags: [], notes: {}, folders: [], contents: {} }));
    return {
        useNotes,
        useNavigationCounts: () => ({ untagged: 0 }),
        setOptimisticTagCache: vi.fn(),
        findNoteByTitle: () => null,
        noteById: () => null,
    };
});

const originalUi = useUi.getState();
let view: RenderedElement | undefined;

function tag(name: string): Tag {
    return { id: `t-${name.replace(/\W/g, '_')}`, name, color: null, count: 1, createdAt: 1 };
}

function row(name: string): HTMLElement {
    const found = view?.container.querySelector<HTMLElement>(`[data-row-index="t-${name.replace(/\W/g, '_')}"]`);
    if (!found) throw new Error(`missing tag row ${name}`);
    return found;
}

function rowButton(name: string): HTMLButtonElement {
    const found = row(name).querySelector<HTMLButtonElement>('[data-tree-row]');
    if (!found) throw new Error(`missing tree row button ${name}`);
    return found;
}

function rowStops(): HTMLButtonElement[] {
    return [...view!.container.querySelectorAll<HTMLButtonElement>('[data-tree-row]')]
        .filter((button) => button.tabIndex >= 0);
}

function press(element: HTMLElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => { element.dispatchEvent(event); });
    return event;
}

async function mutations(): Promise<void> {
    await act(async () => { await Promise.resolve(); });
}

beforeEach(async () => {
    await initI18n();
    useNotes.setState({
        tags: [tag('personal'), tag('work'), tag('work/meeting')],
        notes: {},
        folders: [],
        contents: {},
    });
    useUi.setState({
        ...originalUi,
        view: 'all',
        tags: [],
        excludedTags: [],
        listCollapsed: false,
        searchList: false,
        toast: vi.fn(),
    });
    view = renderElement(<SidebarTags />);
});

afterEach(() => {
    view?.unmount();
    view = undefined;
    useNotes.setState({ tags: [], notes: {}, folders: [], contents: {} });
    useUi.setState(originalUi, true);
    vi.unstubAllGlobals();
});

describe('the sidebar tag tree keyboard contract', () => {
    it('keeps one row Tab stop without making treeitem wrappers focusable', () => {
        expect(rowStops()).toEqual([rowButton('work')]);
        for (const item of view!.container.querySelectorAll<HTMLElement>('[role="treeitem"]'))
            expect(item.hasAttribute('tabindex')).toBe(false);
    });

    it('walks visible rows with arrows and collapses or returns to the parent', async () => {
        const work = rowButton('work');
        const personal = rowButton('personal');
        act(() => { work.focus(); });
        expect(press(work, 'ArrowDown').defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(personal);
        expect(rowStops()).toEqual([personal]);
        press(personal, 'ArrowUp');
        expect(document.activeElement).toBe(work);

        press(work, 'ArrowRight');
        expect(row('work').getAttribute('aria-expanded')).toBe('true');
        const meeting = rowButton('work/meeting');
        press(work, 'ArrowRight');
        expect(document.activeElement).toBe(meeting);
        press(meeting, 'ArrowLeft');
        expect(document.activeElement).toBe(work);
        press(work, 'ArrowLeft');
        expect(row('work').getAttribute('aria-expanded')).toBe('false');
        expect(view!.container.querySelector('[data-row-index="t-work_meeting"]')).toBeNull();
        await mutations();
        expect(rowStops()).toEqual([work]);
    });

    it('leaves the filter cursor independent from tree focus', () => {
        const input = view!.container.querySelector<HTMLInputElement>('[data-tag-filter]')!;
        act(() => { input.focus(); });
        press(input, 'ArrowDown');
        expect(document.activeElement).toBe(input);
        expect(row('work').firstElementChild?.className).toContain('ring-1');
        press(input, 'ArrowDown');
        expect(document.activeElement).toBe(input);
        expect(row('personal').firstElementChild?.className).toContain('ring-1');
        expect(rowStops()).toEqual([rowButton('work')]);
    });

    it('keeps disclosure and row-action controls in native Tab order', () => {
        const work = rowButton('work');
        const toggle = row('work').querySelector<HTMLButtonElement>('[data-tree-toggle]')!;
        const more = row('work').querySelector<HTMLButtonElement>(`[aria-label="${t('common.more_actions')}"]`)!;
        expect(toggle.tabIndex).toBe(0);
        expect(more.tabIndex).toBe(0);
        expect(press(work, 'Tab').defaultPrevented).toBe(false);
        act(() => { toggle.focus(); });
        expect(document.activeElement).toBe(toggle);
        act(() => { more.focus(); });
        expect(document.activeElement).toBe(more);
        expect(rowStops()).toEqual([work]);
    });
});
