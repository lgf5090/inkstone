import { describe, expect, it } from 'vitest';
import {
    MINDMAP_LANGUAGES,
    applyBodyAtFence,
    applyFencePatchAtSource,
    detectMindmapMode,
    insertTextAfterFence,
    mindmapFenceRange,
    replaceFenceWithText,
} from './body';
import { fenceAt } from '../fence-edit';

const JSON_BODY = '{"nodeData":{"topic":"Core","children":[{"topic":"Branch"}]}}';
const OUTLINE_BODY = '- Core\n  - Branch';

function note(...lines: string[]): string {
    return lines.join('\n');
}

describe('detectMindmapMode', () => {
    it.each([
        [JSON_BODY, 'json'],
        [`  \n${JSON_BODY}`, 'json'],
        [OUTLINE_BODY, 'outline'],
        ['', 'outline'],
        ['{not json', 'json'],
    ])('reads %s as %s', (body, mode) => {
        expect(detectMindmapMode(body)).toBe(mode);
    });
});

describe('MINDMAP_LANGUAGES', () => {
    it('names both the prose spelling and the library\'s own', () => {
        expect(MINDMAP_LANGUAGES).toEqual(['mindmap', 'mind-elixir']);
    });
});

describe('applyBodyAtFence', () => {
    it('replaces only the body, leaving every line outside the fence byte-identical', () => {
        const content = note('# Title', '', '```mindmap', OUTLINE_BODY, '```', '', 'After.');
        const next = applyBodyAtFence(content, { line: 2, body: OUTLINE_BODY }, '- New');
        expect(next).toBe(note('# Title', '', '```mindmap', '- New', '```', '', 'After.'));
    });

    it('keeps the note\'s CRLF line endings', () => {
        const content = ['a', '```mindmap', OUTLINE_BODY, '```', 'b'].join('\r\n');
        const next = applyBodyAtFence(content, { line: 1, body: OUTLINE_BODY }, '- New');
        expect(next).toBe(['a', '```mindmap', '- New', '```', 'b'].join('\r\n'));
    });

    it('finds the fence again when an edit above it has moved the line', () => {
        const content = note('intro', 'intro 2', '```mindmap', OUTLINE_BODY, '```');
        const next = applyBodyAtFence(content, { line: 0, body: OUTLINE_BODY }, '- New');
        expect(next).toBe(note('intro', 'intro 2', '```mindmap', '- New', '```'));
    });

    it('declines when the note no longer holds that body, rather than guessing', () => {
        const content = note('```mindmap', OUTLINE_BODY, '```');
        expect(applyBodyAtFence(content, { line: 0, body: '- Something else' }, '- New')).toBeNull();
    });

    it('declines when two fences still hold the same body', () => {
        const content = note('```mindmap', OUTLINE_BODY, '```', '', '```mindmap', OUTLINE_BODY, '```');
        expect(applyBodyAtFence(content, { line: 99, body: OUTLINE_BODY }, '- New')).toBeNull();
    });

    it('writes a fence inside a list item back at the fence\'s own indentation', () => {
        const content = note('- Item', '', '  ```mindmap', '  - Core', '  ```', '');
        const at = fenceAt(content, 2, MINDMAP_LANGUAGES);
        expect(at).not.toBeNull();
        const next = applyBodyAtFence(content, { line: 2, body: at!.body }, '- Replaced');
        expect(next).toBe(note('- Item', '', '  ```mindmap', '  - Replaced', '  ```', ''));
    });

    it('widens the fence when the new body contains a line that would close it', () => {
        const content = note('```mindmap', OUTLINE_BODY, '```');
        const next = applyBodyAtFence(content, { line: 0, body: OUTLINE_BODY }, '- a\n```\n- b');
        expect(next).toBe(note('````mindmap', '- a', '```', '- b', '````'));
    });

    it('writes into the alternative language spelling', () => {
        const content = note('```mind-elixir', OUTLINE_BODY, '```');
        expect(applyBodyAtFence(content, { line: 0, body: OUTLINE_BODY }, '- New'))
            .toBe(note('```mind-elixir', '- New', '```'));
    });

    it('closes a fence that the note left open, rather than writing past the end', () => {
        const content = note('```mindmap', OUTLINE_BODY);
        expect(applyBodyAtFence(content, { line: 0, body: OUTLINE_BODY }, '- New'))
            .toBe(note('```mindmap', '- New', '```'));
    });
});

