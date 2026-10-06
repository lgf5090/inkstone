import type { Heading } from '../../lib/markdown/renderer';

export interface SectionRange {
    /** Zero-based line of the heading itself. */
    start: number;
    /** Exclusive end: the first line after this heading's section. */
    end: number;
}

export const MAX_HEADING_LEVEL = 6;

/**
 * A section runs from its heading down to the next heading that is no deeper than it, so nested
 * headings belong to the outer section. `end` is exclusive and clamps to the document's last line.
 */
export function sectionRange(headings: Heading[], index: number, totalLines: number): SectionRange {
    const heading = headings[index];
    if (!heading)
        return { start: 0, end: 0 };
    let end = totalLines;
    for (let next = index + 1; next < headings.length; next++) {
        if (headings[next]!.level <= heading.level) {
            end = headings[next]!.line;
            break;
        }
    }
    return { start: heading.line, end: Math.max(end, heading.line + 1) };
}

/** Indices of every heading nested inside the given one, deepest reach included. */
export function descendantIndices(headings: Heading[], index: number): number[] {
    const range = sectionRange(headings, index, Number.MAX_SAFE_INTEGER);
    const out: number[] = [];
    for (let i = index + 1; i < headings.length; i++) {
        const line = headings[i]!.line;
        if (line >= range.end) break;
        if (line > range.start) out.push(i);
    }
    return out;
}

/** Indices sharing the same parent and level, always including the heading itself. */
export function siblingIndices(headings: Heading[], index: number): number[] {
    const self = headings[index];
    if (!self) return [];
    const parentLineOf = (i: number): number => {
        for (let j = i - 1; j >= 0; j--)
            if (headings[j]!.level < self.level) return headings[j]!.line;
        return -1;
    };
    const parent = parentLineOf(index);
    const out: number[] = [];
    for (let i = 0; i < headings.length; i++) {
        if (headings[i]!.level === self.level && parentLineOf(i) === parent) out.push(i);
    }
    return out;
}

function rewriteHeadingLine(line: string, level: number): string {
    const match = /^( {0,3})(#{1,6})([ \t]+|(?=\s*$))(.*)$/.exec(line);
    if (!match)
        return line;
    return `${match[1]}${'#'.repeat(level)}${match[3] || ' '}${match[4]}`;
}

/**
 * Shifts every heading inside the range by `delta`. Lines are matched against the parsed heading
 * list rather than a `#` regex, so a shell comment inside a fenced block is never touched.
 */
export function changeSectionLevels(lines: string[], headings: Heading[], index: number, delta: number): string[] {
    const range = sectionRange(headings, index, lines.length);
    const targets = new Map<number, number>();
    for (const heading of headings) {
        if (heading.line < range.start || heading.line >= range.end) continue;
        targets.set(heading.line, Math.min(MAX_HEADING_LEVEL, Math.max(1, heading.level + delta)));
    }
    return lines.map((line, number) => {
        const level = targets.get(number);
        return level === undefined ? line : rewriteHeadingLine(line, level);
    });
}

/** Single-line level change for the heading itself, leaving its section alone. */
export function changeHeadingLevel(lines: string[], heading: Heading, level: number): string[] {
    const next = [...lines];
    const clamped = Math.min(MAX_HEADING_LEVEL, Math.max(1, level));
    if (clamped === heading.level) return next;
    next[heading.line] = rewriteHeadingLine(next[heading.line] ?? '', clamped);
    return next;
}

/** Replaces one heading's title text, keeping its `#` prefix and trailing whitespace intact. */
export function renameHeading(lines: string[], heading: Heading, title: string): string[] {
    const next = [...lines];
    next[heading.line] = rewriteHeadingLine(next[heading.line] ?? '', heading.level).replace(/\s+$/, '');
    const prefix = /^( {0,3}#{1,6}[ \t]+)/.exec(next[heading.line] ?? '')?.[1] ?? `${'#'.repeat(heading.level)} `;
    next[heading.line] = `${prefix}${title}`;
    return next;
}

/** Drops the heading and everything down to (but excluding) the next section of its own level. */
export function deleteSection(lines: string[], headings: Heading[], index: number): string[] {
    const range = sectionRange(headings, index, lines.length);
    return [...lines.slice(0, range.start), ...lines.slice(range.end)];
}

export type DropPosition = 'before' | 'after' | 'inside';

/**
 * Splits the hovered row vertically: the top and bottom bands drop alongside it, the middle band
 * makes the dragged heading a child. The bands are wide enough that a row cannot be ambiguous.
 */
export function dropPositionFor(clientY: number, top: number, height: number): DropPosition {
    if (height <= 0) return 'inside';
    const offset = (clientY - top) / height;
    if (offset < 0.34) return 'before';
    if (offset > 0.66) return 'after';
    return 'inside';
}

/**
 * Relocates a whole section and re-levels it to fit its new parent. Deleting first would shift the
 * target, so both ranges are measured against the untouched document and reassembly walks it once.
 */
export function moveSection(lines: string[], headings: Heading[], from: number, to: number, position: DropPosition): string[] | null {
    if (from === to) return null;
    const source = headings[from];
    const target = headings[to];
    if (!source || !target) return null;
    const fromRange = sectionRange(headings, from, lines.length);
    const toRange = sectionRange(headings, to, lines.length);
    if (fromRange.start <= toRange.start && toRange.start < fromRange.end)
        return null;
    const block = lines.slice(fromRange.start, fromRange.end);
    const delta = position === 'inside'
        ? target.level + 1 - source.level
        : target.level - source.level;
    const relevelled = delta === 0
        ? block
        : block.map((line, offset) => {
            const number = fromRange.start + offset;
            const heading = headings.find((h) => h.line === number);
            if (!heading) return line;
            const level = Math.min(MAX_HEADING_LEVEL, Math.max(1, heading.level + delta));
            return rewriteHeadingLine(line, level);
        });
    const insertAt = position === 'inside'
        ? toRange.end
        : position === 'after'
            ? toRange.end
            : toRange.start;
    const withoutBlock = [...lines.slice(0, fromRange.start), ...lines.slice(fromRange.end)];
    const adjusted = insertAt > fromRange.start ? insertAt - (fromRange.end - fromRange.start) : insertAt;
    return [...withoutBlock.slice(0, adjusted), ...relevelled, ...withoutBlock.slice(adjusted)];
}
