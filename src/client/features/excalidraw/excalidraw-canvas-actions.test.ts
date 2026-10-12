import { describe, expect, it, vi } from 'vitest';
import katex from 'katex';
import {
    computeElementsBounds,
    createLatexSvg,
    insertLatexToCanvas,
    insertLinkToCanvas,
    insertNoteCardToCanvas,
    insertPdfCardToCanvas,
    zoomToFitScene,
} from './excalidraw-canvas-actions';
import { useExcalidrawSettingsStore } from './excalidraw-settings-store';

describe('computeElementsBounds', () => {
    it('returns null for empty elements array', () => {
        expect(computeElementsBounds([])).toBeNull();
    });

    it('returns null when all elements are marked deleted', () => {
        expect(computeElementsBounds([{ id: '1', isDeleted: true, x: 0, y: 0, width: 100, height: 100 }])).toBeNull();
    });

    it('computes bounding box for simple rectangles', () => {
        const elements = [
            { id: '1', x: 100, y: 50, width: 200, height: 100 },
            { id: '2', x: 400, y: 200, width: 50, height: 80 },
        ];
        const bounds = computeElementsBounds(elements);
        expect(bounds).not.toBeNull();
        expect(bounds!.minX).toBe(100);
        expect(bounds!.minY).toBe(50);
        expect(bounds!.maxX).toBe(450);
        expect(bounds!.maxY).toBe(280);
        expect(bounds!.width).toBe(350);
        expect(bounds!.height).toBe(230);
        expect(bounds!.centerX).toBe(275);
        expect(bounds!.centerY).toBe(165);
    });

    it('computes bounding box for linear elements with points', () => {
        const elements = [
            {
                id: 'line-1',
                x: 50,
                y: 50,
                points: [
                    [0, 0],
                    [100, -20],
                    [200, 80],
                ],
            },
        ];
        const bounds = computeElementsBounds(elements);
        expect(bounds).not.toBeNull();
        expect(bounds!.minX).toBe(50);
        expect(bounds!.minY).toBe(30);
        expect(bounds!.maxX).toBe(250);
        expect(bounds!.maxY).toBe(130);
    });

    it('computes bounding box for rotated elements', () => {
        const elements = [
            {
                id: 'rect-rot',
                x: 100,
                y: 100,
                width: 200,
                height: 50,
                angle: Math.PI / 2,
            },
        ];
        const bounds = computeElementsBounds(elements);
        expect(bounds).not.toBeNull();
        expect(bounds!.centerX).toBeCloseTo(200, 0);
        expect(bounds!.centerY).toBeCloseTo(125, 0);
        expect(bounds!.width).toBeCloseTo(50, 0);
        expect(bounds!.height).toBeCloseTo(200, 0);
    });
});

