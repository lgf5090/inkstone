import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSummary } from '@shared/types';
import { initI18n } from '../../lib/i18n';
import { createTagPage, findTagPage, openTagPage, tagPageTitle } from './tagMutations';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';

vi.mock('../../lib/api', () => ({
    api: { tags: { create: vi.fn(async () => ({})), patch: vi.fn(async () => ({})) } },
}));

const originalNotes = useNotes.getState();
const originalUi = useUi.getState();
const createNote = vi.fn(async () => 'page-id');
const openNote = vi.fn(async () => undefined);

function note(input: Partial<NoteSummary> & { id: string }): NoteSummary {
    return {
        title: input.id, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false,
        isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
        ...input,
    };
}

beforeEach(async () => {
    await initI18n();
    createNote.mockClear();
    openNote.mockClear();
    useNotes.setState({
        ...originalNotes,
        notes: {
            page: note({ id: 'page', title: 'work meeting', tags: ['work/meeting'] }),
            other: note({ id: 'other', title: 'Minutes', tags: ['work/meeting'] }),
            trashed: note({ id: 'trashed', title: 'work meeting', tags: ['work/meeting'], deletedAt: 5 }),
        },
        tags: [{ id: 't-1', name: 'work/meeting', color: null, count: 2, createdAt: 1 }],
        createNote,
        openNote,
    });
    useUi.setState({ ...originalUi, view: 'all', tags: [], excludedTags: [] });
});

describe('tag pages', () => {
    it('spells the page title with spaces and finds it by title plus tag', () => {
        expect(tagPageTitle('work/meeting')).toBe('work meeting');
        expect(findTagPage('work/meeting')?.id).toBe('page');
    });

    it('ignores notes that carry the tag but are not named after it, and the trash', () => {
        useNotes.setState({ notes: {
            page: note({ id: 'page', title: 'work meeting', tags: ['work/meeting'] }),
            other: note({ id: 'other', title: 'Minutes', tags: ['work/meeting'] }),
            trashed: note({ id: 'trashed', title: 'work meeting', tags: ['work/meeting'], deletedAt: 5 }),
        } });
        expect(findTagPage('work/meeting')?.id).toBe('page');
        useNotes.setState({ notes: { lookalike: note({ id: 'lookalike', title: 'work meeting', tags: ['other'] }) } });
        expect(findTagPage('work/meeting')).toBeNull();
    });

    it('folds case and width in both the title and the tag', () => {
        useNotes.setState({ notes: { wide: note({ id: 'wide', title: 'WORK  Meeting', tags: ['Work/Meeting'] }) } });
        expect(findTagPage('work/meeting')?.id).toBe('wide');
    });

    it('creates the page with a tag-shaped alias', async () => {
        await createTagPage({ id: 't-1', name: 'work/meeting', color: null, count: 2, createdAt: 1 });
        expect(createNote).toHaveBeenCalledWith({
            title: 'work meeting',
            content: ['---', 'aliases: ["#work/meeting"]', '---', ''].join('\n'),
        });
    });

    it('opens the existing page without asking', async () => {
        await openTagPage({ id: 't-1', name: 'work/meeting', color: null, count: 2, createdAt: 1 });
        expect(openNote).toHaveBeenCalledWith('page');
        expect(createNote).not.toHaveBeenCalled();
    });

    it('asks before creating, and filters the list when the answer is no', async () => {
        useNotes.setState({ notes: { other: note({ id: 'other', title: 'Minutes', tags: ['work/meeting'] }) } });
        const overlay = await import('../../components/overlay');
        const spy = vi.spyOn(overlay, 'confirm').mockResolvedValue(false);
        await openTagPage({ id: 't-1', name: 'work/meeting', color: null, count: 2, createdAt: 1 });
        expect(spy).toHaveBeenCalledOnce();
        expect(createNote).not.toHaveBeenCalled();
        expect(useUi.getState().tags).toEqual(['work/meeting']);

        spy.mockResolvedValue(true);
        await openTagPage({ id: 't-1', name: 'work/meeting', color: null, count: 2, createdAt: 1 });
        expect(createNote).toHaveBeenCalledOnce();
        spy.mockRestore();
    });
});
