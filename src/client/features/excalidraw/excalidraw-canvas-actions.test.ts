import { describe, expect, it, vi } from 'vitest';
import {
    computeElementsBounds,
    createLatexSvg,
    insertLatexToCanvas,
    insertLinkToCanvas,
    insertNoteCardToCanvas,
    insertPdfCardToCanvas,
    zoomToFitScene,
} from './excalidraw-canvas-actions';

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
});

describe('createLatexSvg and insertLatexToCanvas', () => {
    it('compiles LaTeX formula into standalone SVG dataURL', () => {
        const result = createLatexSvg('E=mc^2', false);
        expect(result.dataURL).toContain('data:image/svg+xml');
        expect(decodeURIComponent(result.dataURL)).toContain('katex');
        expect(result.width).toBeGreaterThan(0);
        expect(result.height).toBeGreaterThan(0);
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
        expect(title).toBeDefined();
        expect(title.link).toBe('[[My Project Note]]');
        expect(snippet).toBeDefined();
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
        expect(rect).toBeDefined();
        expect(rect.link).toBe('https://github.com');
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
        expect(text.text).toContain('annual-report.pdf');
    });
});
