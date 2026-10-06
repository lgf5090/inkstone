import { beforeEach, describe, expect, it } from 'vitest';
import type { Tag } from '@shared/types';
import { initI18n } from '../../lib/i18n';
import { searchTag } from './tagMutations';
import { useUi } from '../../store/ui';

const originalUi = useUi.getState();
const meeting: Tag = { id: 't-1', name: 'work/meeting', color: null, count: 1, createdAt: 1 };
const job: Tag = { id: 't-2', name: 'job', color: null, count: 1, createdAt: 1 };

beforeEach(async () => {
    await initI18n();
    useUi.setState({ ...originalUi, searchList: false, searchQuery: '', view: 'all', tags: [], excludedTags: [], folderId: null });
});

describe('the tag search expressions', () => {
    it('enters the global search holding the tag expression', () => {
        useUi.setState({ searchQuery: 'draft', folderId: 'f-1', view: 'folder' });
        searchTag(meeting, 'new');
        expect(useUi.getState().searchList).toBe(true);
        expect(useUi.getState().searchQuery).toBe('tag:#work/meeting');
        expect(useUi.getState().view).toBe('all');
    });

    it('replaces the box instead of chaining onto an unrelated word', () => {
        searchTag(meeting, 'new');
        useUi.getState().setSearchQuery('alpha');
        searchTag(job, 'new');
        expect(useUi.getState().searchQuery).toBe('tag:#job');
    });

    it('appends require and exclude to the expression already in the box', () => {
        searchTag(meeting, 'new');
        searchTag(job, 'require');
        expect(useUi.getState().searchQuery).toBe('tag:#work/meeting tag:#job');
        searchTag(job, 'exclude');
        expect(useUi.getState().searchQuery).toBe('tag:#work/meeting tag:#job -tag:#job');
    });

    it('never writes the same expression twice', () => {
        useUi.setState({ searchList: true, searchQuery: '-tag:#job' });
        searchTag(job, 'exclude');
        expect(useUi.getState().searchQuery).toBe('-tag:#job');
    });

    it('keeps the query when opening a search that is already described', () => {
        useUi.setState({ searchQuery: 'alpha tag:#job' });
        searchTag(job, 'require');
        expect(useUi.getState().searchQuery).toBe('alpha tag:#job');
        expect(useUi.getState().searchList).toBe(true);
    });
});
