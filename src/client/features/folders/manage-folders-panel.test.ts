import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder, NoteSummary } from '@shared/types';
import { ORGANIZER_COLORS } from '@shared/organizer-colors';
import { initI18n, t } from '../../lib/i18n';
import { getInboxFolderId, setInboxFolderId } from '../../lib/folder-prefs';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { ManageFoldersPanel } from './ManageFoldersPanel';

const parent: Folder = { id: 'p', parentId: null, name: 'Alpha', icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 };
const child: Folder = { id: 'c', parentId: 'p', name: 'Beta', icon: null, color: null, position: 1, createdAt: 2, updatedAt: 2 };
const leaf: Folder = { id: 'e', parentId: null, name: 'Gamma', icon: null, color: null, position: 2, createdAt: 3, updatedAt: 3 };

function note(id: string, folderId: string | null): NoteSummary {
    return {
        id, title: `Note ${id}`, excerpt: '', folderId, tags: [], isPinned: false, isStarred: false,
        isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
    };
}

const originalUi = useUi.getState();
const originalNotes = useNotes.getState();
let root: Root;
let container: HTMLDivElement;
let close = vi.fn();

const controls = (scope: ParentNode) => [...scope.querySelectorAll<HTMLButtonElement>('button')];
const byLabel = (scope: ParentNode, label: string) => {
    const found = controls(scope).find((element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label);
    if (!found)
        throw new Error(`missing control ${label}`);
    return found;
};
const row = (scope: ParentNode, marker: string) => {
    const found = [...scope.querySelectorAll<HTMLElement>('li')].find((element) => element.textContent?.includes(marker));
    if (!found)
        throw new Error(`missing row ${marker}`);
    return found;
};
const click = async (element: HTMLElement) => {
    expect(element).toBeTruthy();
    await act(() => element.click());
};
const type = async (field: HTMLInputElement, value: string) => {
    await act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;

async function openPanel() {
    await act(() => root.render(createElement(ManageFoldersPanel, { onClose: close })));
    return dialog();
}

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    await initI18n();
    close.mockReset();
    setInboxFolderId(null);
    useUi.setState({ ...originalUi, panel: 'folders', toasts: [] });
    useNotes.setState({
        ...originalNotes,
        folders: [parent, child, leaf],
        notes: { a: note('a', 'p'), b: note('b', 'c'), c: note('c', 'c') },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    useUi.setState(originalUi, true);
    useNotes.setState(originalNotes, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('manage folders panel', () => {
    it('lists every folder with its path and direct note count', async () => {
        const scope = await openPanel();
        expect(scope.textContent).toContain('Alpha');
        expect(row(scope, 'Alpha / Beta').textContent).toContain(t('folders.notes_count', { value0: 2 }));
        expect(row(scope, 'Gamma').textContent).toContain(t('folders.notes_count', { value0: 0 }));
    });

    it('filters the list by path', async () => {
        const scope = await openPanel();
        await type(scope.querySelector<HTMLInputElement>('input')!, 'beta');
        expect(scope.querySelectorAll('li')).toHaveLength(1);
        expect(scope.textContent).toContain('Alpha / Beta');
        expect(scope.textContent).not.toContain('Gamma');
    });

    it('creates a folder from the inline form', async () => {
        const createFolder = vi.fn(() => 'new');
        useNotes.setState({ createFolder });
        const scope = await openPanel();
        await click(byLabel(scope, t('common.new_folder')));
        const draft = dialog().querySelector<HTMLInputElement>('form input')!;
        await type(draft, 'Reports');
        await click(dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!);
        expect(createFolder).toHaveBeenCalledWith({ name: 'Reports' });
        expect(dialog().querySelector('form input')).toBeNull();
    });

    it('renames a folder through the inline field', async () => {
        const patchFolder = vi.fn(() => true);
        useNotes.setState({ patchFolder });
        const scope = await openPanel();
        const target = row(scope, 'Gamma');
        await click(byLabel(target, t('sidebar.rename')));
        const field = target.querySelector<HTMLInputElement>('input')!;
        expect(field.value).toBe('Gamma');
        await type(field, 'Renamed');
        await act(() => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
        expect(patchFolder).toHaveBeenCalledWith('e', { name: 'Renamed' });
    });

    it('recolors a folder from the inline palette', async () => {
        const patchFolder = vi.fn(() => true);
        useNotes.setState({ patchFolder });
        const scope = await openPanel();
        await click(byLabel(row(scope, 'Alpha'), t('folders.color')));
        await click(byLabel(row(dialog(), 'Alpha'), t('color.emerald')));
        expect(patchFolder).toHaveBeenCalledWith('p', { color: ORGANIZER_COLORS[4] });
        expect(row(dialog(), 'Alpha').querySelector(`button[aria-label="${t('folders.no_color')}"]`)).toBeNull();
    });

    it('keeps the icon picker open while typing a custom emoji and closes on a grid pick', async () => {
        const patchFolder = vi.fn(() => true);
        useNotes.setState({ patchFolder });
        const scope = await openPanel();
        await click(byLabel(row(scope, 'Alpha'), t('folders.icon')));
        const field = row(dialog(), 'Alpha').querySelector<HTMLInputElement>('input')!;
        await type(field, '🚀');
        expect(patchFolder).toHaveBeenCalledWith('p', { icon: '🚀' });
        expect(row(dialog(), 'Alpha').querySelector('input')).toBeTruthy();
        await click(byLabel(row(dialog(), 'Alpha'), '⭐'));
        expect(patchFolder).toHaveBeenLastCalledWith('p', { icon: '⭐' });
        expect(row(dialog(), 'Alpha').querySelector('input')).toBeNull();
    });

    it('toggles the inbox folder and reports it', async () => {
        const scope = await openPanel();
        await click(byLabel(row(scope, 'Alpha'), t('folders.set_as_inbox')));
        expect(getInboxFolderId()).toBe('p');
        expect(useUi.getState().toasts.at(-1)?.title).toBe(t('folders.inbox_set_toast', { value0: 'Alpha' }));
        await click(byLabel(row(dialog(), 'Alpha'), t('folders.unset_inbox')));
        expect(getInboxFolderId()).toBeNull();
    });

    it('opens a folder and closes the panel', async () => {
        const scope = await openPanel();
        await click(row(scope, 'Alpha / Beta').querySelector<HTMLButtonElement>('button')!);
        expect(useUi.getState()).toMatchObject({ view: 'folder', folderId: 'c' });
        expect(close).toHaveBeenCalled();
    });

    it('cleans only leaf folders without notes after confirmation', async () => {
        const deleteFolder = vi.fn(() => true);
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        useNotes.setState({ deleteFolder });
        const scope = await openPanel();
        await click(byLabel(scope, t('folders.clean_empty_value0', { value0: 1 })));
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(deleteFolder).toHaveBeenCalledExactlyOnceWith('e');
        expect(useUi.getState().toasts.at(-1)?.title).toBe(t('folders.clean_empty_success', { value0: 1 }));
    });

    it('keeps the clean-up button inert when nothing is empty', async () => {
        useNotes.setState({ folders: [parent], notes: { a: note('a', 'p') } });
        const scope = await openPanel();
        expect(byLabel(scope, t('folders.clean_empty_value0', { value0: 0 })).disabled).toBe(true);
    });

    it('refuses the clean-up when the confirmation is declined', async () => {
        const deleteFolder = vi.fn(() => true);
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        useNotes.setState({ folders: [leaf], notes: {}, deleteFolder });
        const scope = await openPanel();
        await click(byLabel(scope, t('folders.clean_empty_value0', { value0: 1 })));
        expect(deleteFolder).not.toHaveBeenCalled();
    });

    it('unsets the inbox again when the same row is toggled', async () => {
        setInboxFolderId('p');
        const scope = await openPanel();
        await click(byLabel(row(scope, 'Alpha'), t('folders.unset_inbox')));
        expect(getInboxFolderId()).toBeNull();
    });
});
