import { beforeAll, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import { createMindmapVendor } from './mind-elixir-vendor';
import { MINDMAP_BODY_LIMIT_BYTES } from './nodes';
import type { MindmapMode } from './body';
import type { MindmapParsedBody } from './types';

const vendor = createMindmapVendor();

beforeAll(() => {
    // The library reads the viewport to decide its touch behaviour, and jsdom has no media queries.
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })));
    Object.defineProperty(window, 'matchMedia', { value: globalThis.matchMedia, configurable: true });
});

function parse(body: string, mode: MindmapMode = 'json') {
    return vendor.parse(body, mode, t('preview.mindmap_untitled'));
}

/** Draws a map in a detached-enough element and reports what reached the document. */
function draw(body: MindmapParsedBody): HTMLElement {
    const el = document.createElement('div');
    document.body.append(el);
    try {
        vendor.create({
            el,
            body,
            editable: false,
            dark: false,
            locale: 'en-US',
            newTopicName: 'New node',
            modifierWheelZoom: true,
            onOperation: () => {},
            onEditingChange: () => {},
        });
        return el;
    }
    finally {
        el.remove();
    }
}

describe('vendor.parse', () => {
    it('reads the JSON body the note wrote and keeps its tree', () => {
        const parsed = parse('{"nodeData":{"topic":"Core","children":[{"topic":"Branch"}]}}');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        expect((parsed.data as { nodeData: { topic: string } }).nodeData.topic).toBe('Core');
    });

    it('refuses a JSON body with no nodeData, in words that name the field', () => {
        const parsed = parse('{"topic":"orphan"}');
        expect(parsed).toMatchObject({ ok: false });
        if (parsed.ok)
            return;
        expect(parsed.error).toMatch(/nodeData/);
    });

    it('refuses a nodeData whose topic is not a string', () => {
        expect(parse('{"nodeData":{"topic":42}}').ok).toBe(false);
    });

    it('reports the JSON syntax error rather than drawing an empty map', () => {
        const parsed = parse('{"nodeData": ');
        expect(parsed.ok).toBe(false);
    });

    it('turns an empty body into a one-node map under the fallback title', () => {
        const parsed = parse('   \n  ');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        expect((parsed.data as { nodeData: { topic: string } }).nodeData.topic).toBe(t('preview.mindmap_untitled'));
    });

    it.each(['light', 'dark', 'auto', 'APP'])('reads the theme name %s off the body', (name) => {
        const parsed = parse(`{"nodeData":{"topic":"a"},"theme":"${name}"}`);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        expect(parsed.theme.kind).toBe(name === 'auto' || name === 'APP' ? 'app' : name);
    });

    it('carries a theme object through as the body wrote it', () => {
        const parsed = parse('{"nodeData":{"topic":"a"},"theme":{"name":"mine","palette":["#111"]}}');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        expect(parsed.theme).toEqual({ kind: 'custom', theme: { name: 'mine', palette: ['#111'] } });
    });

    it('refuses a theme name it does not know, and says what to write instead', () => {
        const parsed = parse('{"nodeData":{"topic":"a"},"theme":"neon"}');
        expect(parsed.ok).toBe(false);
        if (parsed.ok)
            return;
        expect(parsed.error).toContain('"light", "dark", "auto"');
    });

    it('declines a body past the size ceiling instead of parsing it', () => {
        const body = `{"nodeData":{"topic":"a","meta":"${'x'.repeat(MINDMAP_BODY_LIMIT_BYTES)}"}}`;
        const parsed = parse(body);
        expect(parsed.ok).toBe(false);
        if (parsed.ok)
            return;
        expect(parsed.error).toBeTruthy();
    });

    it('does not let a body move the prototype of the object it becomes', () => {
        const parsed = parse('{"nodeData":{"topic":"a"},"__proto__":{"polluted":true}}');
        expect(parsed.ok).toBe(true);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

describe('vendor.parse — the markup the library would inject', () => {
    it('strips a node\'s dangerouslySetInnerHTML before the library can write it', () => {
        const parsed = parse('{"nodeData":{"topic":"a","dangerouslySetInnerHTML":"<img id=mm-probe src=x onerror=\\"boom()\\">"}}');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        expect(JSON.stringify(parsed.data)).not.toContain('mm-probe');
        const el = draw(parsed);
        expect(el.querySelector('#mm-probe')).toBeNull();
        expect(el.querySelector('img')).toBeNull();
    });

    it('strips the same field from a nested node, not just the root', () => {
        const parsed = parse('{"nodeData":{"topic":"a","children":[{"topic":"b","dangerouslySetInnerHTML":"<img id=mm-deep>"}]}}');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        expect(JSON.stringify(parsed.data)).not.toContain('mm-deep');
    });

    it('renders a topic that is full of markup as the text it is', () => {
        const parsed = parse('{"nodeData":{"topic":"<img id=mm-topic src=x>","children":[]}}');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        const el = draw(parsed);
        expect(el.querySelector('#mm-topic')).toBeNull();
        expect(el.textContent).toContain('<img id=mm-topic src=x>');
    });

    it('renders an arrow label that is full of markup as text too', () => {
        const parsed = parse('{"nodeData":{"topic":"a","children":[{"topic":"b"}]},"arrows":[{"startId":"1","endId":"2","label":"<img id=mm-arrow>"}]}');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        const el = draw(parsed);
        expect(el.querySelector('#mm-arrow')).toBeNull();
    });

    it('drops a node link whose scheme is a script', () => {
        const parsed = parse('{"nodeData":{"topic":"a","hyperLink":"javascript:alert(1)"}}');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        expect(JSON.stringify(parsed.data)).not.toContain('javascript:');
    });
});

describe('vendor.serialize', () => {
    /** Parses, draws and writes the body back, which is what the note receives. */
    function roundTrip(body: string, mode: MindmapMode): string {
        const parsed = parse(body, mode);
        if (!parsed.ok)
            throw new Error(`fixture did not parse: ${parsed.error}`);
        return vendor.serialize(parsed.data, mode, parsed.extra);
    }

    it('writes the JSON body back byte-for-byte, including the fields it does not read', () => {
        const body = JSON.stringify({
            nodeData: { topic: 'a', children: [{ topic: 'b' }] },
            meta: { owner: 'me' },
            direction: 2,
            compact: true,
        }, null, 2);
        expect(roundTrip(body, 'json')).toBe(body);
    });

    it('keeps the theme field where the body had it, so a palette pin survives an edit', () => {
        expect(roundTrip('{"nodeData":{"topic":"a"},"theme":"dark"}', 'json'))
            .toContain('"theme": "dark"');
    });

    it('omits empty arrows and summaries rather than writing them back', () => {
        const out = roundTrip('{"nodeData":{"topic":"a"},"arrows":[]}', 'json');
        expect(out).not.toContain('arrows');
    });

    it('writes the outline format back as the tree the note had', () => {
        const outline = '- Root\n  - Child one\n  - Child two';
        const out = roundTrip(outline, 'outline');
        expect(out.split('\n')[0]).toBe('- Root');
        expect(out).toContain('  - Child one');
    });

    it('survives outline → json → outline without losing a topic', () => {
        const outline = '- Root\n  - A\n    - B';
        const fromOutline = parse(outline, 'outline');
        expect(fromOutline.ok).toBe(true);
        if (!fromOutline.ok)
            return;
        const asJson = vendor.serialize(fromOutline.data, 'json', {});
        const fromJson = parse(asJson, 'json');
        expect(fromJson.ok).toBe(true);
        if (!fromJson.ok)
            return;
        const back = vendor.serialize(fromJson.data, 'outline', {});
        expect(back).toContain('- Root');
        expect(back).toContain('B');
    });
});
