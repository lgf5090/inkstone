import { describe, expect, it } from 'vitest';
import { encodeDataValue } from '../../lib/markdown/data-attr';
import { TAG_MIME, beginTagDrag, currentTagDrag, droppedTagName, endTagDrag, findDroppedTag, isTagDrag } from './tagDrag';

function transfer(name: string | null): { bag: Map<string, string>, dataTransfer: DataTransfer } {
    const bag = new Map<string, string>();
    const dataTransfer = {
        types: [] as string[],
        setData: (key: string, value: string) => {
            bag.set(key, value);
        },
        getData: (key: string) => bag.get(key) ?? '',
    } as unknown as DataTransfer;
    if (name !== null)
        beginTagDrag(name, dataTransfer);
    Object.defineProperty(dataTransfer, 'types', { value: [...bag.keys()], configurable: true });
    return { bag, dataTransfer };
}

const WIDE_WORK = '\uFF37\uFF4F\uFF52\uFF4B';

describe('the tag drag bridge', () => {
    it('publishes an encoded tag type and the hashtag as plain text', () => {
        const { bag, dataTransfer } = transfer('work/meeting');
        expect(bag.get(TAG_MIME)).toBe(encodeDataValue('work/meeting'));
        expect(bag.get('text/plain')).toBe('#work/meeting');
        expect(dataTransfer.effectAllowed).toBe('move');
        expect(currentTagDrag()).toBe('work/meeting');
        endTagDrag();
        expect(currentTagDrag()).toBeNull();
    });

    it('reads the name back from the payload at drop time', () => {
        const { dataTransfer } = transfer('work');
        expect(isTagDrag(dataTransfer)).toBe(true);
        expect(droppedTagName(dataTransfer)).toBe('work');
        endTagDrag();
    });

    it('ignores a drag that does not carry the tag type even while a tag drag is in memory', () => {
        const foreign = new Map([['application/x-inkstone-note', 'n-1'], ['text/plain', 'Notes']]);
        const dataTransfer = { types: [...foreign.keys()], getData: (key: string) => foreign.get(key) ?? '' } as unknown as DataTransfer;
        transfer('work');
        expect(currentTagDrag()).toBe('work');
        expect(isTagDrag(dataTransfer)).toBe(false);
        expect(droppedTagName(dataTransfer)).toBeNull();
        endTagDrag();
        expect(currentTagDrag()).toBeNull();
    });

    it('recovers the in-memory name when a tag payload arrives unreadable', () => {
        const started = transfer('work');
        const stripped = { types: [TAG_MIME], getData: () => '' } as unknown as DataTransfer;
        expect(droppedTagName(stripped)).toBe('work');
        endTagDrag();
        expect(droppedTagName(stripped)).toBeNull();
        expect(started.bag.size).toBe(2);
    });

    it('matches the tag the payload names, not the spelling it used', () => {
        const tags = [{ name: 'work' }, { name: WIDE_WORK }, { name: 'job' }];
        expect(findDroppedTag(tags, 'WORK')?.name).toBe('work');
        expect(findDroppedTag(tags, WIDE_WORK)?.name).toBe('work');
        expect(findDroppedTag(tags, 'absent')).toBeNull();
    });
});
