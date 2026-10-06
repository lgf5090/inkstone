import { describe, expect, it } from 'vitest';
import { markdownToMindmapOutline, mindmapOutlineToMarkdown } from './outline';

describe('markdownToMindmapOutline', () => {
    it('puts a heading at its own depth and nests a list one level below it', () => {
        expect(markdownToMindmapOutline('# Plan\n\n- Do\n- Ship')).toBe('- Plan\n  - Do\n  - Ship');
    });

    it('makes the shallowest heading the root, so a selection starting at ## still trees', () => {
        expect(markdownToMindmapOutline('## Section\n\n### Sub')).toBe('- Section\n  - Sub');
    });

    it('nests a list under the heading above it, not beside it', () => {
        expect(markdownToMindmapOutline('## A\n- B')).toBe('- A\n  - B');
    });

    it('keeps a list at the top when the text has no heading yet', () => {
        expect(markdownToMindmapOutline('- One\n  - Two')).toBe('- One\n  - Two');
    });

    it('counts a tab as two columns, the way the library\'s serializer indents', () => {
        expect(markdownToMindmapOutline('- One\n\t- Two')).toBe('- One\n  - Two');
    });

    it('reads an ordered list and a task item by their text', () => {
        expect(markdownToMindmapOutline('1. First\n2. Second')).toBe('- First\n- Second');
        expect(markdownToMindmapOutline('- [x] Done')).toBe('- Done');
    });

    it('drops the closing hashes of an ATX heading', () => {
        expect(markdownToMindmapOutline('## Plan ##')).toBe('- Plan');
    });

    it('keeps inline markup, including a wiki link, so the node can carry it', () => {
        expect(markdownToMindmapOutline('- See [[Other note]]')).toBe('- See [[Other note]]');
    });

    it('skips everything inside a fenced code block, whatever it looks like', () => {
        const source = ['# Plan', '', '```md', '- Not outline', '```', '', '- Real'].join('\n');
        expect(markdownToMindmapOutline(source)).toBe('- Plan\n  - Real');
    });

    it('resets the list indentation after a code block, so it cannot nest against a hidden level', () => {
        const source = ['- A', '', '```', '- x', '```', '', '  - B'].join('\n');
        expect(markdownToMindmapOutline(source)).toBe('- A\n- B');
    });

    it('returns null for text with nothing to draw, so the caller says so', () => {
        expect(markdownToMindmapOutline('Just a paragraph.\n\nAnd another.')).toBeNull();
        expect(markdownToMindmapOutline('')).toBeNull();
    });

    it('ignores a heading whose text is empty', () => {
        expect(markdownToMindmapOutline('#\n- A')).toBe('- A');
    });
});

describe('mindmapOutlineToMarkdown', () => {
    it('turns the first six levels into headings', () => {
        const outline = ['- L1', '  - L2', '    - L3'].join('\n');
        expect(mindmapOutlineToMarkdown(outline)).toBe('# L1\n## L2\n### L3');
    });

    it('falls back to a nested list past the sixth level, because that is where headings run out', () => {
        const outline = ['', '', '', '', '', ''].map((_, index) => `${'  '.repeat(index)}- L${index + 1}`).join('\n');
        const markdown = mindmapOutlineToMarkdown(outline);
        expect(markdown?.split('\n').slice(0, 6)).toEqual(['# L1', '## L2', '### L3', '#### L4', '##### L5', '###### L6']);
    });

    it('strips the style block the library writes after a topic', () => {
        expect(mindmapOutlineToMarkdown('- Plan {"color": "#e87a90"}')).toBe('# Plan');
    });

    it('strips a ref marker written at the end of the line', () => {
        expect(mindmapOutlineToMarkdown('- Plan [^ref-1]')).toBe('# Plan');
    });

    it('skips the arrow and summary lines, which are not topics', () => {
        expect(mindmapOutlineToMarkdown('- Plan\n  - > [^a] -> [^b]\n  - }Summary')).toBe('# Plan');
    });

    it('returns null for an outline with nothing but annotations', () => {
        expect(mindmapOutlineToMarkdown('- }Only a summary')).toBeNull();
    });
});

describe('the two directions agree', () => {
    it('lands an outline back on itself through a heading tree', () => {
        const outline = '- Plan\n  - Do\n    - Detail\n  - Ship';
        expect(markdownToMindmapOutline(mindmapOutlineToMarkdown(outline)!)).toBe(outline);
    });

    it('keeps a wiki link across the round trip', () => {
        const outline = '- Plan\n  - See [[Other note]]';
        expect(markdownToMindmapOutline(mindmapOutlineToMarkdown(outline)!)).toBe(outline);
    });
});
