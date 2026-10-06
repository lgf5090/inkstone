import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '@shared/types';
import { initI18n } from '../../lib/i18n';
import { createTag, normalizeTagName, renameTag } from './tagMutations';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';

vi.mock('../../lib/api', () => ({
    api: {
        tags: {
            create: vi.fn(async () => ({})),
            patch: vi.fn(async () => ({ ok: true, renamed: 0 })),
        },
    },
}));

const originalNotes = useNotes.getState();
const originalUi = useUi.getState();

function tag(id: string, name: string): Tag {
    return { id, name, color: null, count: 1, createdAt: 1 };
}

beforeEach(async () => {
    await initI18n();
    useNotes.setState({ ...originalNotes, tags: [tag('t-ss', 'stra\u00DFe'), tag('t-wide', 'work')], notes: {} });
    useUi.setState({ ...originalUi, view: 'all', tags: [], excludedTags: [] });
});

describe('tag identity in the mutation layer', () => {
    it('treats a case or width variant as the tag that exists', () => {
        expect(createTag('WORK')).toBe('t-wide');
        expect(createTag('\uFF37\uFF2F\uFF32\uFF2B')).toBe('t-wide');
    });

    it('does not fold a German expansion into an existing tag', () => {
        expect(createTag('STRASSE')).not.toBe('t-ss');
        expect(normalizeTagName('STRASSE')).toBe('STRASSE');
    });

    it('renames without a merge prompt when only the spelling differs from the server', async () => {
        const confirm = await import('../../components/overlay');
        const spy = vi.spyOn(confirm, 'confirm').mockResolvedValue(false);
        await renameTag(tag('t-ss', 'stra\u00DFe'), 'STRASSE');
        expect(spy).not.toHaveBeenCalled();
        expect(useNotes.getState().tags.map((item) => item.name)).toContain('STRASSE');
        spy.mockRestore();
    });
});
