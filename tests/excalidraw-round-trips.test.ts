import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import { parseExcalidrawBody, serializeExcalidrawBody } from '../src/client/lib/markdown/excalidraw/body';
import { applyExcalidrawPatches, EXCALIDRAW_PATCHES } from '../scripts/excalidraw-patch.mjs';
import { useExcalidrawLibraryStore } from '../src/client/features/excalidraw/library/library-store';

const LOCAL_KEY = 'inkstone_excalidraw_library_manifest_v2';

/**
 * One row of the patch table, as this gate reads it. The table itself is plain JavaScript with no
 * declaration file, so the shape the assertions depend on is stated here rather than left `any`.
 */
type Patch = { id: string; target: string; replacement: string; superseded?: string[] };

describe('scene round-trips without inventing fields', () => {
  it('keeps the version and source the note author wrote', () => {
    const source = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'https://example.test/my-board',
      elements: [{ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 9, height: 9 }],
      appState: { viewBackgroundColor: '#abcdef', gridSize: null },
      files: {},
    });
    const parsed = parseExcalidrawBody(source);
    expect(parsed.ok).toBe(true);
    const back = JSON.parse(serializeExcalidrawBody(parsed.data));
    expect(back.source).toBe('https://example.test/my-board');
    expect(back.version).toBe(2);
    expect(back.appState.viewBackgroundColor).toBe('#abcdef');
  });

  it('still defaults to the engine values when the note named neither', () => {
    const parsed = parseExcalidrawBody(JSON.stringify({ elements: [], appState: {}, files: {} }));
    const back = JSON.parse(serializeExcalidrawBody(parsed.data));
    expect(back.version).toBe(2);
    expect(back.source).toBe('https://excalidraw.com');
  });
});

describe('the persisted library manifest carries no derived renders', () => {
  beforeEach(() => localStorage.clear())

  it('keeps svgPreview in memory but strips it from localStorage', () => {
    const store = useExcalidrawLibraryStore.getState()
    const added = store.addItem(null, [{ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }], 'Probe', '<svg><rect/></svg>')
    expect(added.svgPreview).toContain('<svg')

    const raw = localStorage.getItem(LOCAL_KEY)
    expect(raw).not.toBeNull()
    expect(raw).not.toContain('<svg')
    expect(raw).toContain('Probe')
    expect(useExcalidrawLibraryStore.getState().items[0].svgPreview).toContain('<svg')
  })
})

describe('the engine patch table migrates rather than misreports', () => {
  it('treats a superseded replacement as work still to do', () => {
    const entry = EXCALIDRAW_PATCHES.find((p: Patch) => p.superseded?.length)
    expect(entry, 'the unmount entry must list the form it replaces').toBeDefined()
    const once = applyExcalidrawPatches('X ' + entry.target + ' Y')
    expect(once.applied).toEqual([entry.id])
    const stale = applyExcalidrawPatches('X ' + entry.superseded[0] + ' Y')
    expect(stale.applied).toEqual([entry.id])
    expect(stale.content).toContain(entry.replacement)
    const current = applyExcalidrawPatches('X ' + entry.replacement + ' Y')
    expect(current.already).toEqual([entry.id])
    expect(current.applied).toEqual([])
  })

  it('releases the engine state but leaves the canvas React owns alone', () => {
    const entry = EXCALIDRAW_PATCHES.find((p: Patch) => p.id === 'unmount-releases-fields')
    const mount = EXCALIDRAW_PATCHES.find((p: Patch) => p.id === 'mount-recreates-fields')
    expect(entry.replacement).toContain('this.store=null,this.library=null')
    expect(entry.replacement).toContain('this.excalidrawContainerRef.current=void 0')
    // Nulling or zeroing the canvas is what made a StrictMode remount paint into an orphan: the element
    // on screen is React's, so the teardown must not touch it and the mount must not replace it.
    expect(entry.replacement).not.toContain('this.canvas=null')
    expect(entry.replacement).not.toContain('this.rc=null')
    expect(entry.replacement).not.toContain('this.canvas.width=0')
    expect(mount.replacement).not.toContain('createElement("canvas")')
  })
})

describe('no drawing insert spreads an unbounded array into Math.min/max', () => {
  it('uses the bounds helper instead', () => {
    const source = fs.readFileSync('src/client/features/excalidraw/ExcalidrawStandaloneEditor.tsx', 'utf8')
    expect(source).not.toMatch(/Math\.(min|max)\(\.\.\./)
    expect(source).toContain('computeElementsBounds(elements)')
  })
})

describe('the AI default carries no baked credential', () => {
  it('ships an empty key and one source of defaults', () => {
    const store = fs.readFileSync('src/client/features/excalidraw/excalidraw-settings-store.ts', 'utf8')
    const standalone = fs.readFileSync('src/client/features/excalidraw/ExcalidrawStandaloneEditor.tsx', 'utf8')
    expect(store).not.toMatch(/apiKey: '(?!\s*')[^']+'/)
    expect(standalone).not.toContain("baseURL: 'https://api.deepseek.com'")
    expect(standalone).toContain('aiEnabled={excalidrawSettings.aiEnabled}')
  })
})
