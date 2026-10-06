import { describe, expect, it } from 'vitest';
import { decodeDataValue } from '../data-attr';
import { parseMindmapNodeLink, splitMindmapTopicLinks } from './links';
import { decorateMindmapLinks, MINDMAP_NODE_LINK_ATTR } from './node-links';

describe('parseMindmapNodeLink', () => {
    it.each([
        ['[[Target note]]', 'Target note'],
        ['  [[Target note]]  ', 'Target note'],
        ['[[Target#Heading]]', 'Target#Heading'],
        ['[[Target|Alias]]', 'Target|Alias'],
    ])('reads %s as a link to %s', (topic, target) => {
        expect(parseMindmapNodeLink(topic)).toBe(target);
    });

    it.each([
        ['Plain topic'],
        ['See [[Target note]] here'],
        ['[[unclosed'],
        ['[[]]'],
        ['[[   ]]'],
    ])('leaves %s as text', (topic) => {
        expect(parseMindmapNodeLink(topic)).toBeNull();
    });

    it('refuses a target long enough to be something else', () => {
        expect(parseMindmapNodeLink(`[[${'x'.repeat(401)}]]`)).toBeNull();
    });

    it('does not let one target swallow another', () => {
        expect(parseMindmapNodeLink('[[a]][[b]]')).toBeNull();
    });
});

describe('splitMindmapTopicLinks', () => {
    it('keeps the plain text around a mentioned note', () => {
        expect(splitMindmapTopicLinks('Community [[AGENTS.md]] today')).toEqual([
            { text: 'Community ' },
            { text: 'AGENTS.md', target: 'AGENTS.md' },
            { text: ' today' },
        ]);
    });

    it('handles a topic that is nothing but a link', () => {
        expect(splitMindmapTopicLinks('[[Only]]')).toEqual([{ text: 'Only', target: 'Only' }]);
    });

    it('handles several links in reading order', () => {
        expect(splitMindmapTopicLinks('[[a]] and [[b]]')).toEqual([
            { text: 'a', target: 'a' },
            { text: ' and ' },
            { text: 'b', target: 'b' },
        ]);
    });

    it('leaves a blank wiki marker as literal text, the way the prose renderer does', () => {
        expect(splitMindmapTopicLinks('see [[ ]] here')).toEqual([{ text: 'see [[ ]] here' }]);
    });

    it('returns the whole topic as one plain segment when there is no link', () => {
        expect(splitMindmapTopicLinks('Plain')).toEqual([{ text: 'Plain' }]);
        expect(splitMindmapTopicLinks('')).toEqual([]);
    });
});

/** A node element in the shape the library draws it. */
function topicNode(text: string): HTMLElement {
    const topic = document.createElement('me-tpc');
    topic.textContent = text;
    const wrapper = document.createElement('div');
    wrapper.append(topic);
    return wrapper;
}

describe('decorateMindmapLinks', () => {
    it('turns a whole-link topic into one anchor carrying the prose link contract', () => {
        const root = topicNode('[[Target note]]');
        decorateMindmapLinks(root);
        const link = root.querySelector('a')!;
        expect(link.getAttribute(MINDMAP_NODE_LINK_ATTR)).toBe('1');
        expect(link.dataset.wikilink).toBeTruthy();
        expect(link.textContent).toBe('Target note');
    });

    it('keeps the surrounding text when a topic only mentions a note', () => {
        const root = topicNode('See [[Target note]] now');
        decorateMindmapLinks(root);
        expect(root.querySelector('a')!.textContent).toBe('Target note');
        expect(root.textContent).toBe('See Target note now');
    });

    it('is idempotent, because every rebuild calls it again', () => {
        const root = topicNode('[[Target note]]');
        decorateMindmapLinks(root);
        const first = root.querySelector('a');
        decorateMindmapLinks(root);
        expect(root.querySelectorAll('a')).toHaveLength(1);
        expect(root.querySelector('a')).toBe(first);
    });

    it('leaves a plain topic alone rather than replacing its text node', () => {
        const root = topicNode('Just a topic');
        const topic = root.firstElementChild!;
        const textNode = topic.firstChild;
        decorateMindmapLinks(root);
        expect(topic.firstChild).toBe(textNode);
    });

    it('carries an alias through to the label while pointing at the real target', () => {
        const root = topicNode('[[Target note|the plan]]');
        decorateMindmapLinks(root);
        const link = root.querySelector('a')!;
        expect(link.textContent).toBe('the plan');
        expect(decodeDataValue(link.dataset.wikilink)).toBe('Target note');
    });

    it('does nothing without a container', () => {
        expect(() => decorateMindmapLinks(null)).not.toThrow();
    });
});
