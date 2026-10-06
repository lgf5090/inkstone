import { describe, expect, it } from 'vitest';
import type { Heading } from '../../lib/markdown/renderer';
import {
    activeHeadingIndex,
    buildOutlineTree,
    clamp,
    collapsedToLevel,
    compileFilter,
    computeHiddenByCollapse,
    filterTree,
    parentSlugs,
    pruneCollapsed,
    readingProgress,
    stringifyOutline,
    truncateHeading,
    ancestorIndices,
} from './outline-tree';

function heading(level: number, text: string, slug = text.toLowerCase().replace(/\s+/g, '-')): Heading {
    return { level, text, slug, line: 0 };
}

describe('buildOutlineTree', () => {
    it('nests by the headings around it, so a skipped level only indents one step', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(3, 'B'), heading(6, 'C')]);
        expect(tree.map((n) => n.tier)).toEqual([0, 1, 2]);
        expect(tree.map((n) => n.parentIndex)).toEqual([-1, 0, 1]);
    });

    it('closes branches when a heading returns to an earlier level', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(2, 'B'), heading(4, 'C'), heading(2, 'D'), heading(1, 'E')]);
        expect(tree.map((n) => n.tier)).toEqual([0, 1, 2, 1, 0]);
        expect(tree.map((n) => n.parentIndex)).toEqual([-1, 0, 1, 0, -1]);
    });

    it('marks only rows with a deeper successor as collapsible', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(2, 'B'), heading(1, 'C')]);
        expect(tree.map((n) => n.hasChildren)).toEqual([true, false, false]);
        expect(parentSlugs(tree)).toEqual(['a']);
    });

    it('treats a document starting deep as a root row', () => {
        const tree = buildOutlineTree([heading(3, 'A'), heading(4, 'B')]);
        expect(tree[0]!.tier).toBe(0);
        expect(tree[0]!.parentIndex).toBe(-1);
        expect(tree[1]!.tier).toBe(1);
    });

    it('handles an empty document', () => {
        expect(buildOutlineTree([])).toEqual([]);
    });
});

describe('collapsedToLevel', () => {
    const tree = () => buildOutlineTree([heading(1, 'A'), heading(2, 'B'), heading(3, 'C'), heading(2, 'D')]);

    it('collapses every parent at level one, leaving only top rows', () => {
        expect(collapsedToLevel(tree(), 1)).toEqual(new Set(['a', 'b']));
    });

    it('keeps level one open and collapses from level two down', () => {
        expect(collapsedToLevel(tree(), 2)).toEqual(new Set(['b']));
    });

    it('collapses nothing once past the deepest parent', () => {
        expect(collapsedToLevel(tree(), 6)).toEqual(new Set());
    });
});

describe('pruneCollapsed', () => {
    it('drops slugs that are gone or no longer parents', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(2, 'B')]);
        const pruned = pruneCollapsed(tree, new Set(['a', 'b', 'gone']));
        expect(pruned).toEqual(new Set(['a']));
    });

    it('returns the same instance when nothing changed', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(2, 'B')]);
        const before = new Set(['a']);
        expect(pruneCollapsed(tree, before)).toBe(before);
    });
});

describe('computeHiddenByCollapse', () => {
    const headings = [heading(1, 'A'), heading(2, 'B'), heading(3, 'C'), heading(1, 'D')];

    it('hides a whole subtree below the collapsed parent', () => {
        const hidden = computeHiddenByCollapse(buildOutlineTree(headings), new Set(['a']));
        expect(hidden).toEqual([false, true, true, false]);
    });

    it('hides descendants of an already hidden ancestor', () => {
        const hidden = computeHiddenByCollapse(buildOutlineTree(headings), new Set(['b']));
        expect(hidden).toEqual([false, false, true, false]);
    });

    it('keeps everything visible with nothing collapsed', () => {
        const hidden = computeHiddenByCollapse(buildOutlineTree(headings), new Set());
        expect(hidden).toEqual([false, false, false, false]);
    });

    it('hides the same rows whether the top or the nested parent is collapsed', () => {
        const tree = buildOutlineTree(headings);
        expect(computeHiddenByCollapse(tree, new Set(['a', 'b']))).toEqual(computeHiddenByCollapse(tree, new Set(['a'])));
    });
});

describe('compileFilter', () => {
    it('matches substrings without regard to case', () => {
        const test = compileFilter('SET', false);
        expect(test('Setting Up')).toBe(true);
        expect(test('Usage')).toBe(false);
    });

    it('matches a valid regex against the raw text', () => {
        const test = compileFilter('^set', true);
        expect(test('Setting')).toBe(true);
        expect(test('Reset')).toBe(false);
    });

    it('matches everything while the regex is still unparseable', () => {
        const test = compileFilter('set(', true);
        expect(test('anything')).toBe(true);
        expect(test('other')).toBe(true);
    });
});

