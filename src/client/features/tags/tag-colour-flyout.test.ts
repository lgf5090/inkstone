import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '@shared/types';
import { ORGANIZER_COLORS } from '@shared/organizer-colors';
import { initI18n, t } from '../../lib/i18n';
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { SidebarTags } from './SidebarTags';

vi.mock('../../lib/api', () => ({
    api: {
        tags: {
            patch: vi.fn(async () => ({})),
            create: vi.fn(async () => ({})),
            remove: vi.fn(async () => ({})),
            move: vi.fn(async () => ({ ok: true, moved: 0 })),
        },
    },
}));

const originalNotes = useNotes.getState();
const originalUi = useUi.getState();
let root: Root;
let container: HTMLDivElement;

function tag(name: string): Tag {
    return { id: `t-${name.replace(/\W/g, '_')}`, name, color: null, count: 1, createdAt: 1 };
}

const byLabel = (scope: ParentNode, label: string) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>('button')]
        .find((element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label);
    if (!found)
        throw new Error(`missing control ${label}`);
    return found;
};
const click = async (element: HTMLElement) => {
    await act(() => element.click());
};

beforeEach(async () => {
    installTestGlobals();
    stubBreakpoint(true);
    await initI18n();
    useNotes.setState({
        ...originalNotes,
        tags: [tag('work'), tag('job')],
        notes: {},
        folders: [],
    });
    useUi.setState({ ...originalUi, view: 'all', tags: [], excludedTags: [] });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    useNotes.setState(originalNotes, true);
    useUi.setState(originalUi, true);
    vi.unstubAllGlobals();
});

describe('the tag colour flyout', () => {
    async function openColour() {
        await act(() => root.render(createElement(SidebarTags)));
        const row = container.querySelector<HTMLElement>('[data-row-index="t-work"]')!;
        await click(byLabel(row, t('common.more_actions')));
        await click(byLabel(document.querySelector<HTMLElement>('[role="menu"]')!, t('tags.color')));
        return document.querySelector<HTMLElement>(`[role="group"][aria-label="${t('tags.color')}"]`)!;
    }

    it('opens a flyout rather than a drawer', async () => {
        const panel = await openColour();
        expect(panel).toBeTruthy();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect([...panel.querySelectorAll<HTMLButtonElement>('button')]
            .filter((element) => element.getAttribute('aria-pressed') !== null)).toHaveLength(ORGANIZER_COLORS.length + 1);
    });

    it('paints the tag and closes the menu', async () => {
        const panel = await openColour();
        const { api } = await import('../../lib/api');
        await click(byLabel(panel, t('color.red')));
        expect(api.tags.patch).toHaveBeenCalledWith('t-work', { color: ORGANIZER_COLORS[0] });
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });
});