describe('zoomToFitScene', () => {
    it('centers content and calculates correct zoom and scroll', () => {
        let updatedScene: any = null;
        const mockApi = {
            getSceneElements: () => [
                { id: '1', x: 100, y: 100, width: 300, height: 200 },
            ],
            getAppState: () => ({
                width: 1000,
                height: 800,
                zoom: { value: 1 },
                scrollX: 0,
                scrollY: 0,
            }),
            updateScene: vi.fn((data) => {
                updatedScene = data;
            }),
        };

        const container = document.createElement('div');
        Object.defineProperty(container, 'clientWidth', { value: 1000 });
        Object.defineProperty(container, 'clientHeight', { value: 800 });

        zoomToFitScene(mockApi, container);

        expect(mockApi.updateScene).toHaveBeenCalled();
        expect(updatedScene).not.toBeNull();
        expect(updatedScene.appState.zoom.value).toBeGreaterThan(0);

        const z = updatedScene.appState.zoom.value;
        const expectedScrollX = (1000 / 2) / z - 250;
        const expectedScrollY = (800 / 2) / z - 200;
        expect(updatedScene.appState.scrollX).toBeCloseTo(expectedScrollX, 1);
        expect(updatedScene.appState.scrollY).toBeCloseTo(expectedScrollY, 1);
    });

    it('does nothing when elements are empty', () => {
        const mockApi = {
            getSceneElements: () => [],
            getAppState: () => ({ width: 800, height: 600 }),
            updateScene: vi.fn(),
        };
        zoomToFitScene(mockApi);
        expect(mockApi.updateScene).not.toHaveBeenCalled();
    });

    it('lets the engine fit the view when it has zoomToFit, instead of overwriting it', () => {
        const zoomToFitMock = vi.fn();
        const mockApi = {
            getSceneElements: () => [
                { id: '1', x: 0, y: 0, width: 100, height: 100 },
            ],
            getAppState: () => ({ width: 800, height: 600, zoom: { value: 1 }, scrollX: 0, scrollY: 0 }),
            zoomToFit: zoomToFitMock,
            updateScene: vi.fn(),
        };
        zoomToFitScene(mockApi);
        expect(zoomToFitMock).toHaveBeenCalled();
        expect(mockApi.updateScene).not.toHaveBeenCalled();
    });

    it('lets the animated scrollToContent stand alone', () => {
        const scrollToContent = vi.fn();
        const mockApi = {
            getSceneElements: () => [
                { id: '1', x: 0, y: 0, width: 100, height: 100 },
            ],
            getAppState: () => ({ width: 800, height: 600, zoom: { value: 1 }, scrollX: 0, scrollY: 0 }),
            scrollToContent,
            zoomToFit: vi.fn(),
            updateScene: vi.fn(),
        };
        zoomToFitScene(mockApi);
        expect(scrollToContent).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({ fitToViewport: true, animate: true }),
        );
        expect(mockApi.zoomToFit).not.toHaveBeenCalled();
        expect(mockApi.updateScene).not.toHaveBeenCalled();
    });

    it('falls back to the hand-computed view when the engine offers no fit at all', () => {
        const mockApi = {
            getSceneElements: () => [
                { id: '1', x: 0, y: 0, width: 100, height: 100 },
            ],
            getAppState: () => ({ width: 800, height: 600, zoom: { value: 1 }, scrollX: 0, scrollY: 0 }),
            updateScene: vi.fn(),
        };
        zoomToFitScene(mockApi);
        expect(mockApi.updateScene).toHaveBeenCalledTimes(1);
    });

    it('still uses the hand-computed view when the engine fit throws', () => {
        const mockApi = {
            getSceneElements: () => [
                { id: '1', x: 0, y: 0, width: 100, height: 100 },
            ],
            getAppState: () => ({ width: 800, height: 600, zoom: { value: 1 }, scrollX: 0, scrollY: 0 }),
            scrollToContent: vi.fn(() => { throw new Error('no view in this build'); }),
            updateScene: vi.fn(),
        };
        zoomToFitScene(mockApi);
        expect(mockApi.updateScene).toHaveBeenCalledTimes(1);
    });
});

describe('createLatexSvg and insertLatexToCanvas', () => {
    it('compiles LaTeX formula into standalone SVG dataURL', () => {
        const result = createLatexSvg('E=mc^2', false);
        expect(result.dataURL).toContain('data:image/svg+xml');
        expect(decodeURIComponent(result.dataURL)).toContain('katex');
        expect(result.width).toBeGreaterThan(0);
        expect(result.height).toBeGreaterThan(0);
    });

    it('applies configured latexFontSize to SVG output', () => {
        useExcalidrawSettingsStore.getState().updateSettings({
            latexFontSize: 36,
        });
        const result = createLatexSvg('E=mc^2', false);
        const decoded = decodeURIComponent(result.dataURL);
        expect(decoded).toContain('font-size: 36px');
    });

    it('escapes the source when the compiler itself throws', () => {
        const spy = vi.spyOn(katex, 'renderToString').mockImplementation(() => {
            throw new Error('katex internal failure')
        });
        try {
            const result = createLatexSvg('<img src=x onerror=alert(1)>', false);
            const decoded = decodeURIComponent(result.dataURL);
            expect(decoded).not.toContain('<img');
            expect(decoded).toContain('&lt;img');
        } finally {
            spy.mockRestore();
        }
    });

    it('inserts image element with SVG file into canvas', () => {
        const filesAdded: any[] = [];
        let sceneElements: any[] = [];
        const mockApi = {
            getSceneElements: () => sceneElements,
            getAppState: () => ({ width: 800, height: 600, zoom: { value: 1 }, scrollX: 0, scrollY: 0 }),
            addFiles: vi.fn((files) => filesAdded.push(...files)),
            updateScene: vi.fn((data) => {
                sceneElements = data.elements;
            }),
        };

        insertLatexToCanvas(mockApi, '\\frac{1}{2}', false);

        expect(mockApi.addFiles).toHaveBeenCalled();
        expect(filesAdded.length).toBe(1);
        expect(filesAdded[0].mimeType).toBe('image/svg+xml');

        expect(mockApi.updateScene).toHaveBeenCalled();
        expect(sceneElements.length).toBe(1);
        expect(sceneElements[0].type).toBe('image');
        expect(sceneElements[0].fileId).toBe(filesAdded[0].id);
        expect(sceneElements[0].scale).toEqual([1, 1]);
        expect(sceneElements[0].crop).toBeNull();
        expect(sceneElements[0].customData.latex).toBe('\\frac{1}{2}');
    });
});