describe('applyFencePatchAtSource', () => {
    it('adds the palette annotation without disturbing the rest of the info line', () => {
        const content = note('```mindmap title="Plan"', OUTLINE_BODY, '```');
        const next = applyFencePatchAtSource(content, { line: 0, body: OUTLINE_BODY }, { annotation: 'dark' });
        expect(next).toBe(note('```mindmap title="Plan" theme=dark', OUTLINE_BODY, '```'));
    });

    it('removes the annotation when the pick is the default, leaving the language alone', () => {
        const content = note('```mindmap theme=dark', OUTLINE_BODY, '```');
        const next = applyFencePatchAtSource(content, { line: 0, body: OUTLINE_BODY }, { annotation: null });
        expect(next).toBe(note('```mindmap', OUTLINE_BODY, '```'));
    });

    it('replaces an existing annotation rather than stacking a second one', () => {
        const content = note('```mindmap theme=dark', OUTLINE_BODY, '```');
        const next = applyFencePatchAtSource(content, { line: 0, body: OUTLINE_BODY }, { annotation: 'light' });
        expect(next).toBe(note('```mindmap theme=light', OUTLINE_BODY, '```'));
    });

    it('moves the body and the palette in one edit, so one undo takes both back', () => {
        const content = note('```mindmap theme=dark', OUTLINE_BODY, '```');
        const next = applyFencePatchAtSource(content, { line: 0, body: OUTLINE_BODY }, { body: '- New', annotation: 'light' });
        expect(next).toBe(note('```mindmap theme=light', '- New', '```'));
    });

    it('omitting the annotation leaves the info line exactly as the note has it', () => {
        const content = note('```mindmap theme=dark', OUTLINE_BODY, '```');
        const next = applyFencePatchAtSource(content, { line: 0, body: OUTLINE_BODY }, { body: '- New' });
        expect(next).toBe(note('```mindmap theme=dark', '- New', '```'));
    });

    it('declines to rewrite a fence that has moved out from under the map', () => {
        const content = note('```mindmap', '- Someone else edited this', '```');
        expect(applyFencePatchAtSource(content, { line: 0, body: OUTLINE_BODY }, { annotation: 'dark' })).toBeNull();
    });
});

describe('mindmapFenceRange', () => {
    it('spans the opening fence through the line after the closing one', () => {
        const content = note('a', '```mindmap', OUTLINE_BODY, '```', 'b');
        expect(mindmapFenceRange(content, { line: 1, body: OUTLINE_BODY })).toEqual({ start: 1, end: 5 });
    });

    it('runs to the end of the file when the fence was never closed', () => {
        const content = note('a', '```mindmap', OUTLINE_BODY);
        expect(mindmapFenceRange(content, { line: 1, body: OUTLINE_BODY })).toEqual({ start: 1, end: 4 });
    });

    it('is null for a body the note no longer holds', () => {
        expect(mindmapFenceRange(note('```mindmap', '- x', '```'), { line: 0, body: OUTLINE_BODY })).toBeNull();
    });
});

describe('replaceFenceWithText and insertTextAfterFence', () => {
    it('turns the whole block into the outline, fence included', () => {
        const content = note('intro', '', '```mindmap', OUTLINE_BODY, '```', '', 'outro');
        expect(replaceFenceWithText(content, { line: 2, body: OUTLINE_BODY }, '# Core\n\n- Branch'))
            .toBe(note('intro', '', '# Core', '', '- Branch', '', 'outro'));
    });

    it('appends the outline below the map and leaves the fence standing', () => {
        const content = note('```mindmap', OUTLINE_BODY, '```');
        expect(insertTextAfterFence(content, { line: 0, body: OUTLINE_BODY }, '# Core'))
            .toBe(note('```mindmap', OUTLINE_BODY, '```', '# Core'));
    });

    it('puts the outline on its own line below the closing fence', () => {
        const content = note('```mindmap', OUTLINE_BODY, '```');
        const withTrailing = `${content}\n`;
        expect(insertTextAfterFence(withTrailing, { line: 0, body: OUTLINE_BODY }, '# Core'))
            .toBe(note('```mindmap', OUTLINE_BODY, '```', '# Core') + '\n');
    });

    it('writes nothing extra for an empty text', () => {
        const content = note('```mindmap', OUTLINE_BODY, '```', '', 'after');
        expect(replaceFenceWithText(content, { line: 0, body: OUTLINE_BODY }, ''))
            .toBe(note('', 'after'));
    });

    it('both decline when the fence has moved', () => {
        const content = note('```mindmap', '- changed', '```');
        const ref = { line: 0, body: OUTLINE_BODY };
        expect(replaceFenceWithText(content, ref, '# x')).toBeNull();
        expect(insertTextAfterFence(content, ref, '# x')).toBeNull();
    });
});
