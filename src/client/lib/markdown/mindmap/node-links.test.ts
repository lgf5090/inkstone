import { describe, expect, it } from 'vitest';
import { decodeDataValue } from '../data-attr';
import { decorateMindmapLinks, MINDMAP_NODE_LINK_ATTR } from './node-links';

/** The shape the library builds: a topic element holding the span it keeps a reference to. */
function topic(text: string): { root: HTMLElement; textSpan: HTMLElement } {
    const root = document.createElement('me-tpc');
    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.textContent = text;
    root.append(textSpan);
    return { root, textSpan };
}

function canvas(...roots: HTMLElement[]): HTMLElement {
    const host = document.createElement('div');
    host.append(...roots);
    document.body.append(host);
    return host;
}

describe('decorateMindmapLinks', () => {
    it('turns a topic that is one whole link into an anchor', () => {
        const { root, textSpan } = topic('[[Reading notes]]');
        const host = canvas(root);
        decorateMindmapLinks(host);
        const link = textSpan.querySelector<HTMLAnchorElement>(`[${MINDMAP_NODE_LINK_ATTR}]`);
        expect(link?.textContent).toBe('Reading notes');
        expect(decodeDataValue(link?.dataset.wikilink ?? '')).toBe('Reading notes');
        host.remove();
    });

    it('keeps the library’s own text span in the tree, because it measures that element on export', () => {
        const { root, textSpan } = topic('[[Reading notes]]');
        const host = canvas(root);
        decorateMindmapLinks(host);
        expect(textSpan.isConnected).toBe(true);
        expect(root.firstElementChild).toBe(textSpan);
        host.remove();
    });

    it('leaves a topic with no link in it untouched', () => {
        const plain = topic('Just a branch');
        const host = canvas(plain.root);
        decorateMindmapLinks(host);
        expect(plain.textSpan.querySelector(`[${MINDMAP_NODE_LINK_ATTR}]`)).toBeNull();
        expect(plain.textSpan.textContent).toBe('Just a branch');
        host.remove();
    });

    it('decorates a link that sits among other text without dropping that text', () => {
        const { root, textSpan } = topic('Community [[AGENTS.md]]');
        const host = canvas(root);
        decorateMindmapLinks(host);
        expect(textSpan.textContent).toBe('Community AGENTS.md');
        expect(textSpan.querySelector(`[${MINDMAP_NODE_LINK_ATTR}]`)?.textContent).toBe('AGENTS.md');
        host.remove();
    });

    it('is idempotent, so every place the library rebuilds a node can call it', () => {
        const { root, textSpan } = topic('[[Reading notes]]');
        const host = canvas(root);
        decorateMindmapLinks(host);
        const first = textSpan.querySelector(`[${MINDMAP_NODE_LINK_ATTR}]`);
        decorateMindmapLinks(host);
        expect(textSpan.querySelector(`[${MINDMAP_NODE_LINK_ATTR}]`)).toBe(first);
        host.remove();
    });

    it('falls back to the topic element when the library drew no inner span', () => {
        const root = document.createElement('me-tpc');
        root.textContent = '[[Reading notes]]';
        const host = canvas(root);
        decorateMindmapLinks(host);
        expect(root.querySelector(`[${MINDMAP_NODE_LINK_ATTR}]`)?.textContent).toBe('Reading notes');
        host.remove();
    });

    it('does nothing to a container that is not there', () => {
        expect(() => decorateMindmapLinks(null)).not.toThrow();
    });
});
