import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tag } from '@shared/types';
import { initI18n, t } from '../../lib/i18n';
import * as overlay from '../../components/overlay';
import { familyMergeConflicts, moveTag, renameTag } from './tagMutations';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
    api: {
        tags: {
            patch: vi.fn(async () => ({ ok: true, renamed: 0 })),
            move: vi.fn(async () => ({ ok: true, renamed: 0 })),
        },
    },
}));

const originalNotes = useNotes.getState();
const originalUi = useUi.getState();
const confirmSpy = vi.spyOn(overlay, 'confirm');

function tag(name: string): Tag {
    return { id: `t-${name.replace(/\W/g, '_')}`, name, color: null, count: 1, createdAt: 1 };
}

function seed(...names: string[]): void {
    useNotes.setState({
        ...originalNotes,
        tags: names.map(tag),
        notes: {},
        contents: {},
        pull: vi.fn(async () => undefined),
    });
    useUi.setState({ ...originalUi, view: 'all', tags: [], excludedTags: [], toast: vi.fn() });
}

afterEach(() => {
    useNotes.setState(originalNotes, true);
    useUi.setState(originalUi, true);
    confirmSpy.mockReset();
    vi.mocked(api.tags.patch).mockClear();
    vi.mocked(api.tags.move).mockClear();
});

describe('which renames merge tags', () => {
    beforeEach(() => initI18n());

    it('catches a descendant landing on an existing name', () => {
        const tags = [tag('a'), tag('a/x'), tag('b'), tag('b/x')];
        expect(familyMergeConflicts(tags, 'a', 'c')).toEqual([]);
        expect(familyMergeConflicts(tags, 'a', 'b')).toEqual([
            { from: 'a', into: 'b' },
            { from: 'a/x', into: 'b/x' },
        ]);
    });

    it('catches the merge the root check alone would miss', () => {
        seed('a/x', 'b/x');
        expect(familyMergeConflicts(useNotes.getState().tags, 'a', 'b')).toEqual([{ from: 'a/x', into: 'b/x' }]);
    });

    it('does not report the family landing on itself', () => {
        const tags = [tag('a'), tag('a/x'), tag('a/x/y')];
        expect(familyMergeConflicts(tags, 'a', 'a')).toEqual([]);
        expect(familyMergeConflicts(tags, 'a', 'a/deep')).toEqual([]);
    });

    it('treats a pure case or width change as no merge', () => {
        const tags = [tag('Work'), tag('work/meeting')];
        expect(familyMergeConflicts(tags, 'work', 'WORK')).toEqual([]);
        expect(familyMergeConflicts(tags, 'work', '\uFF37\uFF4F\uFF52\uFF4B')).toEqual([]);
    });

    it('folds the width of a colliding spelling', () => {
        const wide = tag('\uFF37\uFF4F\uFF52\uFF4B');
        expect(familyMergeConflicts([tag('x'), wide], 'x', 'WORK')).toEqual([{ from: 'x', into: wide.name }]);
    });
});

describe('the merge warning before a rewrite', () => {
    beforeEach(async () => {
        await initI18n();
        confirmSpy.mockResolvedValue(true);
    });

    it('warns when a rename buries a child under an existing tag', async () => {
        seed('a/x', 'b/x');
        await renameTag(tag('a'), 'b');
        expect(confirmSpy).toHaveBeenCalled();
        expect(String(confirmSpy.mock.calls[0]?.[0]?.description)).toContain('1');
        expect(api.tags.patch).toHaveBeenCalledWith('t-a', { name: 'b' });
    });

    it('keeps the plain merge question when only the root collides', async () => {
        seed('a', 'b');
        await renameTag(tag('a'), 'b');
        const ask = confirmSpy.mock.calls[0]?.[0];
        expect(ask?.title).toBe(t('tags.merge_confirm_value0_value1', { value0: 'a', value1: 'b' }));
        expect(ask?.description).toBe(t('tags.merge_description'));
    });

    it('stays out of the way when nothing collides', async () => {
        seed('a/x', 'b/y');
        await renameTag(tag('a'), 'c');
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(api.tags.patch).toHaveBeenCalledWith('t-a', { name: 'c' });
    });

    it('aborts the rename when the warning is refused', async () => {
        seed('a/x', 'b/x');
        confirmSpy.mockResolvedValueOnce(false);
        await renameTag(tag('a'), 'b');
        expect(confirmSpy).toHaveBeenCalled();
        expect(api.tags.patch).not.toHaveBeenCalled();
        expect(useNotes.getState().tags.map((item) => item.name)).toContain('a/x');
    });

    it('warns for a drag-move that buries a child too', async () => {
        seed('a', 'a/x', 'b/a', 'b/a/x');
        await moveTag(tag('a'), 'b');
        expect(confirmSpy).toHaveBeenCalled();
        expect(api.tags.move).toHaveBeenCalledWith('t-a', 'b');
    });

    it('moves without asking when the branch has no clashes', async () => {
        seed('a', 'a/x', 'b');
        await moveTag(tag('a'), 'b');
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(api.tags.move).toHaveBeenCalledWith('t-a', 'b');
    });
});
