import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../lib/i18n';
import { APP_THEME_CHOICE, MINDMAP_UNDO_STEP_LIMIT, type MindmapHandle, type MindmapParsedBody, type MindmapVendor, type MindmapVendorLoader } from '../../lib/markdown/mindmap';
import { useMindmapDocument, type MindmapDocumentController } from './use-mindmap-document';

interface Handle extends MindmapHandle {
    readonly calls: string[]
    readonly bodies: MindmapParsedBody[]
    payload: unknown
}

function fakeHandle(payload: unknown): Handle {
    const handle = {
        calls: [] as string[],
        bodies: [] as MindmapParsedBody[],
        payload,
        getData: () => handle.payload,
        refresh: (body: MindmapParsedBody) => {
            handle.calls.push('refresh');
            handle.bodies.push(body);
            handle.payload = body.data;
        },
        applyTheme: () => handle.calls.push('applyTheme'),
        selectedNodeId: () => null,
        renameNode: () => {},
        appendChildren: () => {},
        toCenter: () => handle.calls.push('toCenter'),
        layout: () => handle.calls.push('layout'),
        scaleFit: () => handle.calls.push('scaleFit'),
        fitFirstFrame: () => handle.calls.push('fitFirstFrame'),
        focus: () => {},
        undo: () => {},
        redo: () => {},
        clearHistory: () => {},
        destroy: () => handle.calls.push('destroy'),
        exportSvg: async () => new Blob(),
        exportPng: async () => new Blob(),
    };
    return handle;
}

interface Rig {
    vendor: MindmapVendor
    handle: Handle
    /** What the library would call on every drag frame; the note gets one write per burst. */
    operation: () => void
    created: Array<{ editable: boolean; dark: boolean; modifierWheelZoom: boolean; undoStepLimit: number }>
}

function makeRig(initialPayload: unknown): Rig {
    const handle = fakeHandle(initialPayload);
    const created: Rig['created'] = [];
    let operation = () => {};
    const vendor: MindmapVendor = {
        create: (options) => {
            created.push({
                editable: options.editable,
                dark: options.dark,
                modifierWheelZoom: options.modifierWheelZoom,
                undoStepLimit: options.undoStepLimit,
            });
            operation = options.onOperation;
            return handle;
        },
        // The same split the real drawer makes: the tree goes to the library and the
        // top-level fields the library reads off the file travel on their own.
        parse: (body) => {
            const { nodeData, arrows, summaries, ...extra } = JSON.parse(body) as Record<string, unknown>;
            return {
                ok: true,
                data: { nodeData, ...(Array.isArray(arrows) && arrows.length ? { arrows } : {}), ...(Array.isArray(summaries) && summaries.length ? { summaries } : {}) },
                extra,
                theme: APP_THEME_CHOICE,
            };
        },
        serialize: (data) => JSON.stringify(data),
    };
    return { vendor, handle, created, operation: () => operation() };
}

/** The box watcher a browser has and jsdom does not, so a resize can be reported on purpose. */
class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    callback: (reports: Array<{ contentRect: { width: number, height: number } }>) => void;
    constructor(callback: (reports: Array<{ contentRect: { width: number, height: number } }>) => void) {
        FakeResizeObserver.instances.push(this);
        this.callback = callback;
    }
    observe(): void {}
    disconnect(): void {}
    report(width: number, height: number): void {
        this.callback([{ contentRect: { width, height } }]);
    }
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: MindmapDocumentController | null = null;

function Harness(props: { content: string; dark: boolean; autoSaveMs: number; onBodyChange: (next: string) => void; loadVendor: MindmapVendorLoader; undoStepLimit?: number }) {
    const controller = useMindmapDocument({
        content: props.content,
        editable: true,
        dark: props.dark,
        locale: 'en-US',
        autoSaveMs: props.autoSaveMs,
        undoStepLimit: props.undoStepLimit,
        onBodyChange: props.onBodyChange,
        loadVendor: props.loadVendor,
    });
    latest = controller;
    return createElement('div', { ref: controller.hostRef, 'data-testid': 'host' });
}

function render(node: ReactNode) {
    act(() => {
        root.render(node);
    });
}

const BODY = JSON.stringify({ nodeData: { id: 'r', topic: 'Root' } });

