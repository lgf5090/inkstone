import { describe, expect, it } from 'vitest';
import {
    MINDMAP_BODY_LIMIT_BYTES,
    MINDMAP_NODE_LIMIT,
    MindmapBodyTooLargeError,
    assertMindmapBodySize,
    mindmapTextAsMarkup,
    sanitizeMindmapData,
} from './nodes';

type Node = Record<string, unknown>;

function topicOf(node: Node): string {
    return node.topic as string;
}

/** A chain `depth` nodes long, each the only child of the one above it. */
function deepTree(depth: number): Node {
    const root: Node = { topic: 'root', children: [] };
    let cursor = root;
    for (let index = 0; index < depth; index++) {
        const child: Node = { topic: `n${index}`, children: [] };
        (cursor.children as Node[]).push(child);
        cursor = child;
    }
    return root;
}

describe('sanitizeMindmapData', () => {
    it('takes the markup-injecting field out of the root and of every descendant', () => {
        const data = {
            nodeData: {
                topic: 'root',
                dangerouslySetInnerHTML: '<img src=x onerror=alert(1)>',
                children: [
                    { topic: 'a', children: [{ topic: 'b', dangerouslySetInnerHTML: '<script>alert(2)</script>' }] },
                ],
            },
        };
        const clean = sanitizeMindmapData(data) as { nodeData: Node };
        expect(clean.nodeData.dangerouslySetInnerHTML).toBeUndefined();
        const child = (clean.nodeData.children as Node[])[0]!;
        const grandchild = (child.children as Node[])[0]!;
        expect(grandchild.dangerouslySetInnerHTML).toBeUndefined();
        // Everything the map draws is still there.
        expect(topicOf(grandchild)).toBe('b');
    });

    it('walks a tree far deeper than the JavaScript stack, rather than throwing', () => {
        const root = deepTree(60_000);
        let cursor: Node = root;
        for (let depth = 0; depth < 60_000; depth++) {
            cursor.dangerouslySetInnerHTML = '<svg onload=alert(1)>';
            cursor = (cursor.children as Node[])[0]!;
        }
        const clean = sanitizeMindmapData({ nodeData: root }) as { nodeData: Node };
        // The cap stops the walk short of the bottom, so check the part it covered and the
        // shape it left behind rather than asserting on a node the cap removed.
        let node: Node = clean.nodeData;
        let depth = 0;
        while ((node.children as Node[]).length > 0 && depth < 500) {
            expect(node.dangerouslySetInnerHTML).toBeUndefined();
            node = (node.children as Node[])[0]!;
            depth++;
        }
        expect(depth).toBeGreaterThan(0);
    });

    it('caps how many nodes one map may hold', () => {
        const root: Node = { topic: 'root', children: [] };
        for (let index = 0; index < MINDMAP_NODE_LIMIT + 500; index++)
            (root.children as Node[]).push({ topic: `n${index}` });
        const clean = sanitizeMindmapData({ nodeData: root }) as { nodeData: Node };
        expect((clean.nodeData.children as Node[]).length).toBe(MINDMAP_NODE_LIMIT - 1);
    });

    it('keeps the per-node style the outline format writes, and the topic beside it', () => {
        const data = { nodeData: { topic: 'a', style: { color: '#e87a90' }, children: [] } };
        const clean = sanitizeMindmapData(data) as { nodeData: Node };
        expect(clean.nodeData.style).toEqual({ color: '#e87a90' });
    });

    it.each(['https://example.com/a', 'http://example.com', 'mailto:someone@example.com'])(
        'keeps a node link on the %s scheme',
        (href) => {
            const clean = sanitizeMindmapData({ nodeData: { topic: 'a', hyperLink: href } }) as { nodeData: Node };
            expect(clean.nodeData.hyperLink).toBe(href);
        },
    );

    it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'javascript&#58;alert(1)', 42, {}])(
        'drops a node link it cannot name a scheme for: %s',
        (href) => {
            const clean = sanitizeMindmapData({ nodeData: { topic: 'a', hyperLink: href } }) as { nodeData: Node };
            expect(clean.nodeData.hyperLink).toBeUndefined();
        },
    );

    it('keeps only the string icons, since the library interpolates each into markup', () => {
        const clean = sanitizeMindmapData({
            nodeData: { topic: 'a', icons: ['🚀', 7, { nested: true }, '<img>'] },
        }) as { nodeData: Node };
        expect(clean.nodeData.icons).toEqual(['🚀', '<img>']);
    });

    it('drops a children field that is not a list, and a non-object entry inside one', () => {
        const notALink = sanitizeMindmapData({ nodeData: { topic: 'a', children: 'oops' } }) as { nodeData: Node };
        expect(notALink.nodeData.children).toEqual([]);
        const withHoles = sanitizeMindmapData({ nodeData: { topic: 'a', children: [{ topic: 'b' }, null, 'x'] } }) as { nodeData: Node };
        expect(withHoles.nodeData.children).toEqual([{ topic: 'b' }]);
    });

    it('keeps only object arrows and summaries, which are the two the label renderer reads', () => {
        const clean = sanitizeMindmapData({
            nodeData: { topic: 'a' },
            arrows: [{ id: 'x', label: 'l' }, 'junk'],
            summaries: 'not a list',
        }) as Record<string, unknown>;
        expect(clean.arrows).toEqual([{ id: 'x', label: 'l' }]);
        expect(clean.summaries).toEqual([]);
    });

    it('leaves a body it cannot read alone rather than throwing', () => {
        expect(sanitizeMindmapData(null)).toBe(null);
        expect(sanitizeMindmapData('text')).toBe('text');
        expect(sanitizeMindmapData([1, 2])).toEqual([1, 2]);
    });
});

describe('mindmapTextAsMarkup', () => {
    it('escapes the characters that would otherwise open a tag, so a topic is text', () => {
        expect(mindmapTextAsMarkup('<img src=x onerror=alert(1)>'))
            .toBe('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('escapes the ampersand exactly once', () => {
        expect(mindmapTextAsMarkup('a & b < c')).toBe('a &amp; b &lt; c');
    });

    it.each([undefined, null, 42, {}])('renders a %s topic as nothing rather than throwing', (value) => {
        expect(mindmapTextAsMarkup(value)).toBe('');
    });
});

describe('assertMindmapBodySize', () => {
    it('accepts a body at the ceiling and refuses one past it', () => {
        expect(() => assertMindmapBodySize('x'.repeat(MINDMAP_BODY_LIMIT_BYTES))).not.toThrow();
        expect(() => assertMindmapBodySize('x'.repeat(MINDMAP_BODY_LIMIT_BYTES + 1)))
            .toThrow(MindmapBodyTooLargeError);
    });

    it('carries the ceiling in kilobytes, because that is what the message has to say', () => {
        try {
            assertMindmapBodySize('x'.repeat(MINDMAP_BODY_LIMIT_BYTES + 1));
            throw new Error('expected the guard to throw');
        }
        catch (err) {
            expect((err as MindmapBodyTooLargeError).limitKb).toBe(256);
        }
    });
});
