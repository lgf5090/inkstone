import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import type { NoteSummary } from '@shared/types';

const FAKE_API = vi.hoisted(() => ({
    updateScene: vi.fn(),
    getSceneElements: vi.fn(() => []),
    getAppState: vi.fn(() => ({ zoom: { value: 1 }, scrollX: 0, scrollY: 0, width: 800, height: 600 })),
    getFiles: vi.fn(() => ({})),
    addFiles: vi.fn(),
    restoreFiles: vi.fn((f: unknown) => f),
    setToastMessage: vi.fn(),
    toggleSidebar: vi.fn(() => false),
}));

let engineProps: any = null;
let engineRenders = 0;

vi.mock('../../lib/markdown/excalidraw', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../lib/markdown/excalidraw')>();
    const FakeExcalidraw = (props: any) => {
        engineRenders += 1;
        engineProps = props;
        useEffect(() => {
            props.onExcalidrawAPI?.(FAKE_API);
        }, []);
        return React.createElement('div', { 'data-fake-engine': '1' });
    };
    const MainMenu = (() => null) as any;
    MainMenu.Item = () => null;
    MainMenu.Separator = () => null;
    MainMenu.DefaultItems = { ChangeCanvasBackground: () => null, ClearCanvas: () => null };
    return {
        ...real,
        loadExcalidrawLib: () => Promise.resolve({
            Excalidraw: FakeExcalidraw,
            MainMenu,
            restoreElements: (e: unknown[]) => e,
            exportToSvg: vi.fn(async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
        } as any),
    };
});

import { ExcalidrawStandaloneEditor } from './ExcalidrawStandaloneEditor';
import { useExcalidrawSettingsStore } from './excalidraw-settings-store';
import { serializeExcalidrawBody } from '../../lib/markdown/excalidraw';

function scene(id: string) {
    return serializeExcalidrawBody({
        elements: [{ id, type: 'rectangle', x: 10, y: 10, width: 40, height: 40, isDeleted: false }],
        appState: { viewBackgroundColor: '#ffffff', gridSize: null },
        files: {},
    });
}

const NOTE = { id: 'note-e07', title: 'e07.excalidraw', isStarred: false } as NoteSummary;

const tick = () => new Promise<void>((resolve) => window.setTimeout(resolve, 20));

async function flushReact(): Promise<void> {
    for (let i = 0; i < 5; i++) await tick();
}

let root: ReactDOM.Root | null = null;
let host: HTMLElement;

beforeEach(() => {
    engineProps = null;
    engineRenders = 0;
    FAKE_API.updateScene.mockClear();
    host = document.createElement('div');
    document.body.append(host);
    if (!window.matchMedia) {
        (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    }
});

afterEach(() => {
    root?.unmount();
    root = null;
    document.body.replaceChildren();
});

async function renderEditor(props: { content: string; onChange?: (next: string) => void }) {
    const onChange = props.onChange ?? vi.fn();
    if (!root) root = ReactDOM.createRoot(host);
    root.render(
        React.createElement(ExcalidrawStandaloneEditor, {
            note: NOTE,
            content: props.content,
            onChange,
            pane: 'primary',
        }),
    );
    await flushReact();
    return { onChange };
}

describe('the whole-page editor follows the note body', () => {
    const elementPayloads = () => FAKE_API.updateScene.mock.calls
        .map((c: any[]) => (Array.isArray(c[0]?.elements) ? c[0].elements.map((e: any) => e.id) : null))
        .filter((p): p is string[] => p !== null);

    it('mounts the engine and hands it the scene from the body', async () => {
        await renderEditor({ content: scene('seed') });
        expect(engineProps).toBeTruthy();
        expect(engineProps.initialData.elements.map((e: any) => e.id)).toEqual(['seed']);
    });

    it('paints a body that changed while the editor was open', async () => {
        await renderEditor({ content: scene('seed') });
        expect(elementPayloads()).toEqual([]);

        await renderEditor({ content: scene('from-another-device') });

        expect(elementPayloads()).toContainEqual(['from-another-device']);
    });

    it('leaves the canvas alone when a new body no longer parses', async () => {
        await renderEditor({ content: scene('seed') });
        expect(elementPayloads()).toEqual([]);

        await renderEditor({ content: '{ this is not a scene' });

        expect(elementPayloads()).toEqual([]);
    });

    it('waits for its own unsaved edit before refilling from the body', async () => {
        const onChange = vi.fn();
        await renderEditor({ content: scene('seed'), onChange });
        host.querySelector('[data-fake-engine]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        engineProps.onChange([{ id: 'mine', type: 'rectangle', x: 1, y: 1, width: 10, height: 10, isDeleted: false }], { viewBackgroundColor: '#ffffff' }, {});
        await new Promise((resolve) => window.setTimeout(resolve, 60));

        await renderEditor({ content: scene('from-another-pane'), onChange });
        await new Promise((resolve) => window.setTimeout(resolve, 60));
        const payloadsWhileUnsaved = FAKE_API.updateScene.mock.calls
            .map((c: any[]) => (Array.isArray(c[0]?.elements) ? c[0].elements.map((e: any) => e.id) : null))
            .filter((p): p is string[] => p !== null);
        expect(payloadsWhileUnsaved).toEqual([]);

        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('holds its own autosave delay inside the advertised range', async () => {
        useExcalidrawSettingsStore.setState({ autoSaveIntervalMs: 1 });
        try {
            const onChange = vi.fn();
            await renderEditor({ content: scene('seed'), onChange });
            host.querySelector('[data-fake-engine]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));

            engineProps.onChange([{ id: 'new-one', type: 'rectangle', x: 1, y: 1, width: 10, height: 10, isDeleted: false }], { viewBackgroundColor: '#ffffff' }, {});
            await new Promise((resolve) => window.setTimeout(resolve, 60));
            expect(onChange).not.toHaveBeenCalled();

            await new Promise((resolve) => window.setTimeout(resolve, 400));
            expect(onChange).toHaveBeenCalledTimes(1);
        } finally {
            useExcalidrawSettingsStore.setState({ autoSaveIntervalMs: 600 });
        }
    });

    it('does not write the body it just saved back into the canvas', async () => {
        const onChange = vi.fn();
        await renderEditor({ content: scene('seed'), onChange });

        // The gate is closed until the reader touches this canvas, and a touch that starts inside the
        // engine has to reach the host's capture listener the same way a real pointer event would.
        const inside = host.querySelector('[data-fake-engine]');
        expect(inside).toBeTruthy();
        inside!.dispatchEvent(new Event('pointerdown', { bubbles: true }));

        engineProps.onChange([
            { id: 'seed', type: 'rectangle', x: 10, y: 10, width: 40, height: 40, isDeleted: false },
            { id: 'mine', type: 'ellipse', x: 90, y: 90, width: 40, height: 40, isDeleted: false },
        ], { viewBackgroundColor: '#ffffff' }, {});
        await new Promise((resolve) => window.setTimeout(resolve, 1200));

        expect(onChange).toHaveBeenCalledTimes(1);
        const saved = String(onChange.mock.calls[0][0]);
        expect(saved).toContain('mine');

        FAKE_API.updateScene.mockClear();
        await renderEditor({ content: saved, onChange });

        expect(elementPayloads()).toEqual([]);
    });
});