describe('filterTree', () => {
    const tree = () => buildOutlineTree([heading(1, 'Alpha'), heading(2, 'Beta'), heading(3, 'Gamma'), heading(1, 'Delta')]);

    it('reports every row visible with no query', () => {
        const result = filterTree(tree(), '   ', false);
        expect(result.visible).toEqual([true, true, true, true]);
    });

    it('keeps the ancestors of a match so the path to it stays visible', () => {
        const result = filterTree(tree(), 'gamma', false);
        expect(result.visible).toEqual([true, true, true, false]);
        expect(result.matchCount).toBe(1);
    });

    it('shows only the matching root when a branch has no match', () => {
        const result = filterTree(tree(), 'delta', false);
        expect(result.visible).toEqual([false, false, false, true]);
        expect(result.matchCount).toBe(1);
    });

    it('counts matches without counting the ancestors kept for them', () => {
        // One and Two match; Alpha is drawn only because a child of it matched.
        const branches = buildOutlineTree([heading(1, 'Alpha'), heading(2, 'One'), heading(2, 'Two'), heading(1, 'Beta'), heading(2, 'Three')]);
        const result = filterTree(branches, 'o', false);
        expect(result.matchCount).toBe(2);
        expect(result.visible).toEqual([true, true, true, false, false]);
    });
});

describe('readingProgress', () => {
    it('treats a document that already fits as finished', () => {
        expect(readingProgress(0, 400, 600)).toBe(1);
    });

    it('stays at zero at the top of a scrollable document', () => {
        expect(readingProgress(0, 1000, 400)).toBe(0);
    });

    it('reaches one at the bottom', () => {
        expect(readingProgress(600, 1000, 400)).toBe(1);
    });

    it('clamps values pushed past either end', () => {
        expect(readingProgress(-50, 1000, 400)).toBe(0);
        expect(readingProgress(9999, 1000, 400)).toBe(1);
    });
});

describe('activeHeadingIndex', () => {
    it('returns -1 for an empty list', () => {
        expect(activeHeadingIndex([], 10, false)).toBe(-1);
    });

    it('selects the last heading once the document is scrolled to its end', () => {
        expect(activeHeadingIndex([0, 100, 200], 5, true)).toBe(2);
    });

    it('picks the last heading at or above the threshold', () => {
        expect(activeHeadingIndex([0, 100, 200], 150, false)).toBe(1);
    });

    it('agrees with a linear scan across every threshold', () => {
        const tops = [0, 20, 20, 45, 90, 120, 120];
        for (let threshold = -10; threshold < 140; threshold++) {
            let expected = -1;
            for (let i = 0; i < tops.length; i++) if (tops[i]! <= threshold) expected = i;
            expect(activeHeadingIndex(tops, threshold, false)).toBe(expected);
        }
    });
});

describe('clamp', () => {
    it('keeps an empty range from inverting', () => {
        expect(clamp(5, 9, 2)).toBe(9);
    });
});

describe('stringifyOutline', () => {
    it('indents by visual tier, so a skipped level exports as one step', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(3, 'B'), heading(3, 'C')]);
        expect(stringifyOutline(tree, { numbering: false, indent: '\t' })).toBe('A\n\tB\n\tC');
    });

    it('numbers hierarchically and resets a deeper counter on a new sibling', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(2, 'B'), heading(3, 'C'), heading(2, 'D'), heading(1, 'E')]);
        expect(stringifyOutline(tree, { numbering: true, indent: '' })).toBe('1 A\n1.1 B\n1.1.1 C\n1.2 D\n2 E');
    });

    it('returns an empty string for an empty outline', () => {
        expect(stringifyOutline([], { numbering: true, indent: '  ' })).toBe('');
    });

    it('keeps raw heading text untouched', () => {
        const tree = buildOutlineTree([heading(1, 'Uses `code` and **bold**')]);
        expect(stringifyOutline(tree, { numbering: false, indent: '' })).toBe('Uses `code` and **bold**');
    });
});

describe('truncateHeading', () => {
    it('leaves text alone when no limit is set', () => {
        expect(truncateHeading('A reasonably long heading', 0)).toBe('A reasonably long heading');
    });

    it('leaves text at or under the limit untouched', () => {
        expect(truncateHeading('Twelve chars', 12)).toBe('Twelve chars');
    });

    it('ellipsises past the limit without exceeding it', () => {
        const out = truncateHeading('abcdefghijklmnop', 10);
        expect(out).toBe('abcdefghi…');
        expect(out.length).toBe(10);
    });

    it('never returns an empty string for a tiny limit', () => {
        expect(truncateHeading('abcdef', 1)).toBe('…');
    });

    it('trims a word-break tail before the ellipsis', () => {
        expect(truncateHeading('short tail here', 11)).toBe('short tail…');
    });
});

describe('ancestorIndices', () => {
    it('walks the parent chain nearest first', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(2, 'B'), heading(3, 'C')]);
        expect(ancestorIndices(tree, 2)).toEqual([1, 0]);
    });

    it('is empty for a root row', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(2, 'B')]);
        expect(ancestorIndices(tree, 0)).toEqual([]);
    });

    it('skips a tier when the document jumps levels', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(4, 'B')]);
        expect(ancestorIndices(tree, 1)).toEqual([0]);
    });

    it('is empty for an out-of-range index', () => {
        expect(ancestorIndices(buildOutlineTree([heading(1, 'A')]), 42)).toEqual([]);
    });

    it('terminates on a cycle rather than looping forever', () => {
        const tree = buildOutlineTree([heading(1, 'A'), heading(2, 'B')]);
        tree[0]!.parentIndex = 1;
        expect(ancestorIndices(tree, 1).length).toBeLessThanOrEqual(tree.length);
    });
});
