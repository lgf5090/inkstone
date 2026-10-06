import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '@shared/types';
import { initI18n } from '../../lib/i18n';
import * as overlay from '../../components/overlay';
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { SidebarTags } from './SidebarTags';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
    api: { tags: { patch: vi.fn(async () => ({ ok: true, renamed: 1 })), move: vi.fn(async () => ({ ok: true })) } },
}));

const originalNotes = useNotes.getState();
const originalUi = useUi.getState();
const confirmSpy = vi.spyOn(overlay, 'confirm');
let root: Root;
let container: HTMLDivElement;

const CJK_TAG = '\u5165\u95e8';

function tag(name: string): Tag {
    return { id: `t-${name.replace(/\W/g, '_')}`, name, color: null, count: 1, createdAt: 1 };
}

const rowOf = (name: string) => {
    const found = container.querySelector<HTMLElement>(`[data-row-index="t-${name.replace(/\W/g, '_')}"]`);
    if (!found)
        throw new Error(`missing row ${name}`);
    return found;
};

beforeEach(async () => {
    installTestGlobals();
    stubBreakpoint(true);
    await initI18n();
    confirmSpy.mockReset();
    confirmSpy.mockResolvedValue(true);
    vi.mocked(api.tags.patch).mockClear();
    useNotes.setState({
        ...originalNotes,
        tags: [tag('Inkstone'), tag(CJK_TAG), tag('getting-started')],
        notes: {},
        folders: [],
        contents: {},
        pull: vi.fn(async () => undefined),
    });
    useUi.setState({ ...originalUi, view: 'all', tags: [], excludedTags: [], listCollapsed: false, toast: vi.fn() });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(() => root.render(createElement(SidebarTags)));
});

afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    useNotes.setState(originalNotes, true);
    useUi.setState(originalUi, true);
    vi.unstubAllGlobals();
});

describe('renaming a row into an existing tag', () => {
    it('does not let the committing Enter answer the dialog it just opened', async () => {
        const button = rowOf('getting-started').querySelector('button')!;
        await act(async () => {
            button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });
        const input = rowOf('getting-started').querySelector('input')!;
        const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        input.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(true);
    });

    it('asks before the merge through the inline input', async () => {
        const button = rowOf('getting-started').querySelector('button')!;
        await act(async () => {
            button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });
        const input = rowOf('getting-started').querySelector('input');
        expect(input).not.toBeNull();
        await act(async () => {
            input!.value = 'Inkstone';
            input!.dispatchEvent(new Event('input', { bubbles: true }));
            input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(confirmSpy).toHaveBeenCalled();
        expect(String(confirmSpy.mock.calls[0]?.[0]?.title)).toContain('Inkstone');
        expect(api.tags.patch).toHaveBeenCalledWith('t-getting_started', { name: 'Inkstone' });
    });
});
