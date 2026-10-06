/**
 * Converting between a Markdown outline (headings and nested lists) and the
 * library's plaintext tree format — the body an `outline` mind map fence stores.
 *
 * DOM-free and vendor-free on purpose: both directions are pure text work, so
 * they are testable without mind-elixir and usable from the preview and the
 * full screen view alike. The tree format itself is the library's (see ./mind-elixir-vendor),
 * so nothing here parses indentation the map will later re-read with different rules.
 */
import { normalizeEol } from './body';

/** Depth 0-5 becomes a heading; anything deeper falls back to a nested list. */
const HEADING_DEPTHS = 6;

/** A fenced code block: its content is not outline, whatever it looks like. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/;
const OUTLINE_ITEM_RE = /^([ \t]*)-[ \t]+(.*)$/;
/** Trailing `[^refId]` and inline `{...}` style, both written by the library's serializer. */
const OUTLINE_STYLE_RE = /\s*\{[^}]*\}\s*$/;
const OUTLINE_REF_RE = /\s*\[\^[^\]]*\]\s*$/;

/** Tabs count as two columns, matching how the library's own serializer indents. */
function indentWidth(indent: string): number {
    return indent.replace(/\t/g, '  ').length;
}

/**
 * The topic a Markdown line contributes: for a heading the text after the
 * hashes (a closing run of them is decoration, not part of the title), for a
 * list item the text after the marker. Anything else keeps its inline markup —
 * a `[[wiki link]]` has to survive into the node.
 */
function cleanTopic(text: string): string {
    return text.replace(/\s+#+\s*$/, '').trim();
}

/** What the library writes after a topic that is not part of it. */
function stripOutlineSuffix(text: string): string {
    return text.replace(OUTLINE_STYLE_RE, '').replace(OUTLINE_REF_RE, '').trim();
}

/** Arrow and summary lines (`- > [^a] -> [^b]`, `- }label`) are not topics. */
function isOutlineAnnotation(topic: string): boolean {
    return topic.startsWith('>') || topic.startsWith('}');
}

/**
 * Reads headings and list items into the library's tree format: an ATX heading
 * of level N sits at depth N-1, and a list nests one level under the heading
 * above it (or at the top when the selection has no heading yet). Depths are
 * shifted afterwards so the shallowest entry is the root, which is what makes a
 * selection that starts at `##` produce a tree instead of an indented orphan.
 *
 * Returns null when there is nothing to draw, so the caller can say so instead
 * of inserting an empty fence. Several top-level entries are returned as they
 * are: the parser wraps them under one root of its own (see ./mind-elixir-vendor).
 */
export function markdownToMindmapOutline(markdown: string): string | null {
    const entries: { depth: number; topic: string }[] = [];
    const indents: number[] = [];
    let headingDepth = -1;
    let fence: string | null = null;
    for (const line of normalizeEol(markdown).split('\n')) {
        const fenceMarker = FENCE_RE.exec(line)?.[1];
        if (fence !== null) {
            if (fenceMarker && fenceMarker.charAt(0) === fence)
                fence = null;
            continue;
        }
        if (fenceMarker) {
            fence = fenceMarker.charAt(0);
            indents.length = 0;
            continue;
        }
        const heading = HEADING_RE.exec(line);
        if (heading) {
            headingDepth = heading[1]!.length - 1;
            indents.length = 0;
            const topic = cleanTopic(heading[2]!);
            if (topic)
                entries.push({ depth: headingDepth, topic });
            continue;
        }
        const item = LIST_RE.exec(line);
        if (!item)
            continue;
        const width = indentWidth(item[1]!);
        while (indents.length > 0 && indents[indents.length - 1]! >= width)
            indents.pop();
        indents.push(width);
        const topic = cleanTopic(item[2]!);
        if (topic)
            entries.push({ depth: (headingDepth < 0 ? 0 : headingDepth + 1) + indents.length - 1, topic });
    }
    if (entries.length === 0)
        return null;
    const shallowest = Math.min(...entries.map((entry) => entry.depth));
    return entries.map(({ depth, topic }) => `${'  '.repeat(depth - shallowest)}- ${topic}`).join('\n');
}

/**
 * The inverse: a tree as Markdown headings, with levels past the sixth written
 * as a nested list because that is where headings run out. The two directions
 * agree on depth, so a round trip through a mind map lands on the outline it
 * came from.
 */
export function mindmapOutlineToMarkdown(outline: string): string | null {
    const lines: string[] = [];
    const indents: number[] = [];
    for (const line of normalizeEol(outline).split('\n')) {
        const item = OUTLINE_ITEM_RE.exec(line);
        if (!item)
            continue;
        const topic = stripOutlineSuffix(item[2]!);
        if (!topic || isOutlineAnnotation(topic))
            continue;
        const width = indentWidth(item[1]!);
        while (indents.length > 0 && indents[indents.length - 1]! >= width)
            indents.pop();
        indents.push(width);
        const depth = indents.length - 1;
        lines.push(depth < HEADING_DEPTHS
            ? `${'#'.repeat(depth + 1)} ${topic}`
            : `${'  '.repeat(depth - HEADING_DEPTHS)}- ${topic}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
}
