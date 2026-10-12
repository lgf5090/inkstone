import { beforeAll, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import { mindmapError, mindmapErrorCode, mindmapErrorText } from './errors';
import { coalescedWheel, createMindmapVendor, fitForReading, fitToView, layoutFieldsOf, wheelHandler } from './mind-elixir-vendor';
import type { MindmapReadViewport } from './mind-elixir-vendor';
import { MINDMAP_BODY_LIMIT_BYTES, MINDMAP_NODE_LIMIT } from './nodes';
import type { MindmapMode } from './body';
import type { MindmapNodeMenuItem, MindmapParsedBody } from './types';

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
            libraryToolBars: true,
            modifierWheelZoom: true,
            undoStepLimit: 0,
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

    it('refuses a JSON body with no nodeData as a code the interface can name', () => {
        const parsed = parse('{"topic":"orphan"}');
        expect(parsed).toMatchObject({ ok: false });
        if (parsed.ok)
            return;
        expect(parsed.error).toBe('no-node-data');
        expect(mindmapErrorCode(parsed.error)).toBe('no-node-data');
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

    // The arms below are the ones a measurement caught: a guard that already speaks in codes
    // was being re-wrapped as a syntax complaint by the `try` it sat inside, so a 300 KB
    // document was told its JSON was malformed — the one thing it was not.
    it.each([{'mode': 'json'}, {'mode': 'outline'}] as { mode: MindmapMode }[])('keeps a body past the ceiling refused as $mode, not as bad syntax', ({ mode }) => {
        const body = mode === 'json'
            ? `{"nodeData":{"topic":"a","meta":"${'x'.repeat(MINDMAP_BODY_LIMIT_BYTES)}"}}`
            : `- ${'x'.repeat(MINDMAP_BODY_LIMIT_BYTES)}`;
        const parsed = parse(body, mode);
        expect(parsed.ok).toBe(false);
        if (parsed.ok)
            return;
        expect(mindmapErrorCode(parsed.error)).toBe('too-large');
        expect(mindmapErrorText(parsed.error)).not.toContain('JSON');
    });

    it('keeps a tree past the node budget refused as a count, not as bad syntax', () => {
        const root: { topic: string, children: unknown[] } = { topic: 'a', children: [] };
        for (let index = 0; index < MINDMAP_NODE_LIMIT + 10; index++)
            root.children.push({ topic: `n${index}` });
        const parsed = parse(JSON.stringify({ nodeData: root }));
        expect(parsed.ok).toBe(false);
        if (parsed.ok)
            return;
        expect(mindmapErrorCode(parsed.error)).toBe('too-many-nodes');
    });

    it('still reports a real syntax error as one', () => {
        const parsed = parse('{"nodeData": {"topic": "a", "children": [');
        expect(parsed.ok).toBe(false);
        if (parsed.ok)
            return;
        expect(mindmapErrorCode(parsed.error)).toBe('bad-json');
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

    // The two arms below are the point of the pair: the first proves the picture reaches the
    // document at all, so the second is a refusal rather than a path that never drew anything.
    // Asserting our own filter would only have proved the filter — the library is the one that
    // writes `src`, and it is the DOM it builds that has to come out clean.
    it('hands a node picture the library can draw, when the note names one it may', () => {
        const parsed = parse('{"nodeData":{"topic":"a","image":{"url":"https://example.com/a.png","width":9,"height":9}}}');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        const picture = draw(parsed).querySelector('img');
        expect(picture?.getAttribute('src')).toBe('https://example.com/a.png');
    });

    it.each([
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        '//attacker.example/pixel.png',
    ])('refuses to draw a node picture at %s, in the document as well as in the data', (url) => {
        const parsed = parse(`{"nodeData":{"topic":"a","image":{"url":"${url}","width":9,"height":9}}}`);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok)
            return;
        const el = draw(parsed);
        expect(el.querySelector('img'), 'the library was never given a picture to make').toBeNull();
        expect(el.innerHTML).not.toContain('attacker.example');
        expect(el.innerHTML).not.toContain('javascript');
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

    it.each(['"down"', 'null', '[]', '9'])('refuses a direction of %s and keeps what the file spelled', (value) => {
        const parsed = parse(`{"nodeData":{"topic":"a"},"direction":${value}}`);
        expect(parsed.ok).toBe(false);
        if (parsed.ok)
            return;
        expect(mindmapErrorCode(parsed.error)).toBe('bad-direction');
        // The offending value is the part a reader can act on, and it travels as the file wrote
        // it — an English sentence here would be the only English in another language's screen.
        expect(parsed.error).toBe(mindmapError('bad-direction', value));
    });

    it('refuses a compact that is not a flag', () => {
        const parsed = parse('{"nodeData":{"topic":"a"},"compact":"yes"}');
        expect(parsed.ok).toBe(false);
        if (parsed.ok)
            return;
        expect(parsed.error).toBe(mindmapError('bad-compact', '"yes"'));
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
            libraryToolBars: true,
            modifierWheelZoom: true,
            undoStepLimit: 0,
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

describe('the wheel, folded into one repaint per frame', () => {
    type Viewport = Parameters<typeof coalescedWheel>[0];

    /** Frames the handler asked for; the test runs them when it wants a repaint. */
    let frames: FrameRequestCallback[] = [];

    /** A viewport that records every transform instead of painting one. */
    function viewport(startScale = 1) {
        frames = [];
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            frames.push(cb);
            return frames.length;
        });
        const instance: Viewport = { scaleVal: startScale, scale: () => {}, move: () => {} };
        const scale = vi.fn((value: number) => { instance.scaleVal = value; });
        const move = vi.fn();
        instance.scale = scale;
        instance.move = move;
        return { instance, scale, move, paint: () => frames.splice(0).forEach((cb) => cb(0)) };
    }

    function wheel(options: { deltaY?: number; deltaX?: number; ctrlKey?: boolean; shiftKey?: boolean }): WheelEvent {
        return new WheelEvent('wheel', { cancelable: true, ...options });
    }

    /** The numbers the handler is asked to move by, with the negative zeros it writes folded away. */
    function travel(move: ReturnType<typeof vi.fn>): [number, number] {
        const call = move.mock.calls[0] as [number, number];
        return [Number(call[0]) + 0, Number(call[1]) + 0];
    }

    it('pays for one zoom per frame, however many ticks the wheel delivered', () => {
        const { instance, scale, paint } = viewport();
        const handler = coalescedWheel(instance, false);
        handler(wheel({ ctrlKey: true, deltaY: -100 }));
        handler(wheel({ ctrlKey: true, deltaY: -100 }));
        handler(wheel({ ctrlKey: true, deltaY: -100 }));
        expect(frames.length, 'three ticks are one frame of work').toBe(1);
        expect(scale).not.toHaveBeenCalled();
        paint();
        expect(scale).toHaveBeenCalledTimes(1);
        // Three ticks of -100 at 0.0015 each, multiplied the way the library multiplies them.
        expect(scale.mock.calls[0]![0]).toBeCloseTo(1.15 ** 3, 6);
    });

    it('sums a fast wheel into one travel', () => {
        const { instance, move, paint } = viewport();
        const handler = coalescedWheel(instance, true);
        handler(wheel({ deltaY: 40 }));
        handler(wheel({ deltaY: 60 }));
        expect(frames.length).toBe(1);
        paint();
        expect(move).toHaveBeenCalledTimes(1);
        expect(travel(move)).toEqual([0, -100]);
    });

    it('turns the wheel sideways on shift, the way the library does', () => {
        const { instance, move, paint } = viewport();
        const handler = coalescedWheel(instance, true);
        handler(wheel({ deltaY: 50, shiftKey: true }));
        paint();
        expect(travel(move)).toEqual([-50, 0]);
    });

    it('leaves the bare wheel to the note around a block, and still zooms on Ctrl', () => {
        const { instance, move, scale, paint } = viewport();
        const handler = coalescedWheel(instance, false);
        const scroll = wheel({ deltaY: 120 });
        handler(scroll);
        expect(scroll.defaultPrevented, 'a block that eats the wheel traps the reader in the map').toBe(false);
        expect(frames.length).toBe(0);
        const zoom = wheel({ deltaY: -100, ctrlKey: true });
        handler(zoom);
        expect(zoom.defaultPrevented).toBe(true);
        paint();
        expect(scale).toHaveBeenCalledTimes(1);
        expect(move).not.toHaveBeenCalled();
    });

    it('clamps a gesture that ran past the limits instead of writing them into the transform', () => {
        const up = viewport(1);
        const grow = coalescedWheel(up.instance, false);
        for (let tick = 0; tick < 40; tick++)
            grow(wheel({ deltaY: -240, ctrlKey: true }));
        up.paint();
        expect(up.scale.mock.calls[0]![0]).toBe(2.5);
        const down = viewport(2.5);
        const shrink = coalescedWheel(down.instance, false);
        for (let tick = 0; tick < 40; tick++)
            shrink(wheel({ deltaY: 240, ctrlKey: true }));
        down.paint();
        expect(down.scale.mock.calls[0]![0]).toBe(0.3);
    });

    it('does nothing at all until there is a viewport to move', () => {
        frames = [];
        const handler = wheelHandler({ current: null }, true);
        const event = wheel({ deltaY: 10 });
        expect(() => handler(event)).not.toThrow();
        expect(event.defaultPrevented).toBe(false);
        expect(frames.length).toBe(0);
    });
});

describe('the fit, kept above the floor the reader can read at', () => {
    function fitter(fitted: number) {
        const viewport = {
            scaleVal: 1,
            scaleFit: () => { viewport.scaleVal = fitted; },
            scale: vi.fn(),
        };
        return viewport;
    }

    it('pulls a map that fitted below the floor back up to it', () => {
        const viewport = fitter(0.034);
        fitToView(viewport);
        expect(viewport.scale).toHaveBeenCalledWith(0.3);
    });

    it('leaves a fit that is already legible exactly where the library put it', () => {
        const viewport = fitter(0.6);
        fitToView(viewport);
        expect(viewport.scale).not.toHaveBeenCalled();
    });

    it('leaves a fit that measured nothing alone, rather than writing NaN into the transform', () => {
        const viewport = fitter(Number.NaN);
        fitToView(viewport);
        expect(viewport.scale).not.toHaveBeenCalled();
    });
});

describe('the frame a map is first seen in', () => {
    /** A viewport whose fit lands wherever the test says it would, on a map at `start`. */
    function reader(fitted: number, start = 1) {
        const viewport: MindmapReadViewport = {
            scaleVal: start,
            scale: () => {},
            scaleFit: () => {},
            toCenter: () => {},
        };
        viewport.scale = vi.fn((value: number) => { viewport.scaleVal = value; });
        viewport.scaleFit = vi.fn(() => { viewport.scaleVal = fitted; });
        viewport.toCenter = vi.fn();
        return viewport;
    }

    it('shows a map whole when fitting it leaves the text readable', () => {
        const viewport = reader(0.84);
        fitForReading(viewport);
        expect(viewport.scale).not.toHaveBeenCalled();
        expect(viewport.toCenter).not.toHaveBeenCalled();
        expect(viewport.scaleVal).toBe(0.84);
    });

    it('leaves a map that would be crushed at reading size, and puts the root back in the middle', () => {
        // The 1000-node document measured 0.034 when fitted: complete, and unreadable.
        const viewport = reader(0.034);
        fitForReading(viewport);
        expect(viewport.scale).toHaveBeenCalledWith(1);
        expect(viewport.toCenter).toHaveBeenCalledTimes(1);
    });

    it('treats a fit that measured nothing as no reason to move the camera', () => {
        const viewport = reader(Number.NaN);
        fitForReading(viewport);
        expect(viewport.scale).toHaveBeenCalledWith(1);
        expect(viewport.toCenter).toHaveBeenCalledTimes(1);
    });

    it('sits on the boundary on the legible side of it', () => {
        expect((() => {
            const v = reader(0.6);
            fitForReading(v);
            return v.scaleVal;
        })()).toBe(0.6);
        expect((() => {
            const v = reader(0.59);
            fitForReading(v);
            return v.scaleVal;
        })()).toBe(1);
    });
});

describe('the undo history a map is allowed to grow', () => {
    const body = (): MindmapParsedBody => {
        const result = parse('{"nodeData":{"id":"core","topic":"Core","children":[]}}');
        expect(result.ok).toBe(true);
        if (!result.ok)
            throw new Error('fixture did not parse');
        return result;
    };

    /**
     * An editable map drawn for real, driven one edit at a time so each lands as its own
     * step, and left open for the test to walk back through.
     */
    async function mapDrivenBy(limit: number, topics: string[]) {
        const el = document.createElement('div');
        document.body.append(el);
        const handle = vendor.create({
            el,
            body: body(),
            editable: true,
            dark: false,
            locale: 'en-US',
            newTopicName: 'New node',
            libraryToolBars: true,
            modifierWheelZoom: true,
            undoStepLimit: limit,
            onOperation: () => {},
            onEditingChange: () => {},
        });
        const children = () => ((handle.getData() as { nodeData: { children: unknown[] } }).nodeData.children).length;
        for (const topic of topics) {
            handle.appendChildren('core', [topic]);
            for (let tick = 0; tick < 8; tick++)
                await new Promise((resolve) => { setTimeout(resolve, 0); });
        }
        return { handle, children, dispose: () => { handle.destroy(); el.remove(); } };
    }

    /** How many branches are left after stepping back this many times. */
    async function afterUndos(limit: number, edits: number, undos: number): Promise<number> {
        const map = await mapDrivenBy(limit, Array.from({ length: edits }, (_, index) => `n${index}`));
        expect(map.children()).toBe(edits);
        for (let step = 0; step < undos; step++)
            map.handle.undo();
        const left = map.children();
        await map.dispose();
        return left;
    }

    it('keeps the recent past undoable and drops the deep past once the ceiling is passed', async () => {
        // Five edits, then three steps back. A ceiling of three means the stack was dropped
        // once, at the third: the two edits after it are still there to give back, and no
        // further — which is the whole trade, and the reason it is a setting.
        expect(await afterUndos(3, 5, 3)).toBe(3);
    });

    it('gives the whole way back when the ceiling says unlimited', async () => {
        expect(await afterUndos(0, 5, 3)).toBe(2);
    });

    it('starts counting again when the reader clears the history themselves', async () => {
        // One edit, emptied on purpose, one more edit: the step they just took has to stay
        // undoable. Carrying the count across the clear would spend the ceiling on it and
        // leave the reader pressing a button that no longer moves anything.
        const map = await mapDrivenBy(2, ['first']);
        map.handle.clearHistory();
        map.handle.appendChildren('core', ['second']);
        for (let tick = 0; tick < 8; tick++)
            await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(map.children()).toBe(2);
        map.handle.undo();
        expect(map.children(), 'the edit after a hand-clear must still undo').toBe(1);
        map.dispose();
    });

    // What the browser run caught: the library's `clearHistory` calls `clearSelection` along
    // with dropping the stack, and Enter adds a branch to whatever is selected. The first drop
    // therefore took the reader's keystrokes with it, and the map looked dead from there on.
    it('leaves the selection where the reader had it when the ceiling drops the stack', async () => {
        const map = await mapDrivenBy(2, ['a', 'b', 'c']);
        expect(map.handle.selectedNodeId(), 'a drop must not cost the reader the node under their keys').not.toBeNull();
        map.handle.appendChildren('core', ['one more']);
        for (let tick = 0; tick < 8; tick++)
            await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(map.children()).toBe(4);
        expect(map.handle.selectedNodeId(), 'and the map is still following the reader').not.toBeNull();
        map.dispose();
    });
});

describe('the layout a body names for itself', () => {
    function drawn(text: string, options: { nodeMenu?: MindmapNodeMenuItem[], libraryToolBars?: boolean } = {}) {
        const el = document.createElement('div');
        document.body.append(el);
        const parsed = parse(text);
        if (!parsed.ok)
            throw new Error(parsed.error);
        const handle = vendor.create({
            el,
            body: parsed,
            editable: true,
            dark: false,
            locale: 'en-US',
            newTopicName: 'New node',
            libraryToolBars: options.libraryToolBars ?? true,
            nodeMenu: options.nodeMenu,
            modifierWheelZoom: true,
            undoStepLimit: 0,
            onOperation: () => {},
            onEditingChange: () => {},
        });
        return { el, handle };
    }

    const TREE = '{"nodeData":{"id":"core","topic":"Core","children":[{"id":"b","topic":"Branch"}]}';
    const withFields = (fields: string) => `${TREE}${fields}}`;
    /** The same parse, narrowed: a fixture that will not build is a bug in the test, not a case. */
    function good(text: string): MindmapParsedBody {
        const parsed = parse(text);
        if (!parsed.ok)
            throw new Error(parsed.error);
        return parsed;
    }
    /** What the layout pass writes: `down` on the node layer is the library's own mark for direction 3. */
    const nodesClass = (el: HTMLElement) => el.querySelector('me-nodes')?.className ?? '(no node layer)';
    const gap = (el: HTMLElement, name: string) => (el.querySelector('.map-container') as HTMLElement | null)?.style.getPropertyValue(name) ?? '';

    it('lays the map out the way a later body names, not the way it was first drawn', () => {
        const { el, handle } = drawn(withFields(',"direction":2'));
        expect(nodesClass(el), 'a side map carries no marker on its node layer').toBe('');
        handle.refresh(good(withFields(',"direction":3')));
        expect(nodesClass(el), 'and a body that asks for downward is drawn downward').toBe('down');
        handle.refresh(good(withFields(',"direction":1')));
        expect(nodesClass(el), 'and back out of it again').toBe('');
    });

    it('tightens the gaps a compact body asks for, and gives them back', () => {
        const { el, handle } = drawn(withFields(''));
        expect(gap(el, '--node-gap-x')).toBe('30px');
        handle.refresh(good(withFields(',"compact":true')));
        expect(gap(el, '--node-gap-x'), 'the gaps are the whole of what compact does').toBe('15px');
        handle.refresh(good(withFields(',"compact":false')));
        expect(gap(el, '--node-gap-x')).toBe('30px');
    });

    it('leaves the layout alone for a body that says nothing about it', () => {
        const { el, handle } = drawn(withFields(',"direction":3,"compact":true'));
        handle.refresh(good('{"nodeData":{"id":"core","topic":"Renamed","children":[]}}'));
        expect(nodesClass(el)).toBe('down');
        expect(gap(el, '--node-gap-x')).toBe('15px');
    });

    it('draws no toolbars for a surface that has chrome of its own', () => {
        expect(drawn(withFields('')).el.querySelectorAll('.mind-elixir-toolbar').length).toBe(2);
        expect(drawn(withFields(''), { libraryToolBars: false }).el.querySelectorAll('.mind-elixir-toolbar').length).toBe(0);
    });

    it('adds the app rows to the node menu, and closes the menu on the click', () => {
        let pressed = '';
        const { el } = drawn(withFields(''), {
            nodeMenu: [{ id: 'link-note', label: 'Link to a note', onSelect: () => { pressed = 'link-note'; } }],
        });
        const rows = [...el.querySelectorAll<HTMLElement>('.menu-list li')];
        const row = rows.find(li => li.textContent?.includes('Link to a note'));
        expect(row, 'the row the reader is looking for is in the menu').toBeTruthy();
        expect(rows.indexOf(row!), 'and it sits after the library\'s own rows').toBeGreaterThan(rows.findIndex(li => li.id === 'cm-link'));
        const menu = el.querySelector<HTMLElement>('.context-menu');
        expect(menu, 'the menu the library appends').toBeTruthy();
        menu!.hidden = false;
        row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(pressed).toBe('link-note');
        expect(menu!.hidden, 'and a row that opens a dialog takes the menu out of the way first').toBe(true);
    });

    it('says what the two arrow rows do, in the app words rather than the library\'s', () => {
        const { el } = drawn(withFields(''));
        expect(el.querySelector('#cm-link')?.textContent).toBe(t('mindmap.menu_arrow'));
        expect(el.querySelector('#cm-link')?.textContent, 'the library calls this "Link", which reads like a note link').not.toBe('Link');
        expect(el.querySelector('#cm-link-bidirectional')?.textContent).toBe(t('mindmap.menu_arrow_two_way'));
    });

    it('reads only the values the library can lay out with', () => {
        expect(layoutFieldsOf({ direction: 3, compact: false })).toEqual({ direction: 3, compact: false });
        expect(layoutFieldsOf({ direction: 'down', compact: 'yes' })).toEqual({});
        expect(layoutFieldsOf('not an object at all')).toEqual({});
    });
});
