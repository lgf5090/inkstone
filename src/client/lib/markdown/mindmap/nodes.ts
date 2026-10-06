/**
 * What mind-elixir is allowed to do with a body the note wrote.
 *
 * The library builds its DOM imperatively, so the block's markup passing the prose
 * sanitizer says nothing about what the map itself draws. Three of its fields reach
 * the document as *markup*:
 *
 * - `node.dangerouslySetInnerHTML` is assigned to the node element's `innerHTML`
 *   verbatim, before anything else is read;
 * - `arrow.label` and `summary.label` reach `innerHTML` too, through the else-branch
 *   of the library's `markdown` hook.
 *
 * A note reaches a browser through more doors than its author's own keyboard — a
 * shared link, an embedded note, a synced device, the MCP tools — so all three are
 * treated as untrusted here. The labels are answered by supplying the `markdown` hook
 * ourselves and escaping through it, which leaves the stored body untouched: a
 * sanitizer that rewrote the data would write the rewrite back into the note.
 * `dangerouslySetInnerHTML` has no rendering path left to escape through, so it is
 * taken out of the tree before the library ever sees it.
 *
 * `node.hyperLink` becomes an anchor's `href`, so it is kept only for the schemes a
 * link may legitimately name. `node.style` is written property by property onto the
 * node's own style — cosmetic, no script, and the outline format's own styling
 * depends on it — so it stays.
 */

/**
 * The ceiling on how much body a single mind map block will read. Both doors into it
 * — `JSON.parse` and the tree walk — cost more the longer the string is, and the
 * library then lays every node out synchronously, measuring each one against the
 * document. The number sits far above any map a person draws by hand.
 */
export const MINDMAP_BODY_LIMIT_BYTES = 256 * 1024;

/** How many nodes one map may hold. Past it the deepest branches are dropped, not drawn. */
export const MINDMAP_NODE_LIMIT = 5000;

/** A body past that ceiling. Every caller turns this into the block's error state. */
export class MindmapBodyTooLargeError extends Error {
    constructor(readonly limitKb: number = MINDMAP_BODY_LIMIT_BYTES / 1024) {
        super('too-large');
    }
}

/** Checked before the parse runs, so the size is never paid for in order to be declined. */
export function assertMindmapBodySize(body: string): void {
    if (body.length > MINDMAP_BODY_LIMIT_BYTES)
        throw new MindmapBodyTooLargeError();
}

/** The schemes a note may point a node's link at. Anything else is dropped, not rewritten. */
const SAFE_LINK_RE = /^(?:https?:|mailto:)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The library's `markdown` renderer, doing nothing but escaping. Every topic, arrow
 * label and summary label is handed to it and then written as `innerHTML`, so this is
 * the one place that decides whether those three are markup or text — and text is what
 * a note asked for. A non-string arrives as empty rather than throwing: only the root
 * topic is type-checked when the body is read, so a hand-written JSON can put anything
 * in the rest.
 */
export function mindmapTextAsMarkup(text: unknown): string {
    if (typeof text !== 'string')
        return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** One node of the tree, with the fields the document would take as markup removed. */
function sanitizeNode(node: Record<string, unknown>): void {
    delete node.dangerouslySetInnerHTML;
    const link = node.hyperLink;
    if (link !== undefined) {
        if (typeof link === 'string' && SAFE_LINK_RE.test(link.trim()))
            node.hyperLink = link.trim();
        else
            delete node.hyperLink;
    }
    // The library interpolates each icon into `<span>${escape(icon)}</span>`, so the
    // markup is already handled; a non-string only makes its escape helper throw.
    if (node.icons !== undefined)
        node.icons = Array.isArray(node.icons) ? node.icons.filter((icon) => typeof icon === 'string') : [];
    if (node.children !== undefined)
        node.children = Array.isArray(node.children) ? node.children.filter(isRecord) : [];
}

/**
 * Takes the markup-injecting field out of every node in the tree, in place.
 *
 * The walk is iterative because the body is note text: a fence of ten thousand nested
 * `{"children":[…]}` overflows a recursive reader's stack and takes the preview down
 * with it, rather than reporting itself. The node cap is enforced on the way down, so
 * the tree is cut where it runs out of budget and everything above it still draws.
 */
export function sanitizeMindmapData(data: unknown): unknown {
    if (!isRecord(data))
        return data;
    const root = isRecord(data.nodeData) ? data.nodeData : null;
    if (root) {
        const stack: Record<string, unknown>[] = [root];
        let visited = 0;
        while (stack.length > 0) {
            const node = stack.pop()!;
            visited++;
            sanitizeNode(node);
            const children = node.children as Record<string, unknown>[] | undefined ?? [];
            const room = MINDMAP_NODE_LIMIT - visited;
            if (children.length > room) {
                node.children = children.slice(0, Math.max(0, room));
                stack.push(...node.children as Record<string, unknown>[]);
                continue;
            }
            for (const child of children)
                stack.push(child);
        }
    }
    if (data.arrows !== undefined)
        data.arrows = Array.isArray(data.arrows) ? data.arrows.filter(isRecord) : [];
    if (data.summaries !== undefined)
        data.summaries = Array.isArray(data.summaries) ? data.summaries.filter(isRecord) : [];
    return data;
}
