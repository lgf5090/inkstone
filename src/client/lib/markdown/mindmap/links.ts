/**
 * Recognising a mind map node that is a link to another note.
 *
 * The link lives in the node's topic, written the way it would be written in
 * prose: `[[Target note]]`. That is the one place both body formats carry — the
 * outline format has no per-node fields, and the library's own `hyperLink` is
 * written for the open web (it renders an anchor that opens a new tab and is
 * dropped by the outline serializer), so neither was an option. A topic is
 * plain text to the library either way, so this round-trips.
 */

/** The whole topic, nothing around it: a topic that merely mentions a note stays text. */
const NODE_LINK_RE = /^\[\[([^[\]\n]{1,400})\]\]$/;

/** Any `[[...]]` occurrence inside the topic, so a topic can carry a link among other text. */
const EMBEDDED_LINK_RE = /\[\[([^[\]\n]{1,400})\]\]/g;

/**
 * The wiki target a node points at, or null when the topic is not one. Matches
 * `parseWikiTarget`'s own input, so the result is handed straight to it.
 */
export function parseMindmapNodeLink(topic: string): string | null {
    const match = NODE_LINK_RE.exec(topic.trim());
    if (!match)
        return null;
    const target = match[1]!.trim();
    return target.length > 0 ? target : null;
}

/** One piece of a topic: plain text, or a wiki link with its target. */
export interface MindmapTopicSegment {
    text: string
    /** The wiki target when this segment came from a `[[...]]`, absent for plain text. */
    target?: string
}

/**
 * Splits a topic into plain-text and wiki-link segments in reading order, so a
 * node like `Community [[AGENTS.md]]` keeps both. An empty or blank `[[ ]]` is
 * left as literal text, mirroring the prose renderer.
 */
export function splitMindmapTopicLinks(topic: string): MindmapTopicSegment[] {
    const segments: MindmapTopicSegment[] = [];
    let cursor = 0;
    for (const match of topic.matchAll(EMBEDDED_LINK_RE)) {
        const target = match[1]!.trim();
        if (!target)
            continue;
        const start = match.index!;
        if (start > cursor)
            segments.push({ text: topic.slice(cursor, start) });
        segments.push({ text: target, target });
        cursor = start + match[0].length;
    }
    const rest = topic.slice(cursor);
    if (rest)
        segments.push({ text: rest });
    return segments;
}