beforeEach(async () => {
    await initI18n();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    latest = null;
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** Lets the dynamic vendor import resolve inside the fake clock. */
async function settle() {
    await act(async () => {
        vi.runOnlyPendingTimers();
    });
}

describe('useMindmapDocument', () => {
    it('draws the document it was handed and reports ready', async () => {
        const rig = makeRig(JSON.parse(BODY));
        const onBodyChange = vi.fn();
        render(createElement(Harness, { content: BODY, dark: false, autoSaveMs: 100, onBodyChange, loadVendor: async () => rig.vendor }));
        await settle();
        expect(rig.created).toHaveLength(1);
        expect(latest!.status).toBe('ready');
        expect(latest!.map()).toBe(rig.handle);
    });

    it('owns its viewport: plain wheel zooms here, where a preview block must leave the wheel to the note', async () => {
        const rig = makeRig(JSON.parse(BODY));
        render(createElement(Harness, { content: BODY, dark: false, autoSaveMs: 100, onBodyChange: vi.fn(), loadVendor: async () => rig.vendor }));
        await settle();
        expect(rig.created[0]!.modifierWheelZoom).toBe(false);
    });

    it('writes the map out once the debounce settles, not once per operation', async () => {
        const rig = makeRig(JSON.parse(BODY));
        const onBodyChange = vi.fn();
        render(createElement(Harness, { content: BODY, dark: false, autoSaveMs: 100, onBodyChange, loadVendor: async () => rig.vendor }));
        await settle();
        const edited = { nodeData: { id: 'r', topic: 'Renamed' } };
        rig.handle.payload = edited;
        act(() => {
            rig.operation();
        });
        act(() => {
            vi.advanceTimersByTime(40);
        });
        expect(onBodyChange).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect(onBodyChange).toHaveBeenCalledTimes(1);
        expect(JSON.parse(onBodyChange.mock.calls[0]![0])).toEqual(edited);
    });

    it('does not reload the text it just handed over, which would drop the camera and the undo stack', async () => {
        const rig = makeRig(JSON.parse(BODY));
        const onBodyChange = vi.fn();
        render(createElement(Harness, { content: BODY, dark: false, autoSaveMs: 100, onBodyChange, loadVendor: async () => rig.vendor }));
        await settle();
        rig.handle.payload = { nodeData: { id: 'r', topic: 'Renamed' } };
        act(() => {
            rig.operation();
        });
        act(() => {
            vi.advanceTimersByTime(200);
        });
        const written = onBodyChange.mock.calls[0]![0] as string;
        rig.handle.calls.length = 0;
        render(createElement(Harness, { content: written, dark: false, autoSaveMs: 100, onBodyChange, loadVendor: async () => rig.vendor }));
        expect(rig.handle.calls).not.toContain('refresh');
    });

    it('reads back in text that came from somewhere else', async () => {
        const rig = makeRig(JSON.parse(BODY));
        render(createElement(Harness, { content: BODY, dark: false, autoSaveMs: 100, onBodyChange: vi.fn(), loadVendor: async () => rig.vendor }));
        await settle();
        const elsewhere = JSON.stringify({ nodeData: { id: 'q', topic: 'From another device' } });
        render(createElement(Harness, { content: elsewhere, dark: false, autoSaveMs: 100, onBodyChange: vi.fn(), loadVendor: async () => rig.vendor }));
        expect(rig.handle.calls).toContain('refresh');
        expect(rig.handle.bodies.at(-1)!.data).toEqual(JSON.parse(elsewhere));
    });

    it('keeps the last edit when the surface goes away', async () => {
        const rig = makeRig(JSON.parse(BODY));
        const onBodyChange = vi.fn();
        render(createElement(Harness, { content: BODY, dark: false, autoSaveMs: 10_000, onBodyChange, loadVendor: async () => rig.vendor }));
        await settle();
        rig.handle.payload = { nodeData: { id: 'r', topic: 'Just before closing' } };
        // The debounce cannot pay before the surface is gone: the interval outlives it.
        act(() => {
            rig.operation();
        });
        act(() => {
            root.unmount();
        });
        expect(onBodyChange).toHaveBeenCalledTimes(1);
        expect(JSON.parse(onBodyChange.mock.calls[0]![0]).nodeData.topic).toBe('Just before closing');
        expect(rig.handle.calls).toContain('destroy');
        root = createRoot(container);
        container.append(document.createElement('div'));
    });

    it('repaints when the app changes appearance, without reloading the tree', async () => {
        const rig = makeRig(JSON.parse(BODY));
        render(createElement(Harness, { content: BODY, dark: false, autoSaveMs: 100, onBodyChange: vi.fn(), loadVendor: async () => rig.vendor }));
        await settle();
        rig.handle.calls.length = 0;
        render(createElement(Harness, { content: BODY, dark: true, autoSaveMs: 100, onBodyChange: vi.fn(), loadVendor: async () => rig.vendor }));
        expect(rig.handle.calls).toContain('applyTheme');
        expect(rig.handle.calls).not.toContain('refresh');
    });

    it('shows why a body it cannot read did not draw, instead of an empty canvas', async () => {
        const rig = makeRig(JSON.parse(BODY));
        const broken: MindmapVendor = {
            ...rig.vendor,
            parse: () => ({ ok: false, error: 'a JSON body needs a "nodeData" object with a "topic"' }),
        };
        render(createElement(Harness, { content: 'prose', dark: false, autoSaveMs: 100, onBodyChange: vi.fn(), loadVendor: async () => broken }));
        await settle();
        expect(latest!.status).toBe('error');
        expect(latest!.error).toContain('nodeData');
    });

    it('hands the map the ceiling the reader set on its undo history', async () => {
        const rig = makeRig(JSON.parse(BODY));
        render(createElement(Harness, { content: BODY, dark: false, autoSaveMs: 100, undoStepLimit: 7, onBodyChange: vi.fn(), loadVendor: async () => rig.vendor }));
        await settle();
        expect(rig.created[0]!.undoStepLimit).toBe(7);
    });

    it('falls back to the module ceiling when the surface has no setting of its own', async () => {
        const rig = makeRig(JSON.parse(BODY));
        render(createElement(Harness, { content: BODY, dark: false, autoSaveMs: 100, onBodyChange: vi.fn(), loadVendor: async () => rig.vendor }));
        await settle();
        expect(rig.created[0]!.undoStepLimit).toBe(MINDMAP_UNDO_STEP_LIMIT);
    });

    // The document surface owns its zoom: fitting it to the window is what opened a 1000-node
    // map at 3.4%, so the watcher it installs re-measures and never scales.
    it('re-measures a document whose pane changed size, and leaves the zoom where the reader put it', async () => {
        FakeResizeObserver.instances = [];
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
        const rig = makeRig(JSON.parse(BODY));
        render(createElement(Harness, { content: BODY, dark: false, autoSaveMs: 100, onBodyChange: vi.fn(), loadVendor: async () => rig.vendor }));
        await settle();
        // jsdom lays nothing out, so the map is still waiting for its first real box.
        expect(FakeResizeObserver.instances).toHaveLength(1);
        act(() => {
            FakeResizeObserver.instances[0]!.report(906, 600);
        });
        expect(latest!.status).toBe('ready');
        expect(rig.handle.calls).toContain('fitFirstFrame');
        expect(rig.handle.calls).not.toContain('scaleFit');
        // The mount watcher took over from the wait-for-a-box one, and this is a resize.
        expect(FakeResizeObserver.instances).toHaveLength(2);
        rig.handle.calls.length = 0;
        act(() => {
            FakeResizeObserver.instances[1]!.report(700, 500);
        });
        expect(rig.handle.calls).toEqual(['layout']);
        FakeResizeObserver.instances = [];
    });

    it('carries the fields the file states out of its own parse, without a second one', async () => {
        const stated = JSON.stringify({ nodeData: { id: 'r', topic: 'Root' }, direction: 3, compact: true, theme: 'dark' });
        const rig = makeRig(JSON.parse(stated));
        render(createElement(Harness, { content: stated, dark: false, autoSaveMs: 100, onBodyChange: vi.fn(), loadVendor: async () => rig.vendor }));
        expect(latest!.fields).toEqual({ direction: 3, compact: true, palette: 'dark' });
        await settle();
        expect(latest!.fields).toEqual({ direction: 3, compact: true, palette: 'dark' });
        const elsewhere = JSON.stringify({ nodeData: { id: 'r', topic: 'Root' }, direction: 1 });
        render(createElement(Harness, { content: elsewhere, dark: false, autoSaveMs: 100, onBodyChange: vi.fn(), loadVendor: async () => rig.vendor }));
        expect(latest!.fields).toEqual({ direction: 1 });
    });
});
