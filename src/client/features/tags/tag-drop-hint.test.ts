import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '@shared/types';
import { initI18n, t } from '../../lib/i18n';
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { SidebarTags } from './SidebarTags';
import { decodeDataValue } from '../../lib/markdown/data-attr';

const originalUi = useUi.getState();
const originalNotes = useNotes.getState();
const MIME = 'application/x-inkstone-tag';
let root: Root;
let container: HTMLDivElement;

function tag(name: string): Tag {
    return { id: `t-${name.replace(/\W/g, '_')}`, name, color: null, count: 1, createdAt: 1 };
}

function drag(type: string, bag: Map<string, string>) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
        value: {
            getData: (key: string) => bag.get(key) ?? '',
            setData: (key: string, value: string) => { bag.set(key, value); },
            dropEffect: 'move',
            effectAllowed: 'move',
            types: [...bag.keys()],
        },
    });
    return event;
}

const rowOf = (name: string) => {
    const found = container.querySelector<HTMLElement>(`[data-row-index="t-${name.replace(/\W/g, '_')}"]`);
    if (!found)
        throw new Error(`missing tag row ${name}`);
    return found;
};

const hint = (path: string) => t('tags.move_to_value0', { value0: path });

beforeEach(async () => {
    installTestGlobals();
    stubBreakpoint(true);
    await initI18n();
    useNotes.setState({ ...originalNotes, tags: [tag('job'), tag('work'), tag('work/deep')], notes: {}, folders: [] });
    useUi.setState({ ...originalUi, view: 'all', tags: [], excludedTags: [], listCollapsed: false });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    useUi.setState(originalUi, true);
    useNotes.setState(originalNotes, true);
    vi.unstubAllGlobals();
});

describe('the tag drag destination hint', () => {
    async function startDragging(name: string): Promise<Map<string, string>> {
        const bag = new Map<string, string>();
        await act(() => root.render(createElement(SidebarTags)));
        await act(() => { rowOf(name).dispatchEvent(drag('dragstart', bag)); });
        expect(decodeDataValue(bag.get(MIME)!)).toBe(name);
        return bag;
    }

    it('names the tag the dragged branch will become', async () => {
        const bag = await startDragging('work');
        expect(container.textContent).not.toContain(hint('job/work'));
        await act(() => { rowOf('job').dispatchEvent(drag('dragover', bag)); });
        expect(container.textContent).toContain(hint('job/work'));
    });

    it('offers the hint for the row being hovered, not the row being dragged', async () => {
        const bag = await startDragging('job');
        await act(() => { rowOf('work').dispatchEvent(drag('dragover', bag)); });
        expect(container.textContent).toContain(hint('work/job'));
        await act(() => { rowOf('job').dispatchEvent(drag('dragover', bag)); });
        expect(container.textContent).not.toContain(hint('job/job'));
    });

    it('goes away when the drag leaves the list', async () => {
        const bag = await startDragging('work');
        await act(() => { rowOf('job').dispatchEvent(drag('dragover', bag)); });
        expect(container.textContent).toContain(hint('job/work'));
        await act(() => { rowOf('work').dispatchEvent(drag('dragend', bag)); });
        expect(container.textContent).not.toContain(hint('job/work'));
    });
});
