import { describe, expect, it } from 'vitest';
import type { Heading } from '../../lib/markdown/renderer';
import {
    changeHeadingLevel,
    changeSectionLevels,
    deleteSection,
    moveSection,
    renameHeading,
    sectionRange,
    siblingIndices,
    descendantIndices,
} from './outline-sections';

/**
 * Code fences deliberately hold `#` and `## ` lines, so an implementation that scans text with a
 * regex instead of the parsed heading list is caught by the very first level-change assertion.
 */
const DOC = [
    '---',
    'title: front matter',
    '---',
    '',
    '# Alpha',
    '',
    'alpha body',
    '```bash',
    '# not a heading',
    '## also not a heading',
    '```',
    '',
    '## Beta',
    '',
    'beta body',
    '',
    '### Gamma',
    '',
    'gamma body',
    '',
    '## Delta',
    '',
    'delta body',
    '',
    '# Echo',
    '',
    'echo body',
];

function parse(lines: string[]): Heading[] {
    const out: Heading[] = [];
    let inFence = false;
    lines.forEach((line, number) => {
        if (/^```/.test(line)) {
            inFence = !inFence;
            return;
        }
        if (inFence || number < 4) return;
        const match = /^(#{1,6})\s+(.+)$/.exec(line);
        if (match) out.push({ level: match[1]!.length, text: match[2]!, slug: match[2]!.toLowerCase(), line: number });
    });
    return out;
}

const HEADINGS = parse(DOC);
const lineOf = (text: string) => HEADINGS.find((h) => h.text === text)!.line;
const indexOf = (text: string) => HEADINGS.findIndex((h) => h.text === text);
const texts = (indices: number[]) => indices.map((i) => HEADINGS[i]!.text);

describe('sectionRange', () => {
    it('ends at the next heading of the same or shallower level', () => {
        // Gamma is nested under Beta, so Beta's section runs past it to the next level-2 heading.
        expect(sectionRange(HEADINGS, indexOf('Beta'), DOC.length)).toEqual({ start: lineOf('Beta'), end: lineOf('Delta') });
    });

    it('keeps nested headings inside the section', () => {
        expect(sectionRange(HEADINGS, indexOf('Alpha'), DOC.length)).toEqual({ start: lineOf('Alpha'), end: lineOf('Echo') });
    });

    it('clamps the final section to the end of the document', () => {
        expect(sectionRange(HEADINGS, indexOf('Echo'), DOC.length).end).toBe(DOC.length);
    });

    it('never returns an empty range for a heading on the last line', () => {
        expect(sectionRange([{ level: 2, text: 'Two', slug: 'two', line: 1 }], 0, 2)).toEqual({ start: 1, end: 2 });
    });

    it('returns an empty range for an out-of-bounds index', () => {
        expect(sectionRange(HEADINGS, 99, DOC.length)).toEqual({ start: 0, end: 0 });
    });
});

describe('descendantIndices and siblingIndices', () => {
    it('lists every nested heading under a parent', () => {
        expect(texts(descendantIndices(HEADINGS, indexOf('Alpha')))).toEqual(['Beta', 'Gamma', 'Delta']);
    });

    it('lists nothing for a leaf heading', () => {
        expect(descendantIndices(HEADINGS, indexOf('Gamma'))).toEqual([]);
    });

    it('groups headings that share a parent', () => {
        expect(texts(siblingIndices(HEADINGS, indexOf('Beta')))).toEqual(['Beta', 'Delta']);
    });

    it('does not treat same-level headings under different parents as siblings', () => {
        expect(siblingIndices(HEADINGS, indexOf('Gamma'))).toEqual([indexOf('Gamma')]);
    });

    it('collects all top-level headings as siblings', () => {
        expect(texts(siblingIndices(HEADINGS, indexOf('Alpha')))).toEqual(['Alpha', 'Echo']);
    });
});

describe('changeSectionLevels', () => {
    it('shifts the section and its nested headings, leaving code fences alone', () => {
        const next = changeSectionLevels(DOC, HEADINGS, indexOf('Alpha'), 1);
        expect(next[lineOf('Alpha')]).toBe('## Alpha');
        expect(next[lineOf('Beta')]).toBe('### Beta');
        expect(next[lineOf('Gamma')]).toBe('#### Gamma');
        expect(next[lineOf('Echo')]).toBe('# Echo');
        expect(next[8]).toBe('# not a heading');
        expect(next[9]).toBe('## also not a heading');
    });

    it('clamps at level six instead of producing seven hashes', () => {
        const next = changeSectionLevels(DOC, HEADINGS, indexOf('Alpha'), 4);
        expect(next[lineOf('Alpha')]).toBe('##### Alpha');
        expect(next[lineOf('Beta')]).toBe('###### Beta');
        expect(next[lineOf('Gamma')]).toBe('###### Gamma');
    });

    it('clamps at level one when demoting past the top', () => {
        expect(changeSectionLevels(DOC, HEADINGS, indexOf('Gamma'), -5)[lineOf('Gamma')]).toBe('# Gamma');
    });

    it('leaves the document untouched for a zero delta', () => {
        expect(changeSectionLevels(DOC, HEADINGS, indexOf('Beta'), 0)).toEqual(DOC);
    });

    it('preserves title markup and leading spaces', () => {
        const lines = ['##  Title **with** markup ', 'body'];
        const headings = [{ level: 2, text: 'Title **with** markup', slug: 't', line: 0 }];
        expect(changeSectionLevels(lines, headings, 0, 1)[0]).toBe('###  Title **with** markup ');
    });
});

describe('changeHeadingLevel', () => {
    it('changes only the heading line, not its section', () => {
        const next = changeHeadingLevel(DOC, HEADINGS[indexOf('Beta')]!, 3);
        expect(next[lineOf('Beta')]).toBe('### Beta');
        expect(next[lineOf('Gamma')]).toBe('### Gamma');
    });

    it('is a no-op for the level the heading already has', () => {
        expect(changeHeadingLevel(DOC, HEADINGS[indexOf('Beta')]!, 2)).toEqual(DOC);
    });
});

describe('renameHeading', () => {
    it('replaces the title and keeps the hashes', () => {
        expect(renameHeading(DOC, HEADINGS[indexOf('Beta')]!, 'Renamed')[lineOf('Beta')]).toBe('## Renamed');
    });

    it('drops trailing whitespace from the heading line', () => {
        const heading: Heading = { level: 2, text: 'Old', slug: 'old', line: 0 };
        expect(renameHeading(['## Old   ', 'body'], heading, 'New')[0]).toBe('## New');
    });

    it('leaves the section body untouched and the length unchanged', () => {
        const next = renameHeading(DOC, HEADINGS[indexOf('Beta')]!, 'Renamed');
        expect(next[lineOf('Beta') + 2]).toBe('beta body');
        expect(next.length).toBe(DOC.length);
    });
});

describe('deleteSection', () => {
    it('removes the heading and its body but stops at the next sibling', () => {
        const next = deleteSection(DOC, HEADINGS, indexOf('Beta'));
        expect(next).not.toContain('## Beta');
        expect(next).not.toContain('beta body');
        expect(next).not.toContain('### Gamma');
        expect(next).not.toContain('gamma body');
        expect(next).toContain('## Delta');
    });

    it('removes a whole subtree from the parent heading', () => {
        const next = deleteSection(DOC, HEADINGS, indexOf('Alpha'));
        expect(next).not.toContain('# Alpha');
        expect(next).not.toContain('## Beta');
        expect(next).not.toContain('### Gamma');
        expect(next).not.toContain('## Delta');
        expect(next).toContain('# Echo');
        expect(next).toContain('echo body');
    });

    it('keeps front matter and unrelated sections byte-identical', () => {
        const next = deleteSection(DOC, HEADINGS, indexOf('Delta'));
        expect(next.slice(0, 4)).toEqual(DOC.slice(0, 4));
        expect(next).toContain('## Beta');
        expect(next).toContain('# Echo');
    });
});

describe('moveSection', () => {
    it('refuses to move a heading onto itself', () => {
        expect(moveSection(DOC, HEADINGS, indexOf('Beta'), indexOf('Beta'), 'before')).toBeNull();
    });

    it('refuses to move a parent inside its own subtree', () => {
        expect(moveSection(DOC, HEADINGS, indexOf('Alpha'), indexOf('Gamma'), 'inside')).toBeNull();
    });

    it('inserts before the target and re-levels to match', () => {
        const next = moveSection(DOC, HEADINGS, indexOf('Echo'), indexOf('Beta'), 'before')!;
        const text = next.join('\n');
        expect(text.indexOf('## Echo')).toBeLessThan(text.indexOf('## Beta'));
        expect(next).toContain('echo body');
        expect(next.length).toBe(DOC.length);
    });

    it('carries the whole section, including nested headings', () => {
        const next = moveSection(DOC, HEADINGS, indexOf('Beta'), indexOf('Echo'), 'inside')!;
        const text = next.join('\n');
        const echoAt = text.indexOf('# Echo');
        // Echo is level 1, so a level-2 section moved inside it needs no re-levelling.
        expect(text.indexOf('## Beta', echoAt)).toBeGreaterThan(-1);
        expect(text.indexOf('### Gamma', echoAt)).toBeGreaterThan(-1);
        expect(text.indexOf('## Delta')).toBeLessThan(echoAt);
    });

    it('keeps code fence contents byte-identical through a move', () => {
        const next = moveSection(DOC, HEADINGS, indexOf('Alpha'), indexOf('Echo'), 'after')!;
        expect(next).toContain('# not a heading');
        expect(next).toContain('## also not a heading');
        expect(next.filter((l) => l.startsWith('```'))).toHaveLength(2);
    });

    it('produces a document whose headings re-parse to the expected shape', () => {
        const next = moveSection(DOC, HEADINGS, indexOf('Gamma'), indexOf('Echo'), 'inside')!;
        expect(parse(next).map((h) => `${h.level}:${h.text}`)).toEqual(['1:Alpha', '2:Beta', '2:Delta', '1:Echo', '2:Gamma']);
    });

    it('neither loses nor duplicates any line for every possible move', () => {
        // Normalising the leading hashes means any lost, duplicated or altered body line fails
        // here, while a legitimate re-levelling still passes.
        const normalised = (list: string[]) => list.map((line) => line.replace(/^ {0,3}#{1,6}/, 'H')).sort().join('|');
        const expected = normalised(DOC);
        for (let from = 0; from < HEADINGS.length; from++) {
            for (let to = 0; to < HEADINGS.length; to++) {
                for (const position of ['before', 'after', 'inside'] as const) {
                    const next = moveSection(DOC, HEADINGS, from, to, position);
                    if (!next) continue;
                    expect(next.length).toBe(DOC.length);
                    expect(normalised(next)).toBe(expected);
                }
            }
        }
    });

    it('keeps the document parseable after every move', () => {
        for (let from = 0; from < HEADINGS.length; from++) {
            for (let to = 0; to < HEADINGS.length; to++) {
                const next = moveSection(DOC, HEADINGS, from, to, 'inside');
                if (!next) continue;
                const reparsed = parse(next);
                expect(reparsed.length).toBe(HEADINGS.length);
                expect(reparsed.every((h) => h.level >= 1 && h.level <= 6)).toBe(true);
            }
        }
    });
});
