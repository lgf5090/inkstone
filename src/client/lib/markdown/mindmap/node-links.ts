/**
 * Turning the wiki links inside a node topic into something clickable.
 *
 * The library draws a topic as text, so the links are added afterwards: the
 * node's own markup is left alone and only its text is rebuilt with anchors
 * that carry the same `data-wikilink` a prose link does — which is what lets
 * the preview's existing wiki navigation take the click without a second
 * implementation. A topic may be one whole link (the anchor then becomes the
 * node) or mention a note among other text (the anchor then sits inline).
 * Re-applied whenever the library rebuilds its nodes, because a rebuild
 * throws the anchors away.
 */
import { t } from '../../i18n';
import { encodeDataValue } from '../data-attr';
import { parseWikiTarget } from '../renderer';
import { parseMindmapNodeLink, splitMindmapTopicLinks, WIKI_LINK_OPEN } from './links';

/** Marks an anchor this module added, so a click can be told from a prose link. */
export const MINDMAP_NODE_LINK_ATTR = 'data-mindmap-node-link';

export const MINDMAP_NODE_LINK_CLASS = 'mindmap-node-link';

const TOPIC_SELECTOR = 'me-tpc';
/** The span the library builds inside each topic and keeps a reference to. */
const TOPIC_TEXT_SELECTOR = '.text';

/**
 * The id the library gives the one contenteditable it puts a topic into.
 *
 * A surface that watches what the reader is typing has to be able to tell that element
 * from the nodes around it, and this is the only place the name is written down outside
 * the vendor: the vendor itself cannot be imported here, because everything in this file
 * has to be reachable without pulling the library chunk down the boot path.
 */
export const MINDMAP_TOPIC_EDITOR_ID = 'input-box';

/**
 * Where a topic's text actually lives. The library caches the node's own `.text` span and
 * reads it back when it draws — its SVG export measures that element — so decorating the
 * topic element itself would replace the span and leave the library holding a detached
 * node, which comes out as `NaN` in the exported picture. The anchors go inside the span.
 */
function textOf(topic: HTMLElement): HTMLElement {
    return topic.querySelector<HTMLElement>(TOPIC_TEXT_SELECTOR) ?? topic;
}

/**
 * Re-decorates every node in the map. Idempotent: a node already carrying an
 * anchor is left as it is, which is what makes this cheap to call from every
 * place the library rebuilds its tree.
 *
 * The whole scan is skipped for a map that draws no `[[` at all, which is nearly all of
 * them. That check is one read of the drawn text rather than a loop, and it cannot be
 * wrong in the reader's favour: a node that names a note carries `[[` in its raw text,
 * and the only thing that takes those brackets out of the DOM is this decoration — so a
 * map with no `[[` left is either link-free or already decorated, and both need nothing.
 * A topic with unbalanced brackets, like `[[Note`, keeps the scan running; that costs a
 * pass, never a missing link.
 */
export function decorateMindmapLinks(container: HTMLElement | null): void {
    if (!container)
        return;
    if (!container.textContent?.includes(WIKI_LINK_OPEN))
        return;
    for (const topic of container.querySelectorAll<HTMLElement>(TOPIC_SELECTOR)) {
        const textElement = textOf(topic);
        if (textElement.querySelector(`[${MINDMAP_NODE_LINK_ATTR}]`))
            continue;
        const text = textElement.textContent ?? '';
        const whole = parseMindmapNodeLink(text);
        if (whole) {
            textElement.replaceChildren(createNodeLink(whole));
            continue;
        }
        const segments = splitMindmapTopicLinks(text);
        if (!segments.some((segment) => segment.target))
            continue;
        textElement.replaceChildren(...segments.map((segment) =>
            segment.target ? createNodeLink(segment.target) : document.createTextNode(segment.text)));
    }
}

function createNodeLink(target: string): HTMLAnchorElement {
    const parsed = parseWikiTarget(target);
    const label = parsed.alias || parsed.raw;
    const link = document.createElement('a');
    link.className = MINDMAP_NODE_LINK_CLASS;
    link.setAttribute(MINDMAP_NODE_LINK_ATTR, '1');
    link.setAttribute('data-wikilink', encodeDataValue(parsed.raw));
    link.href = '#';
    link.textContent = label;
    link.title = t('preview.mindmap_node_link_hint', { title: label });
    return link;
}