describe('insertNoteCardToCanvas', () => {
    it('creates note card rectangle and text with internal wikilink', () => {
        let sceneElements: any[] = [];
        const mockApi = {
            getSceneElements: () => sceneElements,
            getAppState: () => ({ width: 800, height: 600, zoom: { value: 1 }, scrollX: 0, scrollY: 0 }),
            updateScene: vi.fn((data) => {
                sceneElements = data.elements;
            }),
        };

        insertNoteCardToCanvas(mockApi, 'My Project Note', 'Summary snippet of the note', false);

        expect(sceneElements.length).toBe(3);
        const rect = sceneElements.find((el) => el.type === 'rectangle');
        const title = sceneElements.find((el) => el.type === 'text' && el.text.includes('My Project Note'));
        const snippet = sceneElements.find((el) => el.type === 'text' && el.text.includes('Summary snippet'));

        expect(rect).toBeDefined();
        expect(rect.link).toBe('[[My Project Note]]');
        expect(rect.boundElements).toEqual([{ id: title.id, type: 'text' }, { id: snippet.id, type: 'text' }]);
        expect(title).toBeDefined();
        expect(title.link).toBe('[[My Project Note]]');
        expect(title.originalText).toBe(title.text);
        expect(title.width).toBeGreaterThan(0);
        expect(snippet).toBeDefined();
        expect(snippet.originalText).toBe(snippet.text);
        expect(snippet.width).toBeGreaterThan(0);
    });
});

describe('insertLinkToCanvas', () => {
    it('binds link to selected elements when elements are selected', () => {
        let sceneElements: any[] = [
            { id: 'el-1', type: 'rectangle', x: 10, y: 10, width: 50, height: 50 },
            { id: 'el-2', type: 'ellipse', x: 80, y: 80, width: 40, height: 40 },
        ];
        const mockApi = {
            getSceneElements: () => sceneElements,
            getAppState: () => ({
                selectedElementIds: { 'el-1': true },
                width: 800,
                height: 600,
            }),
            updateScene: vi.fn((data) => {
                sceneElements = data.elements;
            }),
        };

        insertLinkToCanvas(mockApi, 'https://example.com');

        expect(sceneElements.find((e) => e.id === 'el-1').link).toBe('https://example.com');
        expect(sceneElements.find((e) => e.id === 'el-2').link).toBeUndefined();
    });

    it('creates link card when no element is selected', () => {
        let sceneElements: any[] = [];
        const mockApi = {
            getSceneElements: () => sceneElements,
            getAppState: () => ({
                selectedElementIds: {},
                width: 800,
                height: 600,
                zoom: { value: 1 },
                scrollX: 0,
                scrollY: 0,
            }),
            updateScene: vi.fn((data) => {
                sceneElements = data.elements;
            }),
        };

        insertLinkToCanvas(mockApi, 'https://github.com');

        expect(sceneElements.length).toBe(2);
        const rect = sceneElements.find((e) => e.type === 'rectangle');
        const text = sceneElements.find((e) => e.type === 'text');
        expect(rect).toBeDefined();
        expect(rect.link).toBe('https://github.com');
        expect(rect.boundElements).toEqual([{ id: text.id, type: 'text' }]);
        expect(text).toBeDefined();
        expect(text.originalText).toBe(text.text);
        expect(text.width).toBeGreaterThan(0);
    });
});

