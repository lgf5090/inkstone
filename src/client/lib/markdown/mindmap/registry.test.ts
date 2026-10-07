import type { AppLocale } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import { renderMarkdown } from '../renderer';
import { APP_THEME_CHOICE } from './theme';
import type { MindmapFencePatch } from './body';
import type { MindmapCreateOptions, MindmapFenceRef, MindmapHandle, MindmapVendor } from './types';
import {
    captureMindmapFocus,
    destroyMindmaps,
    fitMindmapBlock,
    flushMindmaps,
    mindmapEntryForNode,
    mountMindmaps,
    pickMindmapTheme,
    remeasureMindmapBlock,
    retryMindmap,
    type MindmapMountOptions,
} from './registry';

const LOCALE: AppLocale = 'en-US';

/** Typed so a test can read the arguments the registry passed, not merely that it called. */
function recordingWriter(result: 'written' | 'conflict' = 'written') {
    return vi.fn((_ref: MindmapFenceRef, _nextBody: string) => result);
}

function recordingFenceWriter(result: 'written' | 'conflict' = 'written') {
    return vi.fn((_ref: MindmapFenceRef, _patch: MindmapFencePatch) => result);
}

interface FakeHandle extends MindmapHandle {
    readonly calls: Record<string, number>
    readonly themes: Array<{ dark: boolean; choice: unknown }>
    payload: unknown
}

function fakeHandle(payload: unknown): FakeHandle {
    const calls: Record<string, number> = {};
    const bump = (name: string) => {
        calls[name] = (calls[name] ?? 0) + 1;
    };
    const handle: FakeHandle = {
        calls,
        themes: [],
        payload,
        getData: () => handle.payload,
        refresh: (body) => {
            bump('refresh');
            handle.payload = body.data;
        },
        applyTheme: (input) => {
            bump('applyTheme');
            handle.themes.push(input);
        },
        toCenter: () => bump('toCenter'),
        layout: () => bump('layout'),
        scaleFit: () => bump('scaleFit'),
        focus: () => bump('focus'),
        undo: () => bump('undo'),
        redo: () => bump('redo'),
        clearHistory: () => bump('clearHistory'),
        destroy: () => bump('destroy'),
        exportSvg: async () => new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }),
        exportPng: async () => new Blob(['png'], { type: 'image/png' }),
    };
    return handle;
}

interface Harness {
    vendor: MindmapVendor
    handles: FakeHandle[]
    /** The bus callbacks the registry handed each instance, so a test can fire them. */
    options: MindmapCreateOptions[]
    parses: Array<{ body: string; mode: string }>
    serializes: Array<{ mode: string }>
    nextSerialized: () => string
}

function harness(bodyToData: (body: string) => unknown = (body) => ({ nodeData: { topic: body, children: [] } })): Harness {
    const handles: FakeHandle[] = [];
    const options: MindmapCreateOptions[] = [];
    const parses: Array<{ body: string; mode: string }> = [];
    const serializes: Array<{ mode: string }> = [];
    let counter = 0;
    const vendor: MindmapVendor = {
        create: (create) => {
            options.push(create);
            const handle = fakeHandle(create.body.data);
            handles.push(handle);
            return handle;
        },
        parse: (body, mode) => {
            parses.push({ body, mode });
            return { ok: true, data: bodyToData(body), extra: {}, theme: APP_THEME_CHOICE };
        },
        serialize: (_data, mode) => {
            serializes.push({ mode });
            counter++;
            return `SERIALIZED-${counter}`;
        },
    };
    return {
        vendor,
        handles,
        options,
        parses,
        serializes,
        nextSerialized: () => `SERIALIZED-${counter + 1}`,
    };
}

function markup(...bodies: string[]): string {
    return renderMarkdown(bodies.map((body) => `\`\`\`mindmap\n${body}\n\`\`\``).join('\n\n')).html;
}

function host(...bodies: string[]): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = markup(...bodies);
    document.body.append(root);
    return root;
}

function blocks(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>('[data-mindmap]')];
}

