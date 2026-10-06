import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '@shared/types';
import { initI18n, t } from '../../lib/i18n';
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { SidebarTags } from './SidebarTags';
import { beginTagDrag, endTagDrag } from './tagDrag';
import { api } from '../../lib/api';

const originalUi = useUi.getState();
const originalNotes = useNotes.getState();
const WIDE_WORK = '\uFF37\uFF4F\uFF52\uFF4B';
let root: Root;
let container: HTMLDivElement;

function tag(name: string): Tag {
    return { id: `t-${name.replace(/\W/g, '_')}`, name, color: null, count: 1, createdAt: 1 };
}

function drag(type: string, bag: Map<string, string>): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
        value: {
            getData: (key: string) => bag.get(key) ?? '',
            setData: (key: string, value: string) => {
                bag.set(key, value);
            },
            dropEffect: '',
            effectAllowed: 'uninitialized',
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
    vi.spyOn(api.tags, 'move').mockImplementation(async () => undefined as never);
    useNotes.setState({ ...originalNotes, tags: [tag('job'), tag('work'), tag('work/deep')], notes: {}, folders: [], contents: {}, pull: vi.fn(async () => undefined) });
    useUi.setState({ ...originalUi, view: 'all', tags: [], excludedTags: [], listCollapsed: false, toast: vi.fn() });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(() => root.render(createElement(SidebarTags)));
});

afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    useUi.setState(originalUi, true);
    useNotes.setState(originalNotes, true);
    vi.unstubAllGlobals();
});

describe('a tag dragged in from another panel', () => {
    function startFromPill(name: string): Map<string, string> {
        const bag = new Map<string, string>();
        beginTagDrag(name, {
            types: [],
            setData: (key: string, value: string) => {
                bag.set(key, value);
            },
            getData: () => '',
        } as unknown as DataTransfer);
        return bag;
    }

    it('labels the destination row although the drag never started here', async () => {
        const bag = startFromPill('work');
        await act(async () => {
            rowOf('job').dispatchEvent(drag('dragover', bag));
        });
        expect(container.textContent).toContain(hint('job/work'));
        await act(async () => {
            rowOf('job').dispatchEvent(drag('drop', bag));
        });
        expect(api.tags.move).toHaveBeenCalledWith('t-work', 'job');
    });

    it('moves the tag the payload names whatever spelling it used', async () => {
        const bag = startFromPill(WIDE_WORK);
        await act(async () => {
            rowOf('job').dispatchEvent(drag('dragover', bag));
        });
        await act(async () => {
            rowOf('job').dispatchEvent(drag('drop', bag));
        });
        expect(api.tags.move).toHaveBeenCalledWith('t-work', 'job');
    });

    it('refuses a drag that carries no tag type even while one is in memory', async () => {
        startFromPill('work');
        const noteBag = new Map([['application/x-inkstone-note', 't-job']]);
        await act(async () => {
            rowOf('job').dispatchEvent(drag('dragover', noteBag));
        });
        expect(container.textContent).not.toContain(hint('job/work'));
        await act(async () => {
            rowOf('work').dispatchEvent(drag('drop', noteBag));
        });
        expect(api.tags.move).not.toHaveBeenCalled();
        endTagDrag();
    });

    it('stops offering the destination once the drag is over', async () => {
        const bag = startFromPill('work');
        await act(async () => {
            rowOf('job').dispatchEvent(drag('dragover', bag));
        });
        expect(container.textContent).toContain(hint('job/work'));
        await act(async () => {
            endTagDrag();
            rowOf('job').dispatchEvent(drag('dragleave', bag));
        });
        expect(container.textContent).not.toContain(hint('job/work'));
    });
});
