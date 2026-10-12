import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderMarkdown } from '../renderer';
import { registerFenceBodies } from '../fence-bodies';
import { applyBodyAtFence, findExcalidrawFence } from './body';
import { setExcalidrawLibForTesting } from './loader';
import { getExcalidrawInstance, mountExcalidrawBlocks, destroyExcalidrawBlocks } from './registry';
import { useExcalidrawSettingsStore } from '../../../features/excalidraw/excalidraw-settings-store';
import type { ExcalidrawWriteResult, ExcalidrawWriter } from './types';

const SCENE_A = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [{ id: 'a-rect', type: 'rectangle', x: 1, y: 1, width: 10, height: 10 }],
    appState: { viewBackgroundColor: '#ffffff', gridSize: null },
    files: {},
});

const SCENE_B = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [{ id: 'b-rect', type: 'ellipse', x: 5, y: 5, width: 20, height: 20 }],
    appState: { viewBackgroundColor: '#eee', gridSize: null },
    files: {},
});

function makeLib() {
    const MainMenu = (() => null) as unknown as React.ComponentType<Record<string, unknown>> & {
        Item: React.ComponentType<Record<string, unknown>>;
        Separator: React.ComponentType;
        DefaultItems: Record<string, React.ComponentType>;
    };
    MainMenu.Item = () => null;
    MainMenu.Separator = () => null;
    MainMenu.DefaultItems = {
        ChangeCanvasBackground: () => null,
        ClearCanvas: () => null,
        Preferences: () => null,
        ToggleTheme: () => null,
        Help: () => null,
    };
    return {
        Excalidraw: (props: any) => {
            engineRenders += 1;
            engineProps = props;
            return null;
        },
        MainMenu,
        exportToBlob: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
        exportToSvg: vi.fn(async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
        exportToClipboard: vi.fn(async () => undefined),
        serializeAsJSON: vi.fn(() => '{}'),
        restoreElements: vi.fn((els: unknown[]) => els),
        restoreAppState: vi.fn((s: unknown) => s),
    };
}

const FENCE = '```';

let engineRenders = 0;
let engineProps: any = null;

function sceneWithElement(id: string): string {
    return JSON.stringify({
        type: 'excalidraw',
        version: 2,
        elements: [{ id, type: 'rectangle', x: 1, y: 1, width: 10, height: 10 }],
        appState: { viewBackgroundColor: '#ffffff', gridSize: null },
        files: {},
    });
}

function flushReact(): Promise<void> {
    // Passive effects (the ones that attach the gate's listeners) are flushed by the scheduler, so a
    // single macrotask is enough only when React's task queue is already warm - run this file one test at
    // a time and a lone 20 ms wait lets the assertion dispatch before the listener exists.
    return [0, 1, 2, 3].reduce(
        (chain) => chain.then(() => new Promise<void>((resolve) => window.setTimeout(resolve, 5))),
        Promise.resolve(),
    );
}

/**
 * The note, as the preview hands it to a block: one string, a writer that only accepts a body whose
 * fence still looks like the one the block was mounted from, and the scene text now inside that
 * fence, which is what the next render pass reads back out of the DOM.
 */
function makeNote(scene: string) {
    let body = `${FENCE}excalidraw\n${scene}\n${FENCE}`;
    const results: ExcalidrawWriteResult[] = [];
    const writer: ExcalidrawWriter = (ref, nextBody) => {
        const next = applyBodyAtFence(body, ref, nextBody);
        if (next === null) {
            results.push('conflict');
            return 'conflict';
        }
        body = next;
        results.push('written');
        return 'written';
    };
    return {
        get body() { return body; },
        get scene() { return findExcalidrawFence(body, 0)?.rawBody ?? ''; },
        /** An edit that reached the note from somewhere other than this block, with no render pass in between. */
        rewriteBySomeoneElse(scene: string) { body = `${FENCE}excalidraw\n${scene}\n${FENCE}`; },
        results,
        writer,
    };
}

function touchCanvas(noteId: string): void {
    getExcalidrawInstance('probe-scope', noteId, 0)?.canvasHost.dispatchEvent(
        new Event('pointerdown', { bubbles: true }),
    );
}

function drawOnCanvas(props: any, scene: string): void {
    const parsed = JSON.parse(scene);
    props.onChange(parsed.elements, parsed.appState, {});
}

async function countSceneParses(needle: string, run: () => Promise<void>): Promise<number> {
    const realParse = JSON.parse;
    let hits = 0;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation(((text: string) => {
        if (typeof text === 'string' && text.includes(needle)) hits += 1;
        return realParse(text);
    }) as unknown as typeof JSON.parse);
    await run();
    spy.mockRestore();
    return hits;
}

function hostWithFence(scene: string): HTMLElement {
    const host = document.createElement('div');
    const rendered = renderMarkdown(`${FENCE}excalidraw\n${scene}\n${FENCE}`);
    host.innerHTML = rendered.html;
    registerFenceBodies(host, rendered.fences);
    return host;
}

function swapFenceBody(host: HTMLElement, scene: string): void {
    const next = hostWithFence(scene);
    host.replaceChildren(...next.childNodes);
    registerFenceBodies(host, renderMarkdown(`${FENCE}excalidraw\n${scene}\n${FENCE}`).fences);
}

beforeEach(async () => {
    // A destroyed block's React root unmounts on a deferred timer, and a live root keeps calling the fake
    // engine during the next test, which would overwrite the captured props with a dead instance's. So the
    // unmount is flushed here rather than left to contaminate whichever test runs second.
    destroyExcalidrawBlocks('probe-scope');
    await flushReact();
    engineRenders = 0;
    engineProps = null;
    setExcalidrawLibForTesting(makeLib() as never);
});

describe('the excalidraw block registry', () => {
    it('mounts a block and records the note it belongs to', async () => {
        const host = hostWithFence(SCENE_A);
        await mountExcalidrawBlocks(host, {
            scope: 'probe-scope',
            noteId: 'note-a',
            dark: false,
            locale: 'zh-CN',
            editable: true,
            writeBack: vi.fn(),
        });
        expect(getExcalidrawInstance('probe-scope', 'note-a', 0)?.noteId).toBe('note-a');
    });

    it('does not keep serving a second note from the first note instance', async () => {
        const hostA = hostWithFence(SCENE_A);
        await mountExcalidrawBlocks(hostA, {
            scope: 'probe-scope',
            noteId: 'note-a',
            dark: false,
            locale: 'zh-CN',
            editable: true,
            writeBack: vi.fn(),
        });
        const first = getExcalidrawInstance('probe-scope', 'note-a', 0);

        swapFenceBody(hostA, SCENE_B);
        await mountExcalidrawBlocks(hostA, {
            scope: 'probe-scope',
            noteId: 'note-b',
            dark: false,
            locale: 'zh-CN',
            editable: true,
            writeBack: vi.fn(),
        });

        const second = getExcalidrawInstance('probe-scope', 'note-b', 0);
        expect(second).toBeDefined();
        expect(second?.noteId).toBe('note-b');
        expect(second?.canvasHost).not.toBe(first?.canvasHost);
    });

    it('writes a save back through the writer of the note now displayed', async () => {
        const writerA = vi.fn(() => 'written' as const);
        const writerB = vi.fn(() => 'written' as const);
        const host = hostWithFence(SCENE_A);
        await mountExcalidrawBlocks(host, {
            scope: 'probe-scope',
            noteId: 'note-a',
            dark: false,
            locale: 'zh-CN',
            editable: true,
            writeBack: writerA,
        });

        swapFenceBody(host, SCENE_B);
        vi.useFakeTimers();
        await mountExcalidrawBlocks(host, {
            scope: 'probe-scope',
            noteId: 'note-b',
            dark: false,
            locale: 'zh-CN',
            editable: true,
            writeBack: writerB,
        });
        vi.useRealTimers();

        const entry = getExcalidrawInstance('probe-scope', 'note-b', 0);
        expect(entry?.noteId).toBe('note-b');
        expect(writerA).not.toHaveBeenCalled();
    });

    it('destroys every instance registered under a scope', async () => {
        const host = hostWithFence(SCENE_A);
        await mountExcalidrawBlocks(host, {
            scope: 'probe-scope',
            noteId: 'note-a',
            dark: false,
            locale: 'zh-CN',
            editable: true,
            writeBack: vi.fn(),
        });
        expect(getExcalidrawInstance('probe-scope', 'note-a', 0)).toBeDefined();
        destroyExcalidrawBlocks('probe-scope');
        expect(getExcalidrawInstance('probe-scope', 'note-a', 0)).toBeUndefined();
    });

    it('does not re-read the scene while the fence body is unchanged', async () => {
        const host = hostWithFence(SCENE_A);
        const mount = () => mountExcalidrawBlocks(host, {
            scope: 'probe-scope',
            noteId: 'note-a',
            dark: false,
            locale: 'zh-CN',
            editable: true,
            writeBack: vi.fn(),
        });
        await mount();
        expect(await countSceneParses('a-rect', mount)).toBe(0);
    });

    it('re-reads the scene once the fence body moves', async () => {
        const host = hostWithFence(SCENE_A);
        const mount = () => mountExcalidrawBlocks(host, {
            scope: 'probe-scope',
            noteId: 'note-a',
            dark: false,
            locale: 'zh-CN',
            editable: true,
            writeBack: vi.fn(),
        });
        await mount();
        swapFenceBody(host, SCENE_B);
        expect(await countSceneParses('b-rect', mount)).toBe(1);
    });
});

describe('the fence block writes what the canvas drew', () => {
    const mountInto = (host: HTMLElement, writer: ExcalidrawWriter) => mountExcalidrawBlocks(host, {
        scope: 'probe-scope',
        noteId: 'note-a',
        dark: false,
        locale: 'zh-CN',
        editable: true,
        writeBack: writer,
    });

    function sourceTextUnderBlock(noteId: string): string {
        const block = getExcalidrawInstance('probe-scope', noteId, 0)?.container;
        return block?.querySelector('.excalidraw-block-source code')?.textContent ?? '';
    }

    it('refuses to touch the note until the reader has touched this canvas', async () => {
        const note = makeNote(SCENE_A);
        const host = hostWithFence(SCENE_A);
        await mountInto(host, note.writer);
        await flushReact();
        const props = engineProps;
        expect(props?.onChange).toBeTypeOf('function');

        vi.useFakeTimers();
        try {
            drawOnCanvas(props, sceneWithElement('first-rect'));
            await vi.advanceTimersByTimeAsync(1500);
        } finally {
            vi.useRealTimers();
        }

        expect(note.results).toEqual([]);
        expect(note.body).toContain('a-rect');
    });

    it('writes the edit that follows the first touch', async () => {
        const note = makeNote(SCENE_A);
        const host = hostWithFence(SCENE_A);
        await mountInto(host, note.writer);
        await flushReact();
        const props = engineProps;
        expect(props?.onChange).toBeTypeOf('function');

        vi.useFakeTimers();
        try {
            touchCanvas('note-a');
            drawOnCanvas(props, sceneWithElement('first-rect'));
            await vi.advanceTimersByTimeAsync(1500);
        } finally {
            vi.useRealTimers();
        }

        expect(note.results).toEqual(['written']);
        expect(note.body).toContain('first-rect');
    });

    it('writes a second edit once the first one has come back around through the note', async () => {
        const note = makeNote(SCENE_A);
        const host = hostWithFence(SCENE_A);
        await mountInto(host, note.writer);
        await flushReact();
        const props = engineProps;
        expect(props?.onChange).toBeTypeOf('function');

        vi.useFakeTimers();
        try {
            touchCanvas('note-a');
            drawOnCanvas(props, sceneWithElement('first-rect'));
            await vi.advanceTimersByTimeAsync(1500);
            expect(note.body).toContain('first-rect');

            swapFenceBody(host, note.scene);
            await mountInto(host, note.writer);
            await vi.advanceTimersByTimeAsync(50);

            drawOnCanvas(props, sceneWithElement('second-rect'));
            await vi.advanceTimersByTimeAsync(1500);
        } finally {
            vi.useRealTimers();
        }

        expect(note.results).toEqual(['written', 'written']);
        expect(note.body).toContain('second-rect');
        expect(sourceTextUnderBlock('note-a')).toContain('second-rect');
    });

    it('leaves the note and the scene text alone when the write is refused', async () => {
        const note = makeNote(SCENE_A);
        const host = hostWithFence(SCENE_A);
        await mountInto(host, note.writer);
        await flushReact();
        const props = engineProps;
        expect(props?.onChange).toBeTypeOf('function');

        vi.useFakeTimers();
        try {
            touchCanvas('note-a');
            drawOnCanvas(props, sceneWithElement('first-rect'));
            await vi.advanceTimersByTimeAsync(1500);

            note.rewriteBySomeoneElse(sceneWithElement('their-rect'));
            drawOnCanvas(props, sceneWithElement('second-rect'));
            await vi.advanceTimersByTimeAsync(1500);
        } finally {
            vi.useRealTimers();
        }

        expect(note.results).toEqual(['written', 'conflict']);
        expect(note.body).toContain('their-rect');
        expect(note.body).not.toContain('second-rect');
        expect(sourceTextUnderBlock('note-a')).not.toContain('second-rect');
    });

    it('keeps a nonsense autosave setting from writing on every change', async () => {
        useExcalidrawSettingsStore.setState({ autoSaveIntervalMs: 1 });
        try {
            const note = makeNote(SCENE_A);
            const host = hostWithFence(SCENE_A);
            await mountInto(host, note.writer);
            await flushReact();
            const props = engineProps;
            expect(props?.onChange).toBeTypeOf('function');

            vi.useFakeTimers();
            try {
                touchCanvas('note-a');
                drawOnCanvas(props, sceneWithElement('first-rect'));
                await vi.advanceTimersByTimeAsync(50);
                expect(note.results).toEqual([]);
                await vi.advanceTimersByTimeAsync(400);
                expect(note.results).toEqual(['written']);
            } finally {
                vi.useRealTimers();
            }
        } finally {
            useExcalidrawSettingsStore.setState({ autoSaveIntervalMs: 600 });
        }
    });

    it('leaves the engine alone when only the surrounding chrome changed', async () => {
        const note = makeNote(SCENE_A);
        const host = hostWithFence(SCENE_A);
        await mountInto(host, note.writer);
        await flushReact();
        const props = engineProps;
        expect(props?.onChange).toBeTypeOf('function');

        const block = getExcalidrawInstance('probe-scope', 'note-a', 0)?.container;
        expect(block).toBeDefined();
        const chromeBefore = host.querySelectorAll('*').length;
        const engineBefore = engineRenders;

        block!.dispatchEvent(new CustomEvent('excalidraw-toggle-tools'));
        await flushReact();

        // The panel only exists once the wrapper re-rendered, which is what makes the engine count below
        // a statement about the memo rather than about a render that never happened.
        expect(host.querySelectorAll('*').length).toBeGreaterThan(chromeBefore);
        expect(engineRenders).toBe(engineBefore);
        expect(engineProps.onChange).toBe(props.onChange);
    });
});