/** Mounts against a fresh harness and hands back everything a test needs to drive it. */
async function mounted(...bodies: string[]): Promise<{ root: HTMLElement; h: Harness }> {
    const root = host(...bodies);
    const h = harness();
    await mountMindmaps(root, { scope: 's', noteId: 'n1', dark: false, locale: LOCALE, editable: true, loadVendor: async () => h.vendor });
    return { root, h };
}

function mountWith(root: HTMLElement, options: Partial<MindmapMountOptions> & { vendor?: Harness } = {}): Promise<void> {
    const h = options.vendor ?? harness();
    return mountMindmaps(root, {
        scope: 's',
        noteId: 'n1',
        dark: false,
        locale: LOCALE,
        editable: true,
        ...options,
        loadVendor: async () => h.vendor,
    });
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    destroyMindmaps('s');
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe('mountMindmaps', () => {
    it('draws a canvas into the placeholder and marks the block ready', async () => {
        const { root } = await mounted('- Core');
        const block = blocks(root)[0]!;
        const canvas = block.querySelector<HTMLElement>('[data-mindmap-canvas]')!;
        expect(canvas).toBeTruthy();
        expect(canvas.parentElement).toBe(block.querySelector('[data-mindmap-placeholder]'));
        expect(canvas.getAttribute('role')).toBe('application');
        expect(block.classList.contains('is-ready')).toBe(true);
        expect(block.classList.contains('loading')).toBe(false);
        expect(block.getAttribute('aria-busy')).toBe('false');
    });

    it('hands the library the body the fence holds and the format the renderer stamped', async () => {
        const { h } = await mounted('- Core');
        expect(h.parses).toEqual([{ body: '- Core', mode: 'outline' }]);
    });

    it('keeps one instance across a re-render, re-parenting its element into the new placeholder', async () => {
        const { root, h } = await mounted('- Core');
        const canvas = root.querySelector('[data-mindmap-canvas]')!;
        root.innerHTML = markup('- Core');
        await mountWith(root, { vendor: h });
        expect(root.querySelector('[data-mindmap-canvas]')).toBe(canvas);
        expect(h.options).toHaveLength(1);
    });

    it('loads an edited fence into the same instance rather than rebuilding the map', async () => {
        const { root, h } = await mounted('- Core');
        const canvas = root.querySelector('[data-mindmap-canvas]')!;
        const handle = h.handles[0]!;
        root.innerHTML = markup('- Changed');
        await mountWith(root, { vendor: h });
        expect(h.options).toHaveLength(1);
        expect(handle.calls.refresh).toBe(1);
        expect(handle.calls.clearHistory).toBe(1);
        expect(root.querySelector('[data-mindmap-canvas]')).toBe(canvas);
    });

    // A write the map made itself leaves `entry.source` already equal to the body the fresh markup
    // carries, so the sync step has nothing to reload — while the swap has just copied the staged
    // "loading" class over a block whose canvas is back on screen. Centering a live canvas like a
    // spinner was visible for a beat after every format conversion.
    it('clears the loading class the swap leaves on a block whose map is still live', async () => {
        const { root, h } = await mounted('- Core');
        const block = blocks(root)[0]!;
        block.classList.remove('is-ready');
        block.classList.add('loading');
        await mountWith(root, { vendor: h });
        expect(block.classList.contains('is-ready')).toBe(true);
        expect(block.classList.contains('loading')).toBe(false);
    });

    it('leaves the camera alone for a fence edit that only moved the palette', async () => {
        const { root, h } = await mounted('{"nodeData":{"topic":"a"}}');
        const handle = h.handles[0]!;
        root.innerHTML = renderMarkdown('```mindmap theme=dark\n{"nodeData":{"topic":"a"}}\n```').html;
        await mountWith(root, { vendor: h });
        expect(handle.calls.refresh).toBeUndefined();
        expect(handle.calls.applyTheme).toBe(1);
    });

    it('numbers two maps that share a body apart, so neither steals the other', async () => {
        const { root, h } = await mounted('- Same', '- Same');
        expect(h.options).toHaveLength(2);
        const [a, b] = blocks(root);
        expect(mindmapEntryForNode(a!)).not.toBe(mindmapEntryForNode(b!));
    });

    it('tears a map down when its block disappears from the note', async () => {
        const { root, h } = await mounted('- Keep', '- Drop');
        const doomed = h.handles[1]!;
        root.innerHTML = markup('- Keep');
        await mountWith(root, { vendor: h });
        expect(doomed.calls.destroy).toBe(1);
        expect(h.options).toHaveLength(2);
    });

    it('refuses a body the vendor cannot read and says why on the block', async () => {
        const root = host('{ not json');
        const h = harness();
        h.vendor.parse = () => ({ ok: false, error: 'bad body' });
        await mountWith(root, { vendor: h });
        const block = blocks(root)[0]!;
        expect(block.classList.contains('has-error')).toBe(true);
        expect(block.textContent).toContain('bad body');
        expect(block.querySelector('[data-mindmap-canvas]')).toBeNull();
    });

    it('mirrors a block inside an embedded note as a picture, never a writable map', async () => {
        const root = document.createElement('div');
        root.innerHTML = `<div class="note-embed-body">${markup('- Mirrored')}</div>`;
        document.body.append(root);
        const h = harness();
        await mountWith(root, { vendor: h });
        await vi.waitFor(() => {
            expect(root.querySelector('img.mindmap-image')).not.toBeNull();
        });
        expect(root.querySelector('[data-mindmap-canvas]')).toBeNull();
    });
});

describe('write-back', () => {
    it('turns an operation burst into one note write carrying the serialized body', async () => {
        const root = host('- Core');
        const writeBack = recordingWriter();
        const h = harness();
        await mountWith(root, { vendor: h, writeBack });
        const operation = h.options[0]!.onOperation;
        operation();
        operation();
        operation();
        expect(writeBack).not.toHaveBeenCalled();
        vi.advanceTimersByTime(400);
        expect(writeBack).toHaveBeenCalledTimes(1);
        expect(writeBack.mock.calls[0]![1]).toBe('SERIALIZED-1');
        expect(writeBack.mock.calls[0]![0]).toEqual({ line: 0, body: '- Core' });
    });

    it('does not write when the map came back to the body the note already holds', async () => {
        const root = host('- Core');
        const writeBack = recordingWriter();
        const h = harness();
        h.vendor.serialize = () => '- Core';
        await mountWith(root, { vendor: h, writeBack });
        h.options[0]!.onOperation();
        vi.advanceTimersByTime(400);
        expect(writeBack).not.toHaveBeenCalled();
    });

    it('keeps the fence reference moving so a second write resolves against the new body', async () => {
        const root = host('- Core');
        const writeBack = recordingWriter();
        const h = harness();
        await mountWith(root, { vendor: h, writeBack });
        h.options[0]!.onOperation();
        vi.advanceTimersByTime(400);
        h.options[0]!.onOperation();
        vi.advanceTimersByTime(400);
        expect(writeBack).toHaveBeenCalledTimes(2);
        expect(writeBack.mock.calls[1]![0]).toEqual({ line: 0, body: 'SERIALIZED-1' });
    });

    it('leaves the entry standing in for the old body when the note declines the write', async () => {
        const root = host('- Core');
        const writeBack = recordingWriter('conflict');
        const h = harness();
        await mountWith(root, { vendor: h, writeBack });
        h.options[0]!.onOperation();
        vi.advanceTimersByTime(400);
        expect(writeBack).toHaveBeenCalledTimes(1);
        h.options[0]!.onOperation();
        vi.advanceTimersByTime(400);
        expect(writeBack).toHaveBeenCalledTimes(2);
        expect(writeBack.mock.calls[1]![0]).toEqual({ line: 0, body: '- Core' });
    });

    it('writes nothing for a block that is not writable here', async () => {
        const root = document.createElement('div');
        root.innerHTML = `<div class="note-embed-body">${markup('- Mirrored')}</div>`;
        document.body.append(root);
        const writeBack = recordingWriter();
        const h = harness();
        await mountWith(root, { vendor: h, writeBack });
        expect(h.options.every((option) => !option.editable)).toBe(true);
    });

    it('flushes the pending edit when the surface goes away', async () => {
        const root = host('- Core');
        const writeBack = recordingWriter();
        const h = harness();
        await mountWith(root, { vendor: h, writeBack });
        h.options[0]!.onOperation();
        flushMindmaps('s');
        expect(writeBack).toHaveBeenCalledTimes(1);
    });
});

describe('palette', () => {
    it('writes the pick into the fence and repaints without a rebuild', async () => {
        const root = host('- Core');
        const writeFence = recordingFenceWriter();
        const h = harness();
        await mountWith(root, { vendor: h, writeFence });
        const block = blocks(root)[0]!;
        expect(pickMindmapTheme(block, 'dark')).toBe('written');
        expect(writeFence).toHaveBeenCalledTimes(1);
        expect(writeFence.mock.calls[0]![1]).toEqual({ annotation: 'dark' });
        expect(h.options).toHaveLength(1);
    });

    it('states a JSON body\'s palette in the body and clears the annotation, so one statement survives', async () => {
        const root = host('{"nodeData":{"topic":"a"}}');
        const writeFence = recordingFenceWriter();
        const h = harness();
        await mountWith(root, { vendor: h, writeFence });
        pickMindmapTheme(blocks(root)[0]!, 'light');
        const patch = writeFence.mock.calls[0]![1];
        expect(patch.annotation).toBeNull();
        expect(patch.body).toContain('SERIALIZED');
    });

    it('takes the annotation back out for the default pick', async () => {
        const root = host('- Core');
        const writeFence = recordingFenceWriter();
        const h = harness();
        await mountWith(root, { vendor: h, writeFence });
        pickMindmapTheme(blocks(root)[0]!, 'auto');
        expect(writeFence.mock.calls[0]![1]).toEqual({ annotation: null });
    });

    it('reports missing for a read-only block, which has nothing it could write', async () => {
        const root = host('- Core');
        const writeFence = recordingFenceWriter();
        const h = harness();
        await mountWith(root, { vendor: h, writeFence, editable: false });
        expect(pickMindmapTheme(blocks(root)[0]!, 'dark')).toBe('missing');
        expect(writeFence).not.toHaveBeenCalled();
    });

    it('writes what the map draws with onto the header control, over the default it shipped with', async () => {
        const root = host('- Core');
        const block = blocks(root)[0]!;
        // The head is the preview toolbar layer's work; the registry only states what it can do with it.
        const button = document.createElement('button');
        button.setAttribute('data-mindmap-theme-pick', '');
        button.textContent = 'a stale label';
        block.append(button);
        const h = harness();
        await mountWith(root, { vendor: h });
        expect(button.textContent).toBe(t('preview.mindmap_theme_auto'));
        expect(button.getAttribute('aria-expanded')).toBe('false');
    });
});

describe('focus capture', () => {
    it('hands the map the DOM focus a pointer interaction would otherwise leave in the editor', async () => {
        const { root, h } = await mounted('- Core');
        const release = captureMindmapFocus(root);
        root.querySelector('[data-mindmap-canvas]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(h.handles[0]!.calls.focus).toBe(1);
        release();
    });

    it('leaves an inline topic edit alone, so typing reaches the input', async () => {
        const { root, h } = await mounted('- Core');
        const canvas = root.querySelector('[data-mindmap-canvas]')!;
        const input = document.createElement('input');
        canvas.append(input);
        captureMindmapFocus(root);
        input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(h.handles[0]!.calls.focus).toBeUndefined();
    });

    it('stops after the listener is released', async () => {
        const { root, h } = await mounted('- Core');
        const release = captureMindmapFocus(root);
        release();
        root.querySelector('[data-mindmap-canvas]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(h.handles[0]!.calls.focus).toBeUndefined();
    });
});

describe('retry', () => {
    it('builds a block again after a failed render, letting go of the first attempt', async () => {
        const { root, h } = await mounted('- Core');
        const block = blocks(root)[0]!;
        const first = h.handles[0]!;
        await retryMindmap(block);
        expect(first.calls.destroy).toBe(1);
        expect(h.options).toHaveLength(2);
        expect(root.querySelector('[data-mindmap-canvas]')).not.toBeNull();
    });
});

describe('a map that was hidden and is shown again', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    function canvas(root: HTMLElement): HTMLElement {
        return root.querySelector<HTMLElement>('[data-mindmap-canvas]')!;
    }

    /** The box a revealed tab panel hands the map; jsdom measures nothing on its own. */
    function reportSize(root: HTMLElement): void {
        vi.spyOn(canvas(root), 'getBoundingClientRect').mockReturnValue({ width: 619, height: 459 } as DOMRect);
    }

    it('re-measures against the box it just got rather than only moving the viewport', async () => {
        const { root, h } = await mounted('- Core');
        reportSize(root);
        remeasureMindmapBlock(blocks(root)[0]!);
        expect(h.handles[0]!.calls.layout).toBe(1);
        expect(h.handles[0]!.calls.scaleFit).toBe(1);
    });

    it('leaves the map alone while its panel is still zero-sized', async () => {
        const { root, h } = await mounted('- Core');
        remeasureMindmapBlock(blocks(root)[0]!);
        expect(h.handles[0]!.calls.layout).toBeUndefined();
        expect(h.handles[0]!.calls.scaleFit).toBeUndefined();
    });

    it('moves the viewport without re-measuring for the header\'s fit button', async () => {
        const { root, h } = await mounted('- Core');
        reportSize(root);
        fitMindmapBlock(blocks(root)[0]!);
        expect(h.handles[0]!.calls.scaleFit).toBe(1);
        expect(h.handles[0]!.calls.layout).toBeUndefined();
    });

    it('leaves a block the registry never mounted alone', async () => {
        const { h } = await mounted('- Core');
        const mirrored = blocks(host('- Other'))[0]!;
        expect(() => {
            remeasureMindmapBlock(mirrored);
            fitMindmapBlock(mirrored);
        }).not.toThrow();
        expect(h.handles[0]!.calls.layout).toBeUndefined();
        expect(h.handles[0]!.calls.scaleFit).toBeUndefined();
    });
});

describe('a block kept out of the layout', () => {
    class FakeRO {
        static instances: FakeRO[] = [];
        targets: Element[] = [];
        disconnects = 0;
        constructor(readonly callback: (reports: Array<{ contentRect: { width: number, height: number } }>) => void) {
            FakeRO.instances.push(this);
        }
        observe(target: Element): void {
            this.targets.push(target);
        }
        disconnect(): void {
            this.disconnects++;
        }
        report(width: number, height: number): void {
            this.callback([{ contentRect: { width, height } }]);
        }
    }

    function stubRO(): void {
        FakeRO.instances = [];
        vi.stubGlobal('ResizeObserver', FakeRO);
    }

    /** A tab panel that is not showing: nothing inside it has a box. */
    function hide(root: HTMLElement): () => void {
        root.hidden = true;
        return () => {
            root.hidden = false;
        };
    }

    /** jsdom measures nothing on its own, so a test that wants a box has to hand one out. */
    function stubBox(width: number, height: number): () => void {
        const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
        HTMLElement.prototype.getBoundingClientRect = () => ({ width, height }) as DOMRect;
        return () => {
            if (previous)
                Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', previous);
            else
                delete (HTMLElement.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
        };
    }

    /**
     * Reveals a hidden fixture. The box has to be handed out as well: jsdom would keep measuring the
     * block at zero no matter what the markup says, and the build under test asks the DOM.
     */
    function revealed(report: () => void, width = 619, height = 459): Promise<void> {
        const unstub = stubBox(width, height);
        report();
        return settled().finally(unstub);
    }

    async function settled(): Promise<void> {
        for (let i = 0; i < 12; i++)
            await Promise.resolve();
    }

    afterEach(() => {
        vi.unstubAllGlobals();
        FakeRO.instances = [];
    });

    it('waits for a box instead of drawing into nothing, then builds once', async () => {
        stubRO();
        const root = host('- Core');
        const show = hide(root);
        const h = harness();
        await mountWith(root, { vendor: h });
        const block = blocks(root)[0]!;
        const canvas = block.querySelector<HTMLElement>('[data-mindmap-canvas]')!;
        expect(canvas).toBeTruthy();
        expect(h.options).toHaveLength(0);
        expect(block.classList.contains('loading')).toBe(true);
        expect(block.classList.contains('is-ready')).toBe(false);
        const watcher = FakeRO.instances[0]!;
        expect(watcher.targets).toEqual([canvas]);
        watcher.report(0, 0);
        expect(h.options).toHaveLength(0);
        await revealed(() => {
            show();
            watcher.report(619, 459);
        });
        expect(h.options).toHaveLength(1);
        expect(h.handles).toHaveLength(1);
        expect(block.classList.contains('is-ready')).toBe(true);
        expect(watcher.disconnects).toBe(1);
        expect(FakeRO.instances).toHaveLength(2);
        // The wait is over: a later pass now reaches the instance the way every other block does.
        root.innerHTML = markup('- Edited');
        await mountWith(root, { vendor: h });
        expect(h.handles[0]!.calls.refresh).toBe(1);
        expect(FakeRO.instances).toHaveLength(2);
    });

    it('draws a clipped-but-measurable block at once, the way a collapsed details leaves it', async () => {
        stubRO();
        const root = host('- Core');
        const details = document.createElement('details');
        root.remove();
        details.append(root);
        document.body.append(details);
        const unstub = stubBox(639, 350);
        try {
            const h = harness();
            await mountWith(root, { vendor: h });
            expect(h.options).toHaveLength(1);
            expect(blocks(root)[0]!.classList.contains('is-ready')).toBe(true);
            // The one watcher is the drawing's own: nothing waits for a box the block already has.
            expect(FakeRO.instances).toHaveLength(1);
            expect(FakeRO.instances[0]!.disconnects).toBe(0);
        }
        finally {
            unstub();
        }
    });

    it('draws anyway where nothing can report a box', async () => {
        const root = host('- Core');
        hide(root);
        const h = harness();
        await mountWith(root, { vendor: h });
        expect(h.options).toHaveLength(1);
        expect(blocks(root)[0]!.classList.contains('is-ready')).toBe(true);
    });

    it('takes the newest fence body and the new placeholder from a pass that lands while waiting', async () => {
        stubRO();
        const root = host('- Core');
        hide(root);
        const h = harness();
        await mountWith(root, { vendor: h });
        const watcher = FakeRO.instances[0]!;
        root.innerHTML = markup('- Changed');
        await mountWith(root, { vendor: h });
        const placeholder = blocks(root)[0]!.querySelector('[data-mindmap-placeholder]')!;
        expect(watcher.targets[0]!.parentElement).toBe(placeholder);
        expect(watcher.targets[0]!.isConnected).toBe(true);
        await revealed(() => {
            root.hidden = false;
            watcher.report(619, 459);
        });
        expect(h.options).toHaveLength(1);
        expect(h.parses[h.parses.length - 1]!.body).toBe('- Changed');
    });

    it('builds a body the waiting build refused once the fence is fixed', async () => {
        stubRO();
        const root = host('- Core');
        const show = hide(root);
        const h = harness();
        h.vendor.parse = (body) => body.includes('BOOM')
            ? { ok: false, error: 'bad body' }
            : { ok: true, data: { nodeData: { topic: body, children: [] } }, extra: {}, theme: APP_THEME_CHOICE };
        await mountWith(root, { vendor: h });
        const watcher = FakeRO.instances[0]!;
        root.innerHTML = markup('- BOOM');
        await mountWith(root, { vendor: h });
        const unstub = stubBox(619, 459);
        try {
            show();
            watcher.report(619, 459);
            await settled();
            expect(h.options).toHaveLength(0);
            expect(blocks(root)[0]!.classList.contains('has-error')).toBe(true);
            // Nothing is watching this block any more — the wait ended with the report that failed —
            // so the next pass has to be the one that builds it.
            root.innerHTML = markup('- Fixed');
            await mountWith(root, { vendor: h });
            expect(h.options).toHaveLength(1);
            expect(blocks(root)[0]!.classList.contains('is-ready')).toBe(true);
        }
        finally {
            unstub();
        }
    });
});
