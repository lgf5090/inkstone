import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderMarkdown } from '../renderer';
import { setExcalidrawLibForTesting } from './loader';
import { getExcalidrawInstance, mountExcalidrawBlocks, destroyExcalidrawBlocks } from './registry';

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
        Excalidraw: () => null,
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
    host.innerHTML = renderMarkdown(`${FENCE}excalidraw\n${scene}\n${FENCE}`).html;
    return host;
}

beforeEach(() => {
    destroyExcalidrawBlocks('probe-scope');
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

        const hostB = hostWithFence(SCENE_B);
        hostA.replaceChildren(...hostB.childNodes);
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

        const hostB = hostWithFence(SCENE_B);
        host.replaceChildren(...hostB.childNodes);
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
        const hostB = hostWithFence(SCENE_B);
        host.replaceChildren(...hostB.childNodes);
        expect(await countSceneParses('b-rect', mount)).toBe(1);
    });
});