describe('insertPdfCardToCanvas', () => {
    it('creates pdf card with document link', () => {
        let sceneElements: any[] = [];
        const mockApi = {
            getSceneElements: () => sceneElements,
            getAppState: () => ({
                width: 800,
                height: 600,
                zoom: { value: 1 },
                scrollX: 0,
                scrollY: 0,
            }),
            updateScene: vi.fn((data) => {
                sceneElements = data.elements;
            }),
        };

        insertPdfCardToCanvas(mockApi, 'annual-report.pdf', false);

        expect(sceneElements.length).toBe(2);
        const rect = sceneElements.find((e) => e.type === 'rectangle');
        const text = sceneElements.find((e) => e.type === 'text');
        expect(rect.link).toBe('[[annual-report.pdf]]');
        expect(rect.boundElements).toEqual([{ id: text.id, type: 'text' }]);
        expect(text.text).toContain('annual-report.pdf');
        expect(text.originalText).toBe(text.text);
        expect(text.width).toBeGreaterThan(0);
    });

    it('scales pdf card dimensions and removes border when configured', () => {
        let sceneElements: any[] = [];
        const mockApi = {
            getSceneElements: () => sceneElements,
            getAppState: () => ({
                width: 800,
                height: 600,
                zoom: { value: 1 },
                scrollX: 0,
                scrollY: 0,
            }),
            updateScene: vi.fn((data) => {
                sceneElements = data.elements;
            }),
        };

        useExcalidrawSettingsStore.getState().updateSettings({
            pdfImportScale: 2.0,
            pdfBorderBox: false,
        });

        insertPdfCardToCanvas(mockApi, 'doc.pdf', false);

        expect(sceneElements.length).toBe(2);
        const rect = sceneElements.find((e) => e.type === 'rectangle');
        expect(rect.width).toBe(520);
        expect(rect.height).toBe(128);
        expect(rect.strokeColor).toBe('transparent');
        expect(rect.strokeWidth).toBe(0);
    });
});

describe('advanced edge cases', () => {
    it('binds link to multiple selected elements simultaneously', () => {
        let sceneElements: any[] = [
            { id: 'el-1', type: 'rectangle', x: 10, y: 10, width: 50, height: 50 },
            { id: 'el-2', type: 'ellipse', x: 80, y: 80, width: 40, height: 40 },
            { id: 'el-3', type: 'text', x: 150, y: 150, width: 60, height: 30 },
            { id: 'el-4', type: 'diamond', x: 250, y: 250, width: 40, height: 40 },
        ];
        const mockApi = {
            getSceneElements: () => sceneElements,
            getAppState: () => ({
                selectedElementIds: { 'el-1': true, 'el-2': true, 'el-3': true },
                width: 800,
                height: 600,
            }),
            updateScene: vi.fn((data) => {
                sceneElements = data.elements;
            }),
        };

        insertLinkToCanvas(mockApi, 'https://inkstone.example.com');

        expect(mockApi.updateScene).toHaveBeenCalled();
        expect(sceneElements.find((e) => e.id === 'el-1').link).toBe('https://inkstone.example.com');
        expect(sceneElements.find((e) => e.id === 'el-2').link).toBe('https://inkstone.example.com');
        expect(sceneElements.find((e) => e.id === 'el-3').link).toBe('https://inkstone.example.com');
        expect(sceneElements.find((e) => e.id === 'el-4').link).toBeUndefined();
    });

    it('centers elements placed at extreme coordinate offsets', () => {
        let updatedScene: any = null;
        const mockApi = {
            getSceneElements: () => [
                { id: 'far-1', x: 12000, y: 15000, width: 200, height: 200 },
            ],
            getAppState: () => ({
                width: 1000,
                height: 800,
                zoom: { value: 1 },
                scrollX: 0,
                scrollY: 0,
            }),
            updateScene: vi.fn((data) => {
                updatedScene = data;
            }),
        };

        zoomToFitScene(mockApi);

        expect(mockApi.updateScene).toHaveBeenCalled();
        const z = updatedScene.appState.zoom.value;
        expect(z).toBeGreaterThan(0);
        const expectedScrollX = (1000 / 2) / z - 12100;
        const expectedScrollY = (800 / 2) / z - 15100;
        expect(updatedScene.appState.scrollX).toBeCloseTo(expectedScrollX, 1);
        expect(updatedScene.appState.scrollY).toBeCloseTo(expectedScrollY, 1);
    });
});

