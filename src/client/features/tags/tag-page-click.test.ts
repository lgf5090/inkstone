import { describe, expect, it } from 'vitest';
import { decodeDataValue } from '../../lib/markdown/data-attr';
import { renderMarkdown } from '../../lib/markdown/renderer';
import { wantsTagPage } from './tagMutations';

describe('the entrances a tag page has', () => {
    it('hands a rendered hashtag over as a drag and keeps its name readable', () => {
        const html = renderMarkdown('Notes about #work/meeting here\n').html;
        expect(html).toContain('draggable="true"');
        const encoded = /data-tag="([^"]+)"/.exec(html)?.[1];
        expect(decodeDataValue(encoded ?? '')).toBe('work/meeting');
    });

    it('reads alt or either modifier as a request for the tag page', () => {
        expect(wantsTagPage({ altKey: true, ctrlKey: false, metaKey: false })).toBe(true);
        expect(wantsTagPage({ altKey: false, ctrlKey: true, metaKey: false })).toBe(true);
        expect(wantsTagPage({ altKey: false, ctrlKey: false, metaKey: true })).toBe(true);
        expect(wantsTagPage({ altKey: false, ctrlKey: false, metaKey: false })).toBe(false);
    });
});
