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

describe('the top-level fields a document states', () => {
    function dataOf(body: string): Record<string, unknown> {
        const parsed = parse(body);
        expect(parsed.ok).toBe(true);
        return parsed.ok ? parsed.data as Record<string, unknown> : {};
    }

    it('hands direction, compact and meta to the library, which reads them off the data', () => {
        const data = dataOf('{"nodeData":{"topic":"a"},"direction":3,"compact":true,"meta":{"owner":"inkstone"}}');
        expect(data).toMatchObject({ direction: 3, compact: true, meta: { owner: 'inkstone' } });
    });

    it('says nothing about layout when the body does, so the caller default still applies', () => {
        const data = dataOf('{"nodeData":{"topic":"a"}}');
        expect('direction' in data).toBe(false);
        expect('compact' in data).toBe(false);
    });

    it('draws a downward body differently from a side one, rather than accepting the field and ignoring it', () => {
        const tree = '{"nodeData":{"topic":"a","children":[{"topic":"b"},{"topic":"c"}]}';
        const down = parse(`${tree},"direction":3}`);
        const side = parse(`${tree},"direction":2}`);
        expect(down.ok && side.ok).toBe(true);
        if (!down.ok || !side.ok)
            return;
        const downEl = draw(down);
        const sideEl = draw(side);
        expect(downEl.outerHTML).not.toBe(sideEl.outerHTML);
        expect(downEl.outerHTML).toContain('down');
        expect(sideEl.outerHTML).not.toContain('"down"');
    });

    it.each(['"down"', 'null', '[]', '9'])('refuses a direction of %s and names the field', (value) => {
        const parsed = parse(`{"nodeData":{"topic":"a"},"direction":${value}}`);
        expect(parsed.ok).toBe(false);
        if (parsed.ok)
            return;
        expect(parsed.error).toContain('"direction"');
    });

    it('refuses a compact that is not a flag', () => {
        const parsed = parse('{"nodeData":{"topic":"a"},"compact":"yes"}');
        expect(parsed.ok).toBe(false);
        if (parsed.ok)
            return;
        expect(parsed.error).toContain('"compact"');
    });

    it('ignores a meta that is not an object rather than handing the library a scalar', () => {
        const data = dataOf('{"nodeData":{"topic":"a"},"meta":"nope"}');
        expect('meta' in data).toBe(false);
    });

    it('writes the fields back exactly as they were read, so a map edit keeps the document it came from', () => {
        const body = '{"nodeData":{"topic":"a"},"direction":3,"compact":true,"meta":{"k":1}}';
        const parsed = parse(body);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        const out = JSON.parse(vendor.serialize(parsed.data, 'json', parsed.extra)) as Record<string, unknown>;
        expect(out).toMatchObject({ direction: 3, compact: true, meta: { k: 1 } });
    });
});

describe('changes the library does not announce', () => {
    /** An editable map whose operation bursts are counted, so a silent change shows up. */
    function liveMap(body: MindmapParsedBody): { handle: ReturnType<typeof vendor.create>; operations: () => number } {
        const el = document.createElement('div');
        document.body.append(el);
        let operations = 0;
        const handle = vendor.create({
            el,
            body,
            editable: true,
            dark: false,
            locale: 'en-US',
            newTopicName: 'New node',
            modifierWheelZoom: true,
            onOperation: () => { operations++; },
            onEditingChange: () => {},
        });
        return { handle, operations: () => operations };
    }

    const parsed = (): MindmapParsedBody => {
        // Node ids spelled out, because that is what a document holds: the library never
        // assigns one itself, and an action addressed by id has nothing to find without it.
        const result = parse('{"nodeData":{"id":"core","topic":"Core","children":[{"id":"branch","topic":"Branch"}]}}');
        expect(result.ok).toBe(true);
        if (!result.ok)
            throw new Error('fixture did not parse');
        return result;
    };

    it('tells the writer when a topic is renamed through the API', async () => {
        const { handle, operations } = liveMap(parsed());
        const root = handle.selectedNodeId() ?? (handle.getData() as { nodeData: { id: string } }).nodeData.id;
        const before = operations();
        handle.renameNode(root, '[[Another note]]');
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(operations()).toBeGreaterThan(before);
        const data = handle.getData() as { nodeData: { topic: string } };
        expect(data.nodeData.topic).toBe('[[Another note]]');
    });

    it('declines an action on a node the map is not showing, instead of throwing on the click', () => {
        const { handle, operations } = liveMap(parsed());
        const before = operations();
        expect(() => handle.renameNode('collapsed-away', 'x')).not.toThrow();
        expect(() => handle.appendChildren('collapsed-away', ['a', 'b'])).not.toThrow();
        expect((handle.getData() as { nodeData: { topic: string } }).nodeData.topic).toBe('Core');
        expect(operations()).toBe(before);
    });

    it('tells the writer when the map steps through its own history', () => {
        const { handle, operations } = liveMap(parsed());
        handle.undo();
        expect(operations()).toBeGreaterThan(0);
        handle.redo();
        expect(operations()).toBeGreaterThan(1);
    });
});
