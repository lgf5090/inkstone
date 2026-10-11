import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { excalidrawHasInteracted, markExcalidrawInteracted } from '../src/client/lib/markdown/excalidraw/loader';

describe('the excalidraw interaction gate', () => {
    it('starts closed for a fresh api and opens on a touch', () => {
        const api = { id: 'mount-1' };
        expect(excalidrawHasInteracted(api)).toBe(false);
        markExcalidrawInteracted(api);
        expect(excalidrawHasInteracted(api)).toBe(true);
    });

    it('tracks each mount separately, since the engine hands out one api per instance', () => {
        const first = { id: 'mount-a' };
        const second = { id: 'mount-b' };
        markExcalidrawInteracted(first);
        expect(excalidrawHasInteracted(first)).toBe(true);
        expect(excalidrawHasInteracted(second)).toBe(false);
    });

    it('lets an unknown api through rather than freezing a surface that has no instance yet', () => {
        expect(excalidrawHasInteracted(null)).toBe(true);
        expect(excalidrawHasInteracted(undefined)).toBe(true);
    });
});

describe('both drawing surfaces guard their change handler', () => {
    it('the fence block refuses to write before the reader touches the canvas', () => {
        const source = fs.readFileSync('src/client/lib/markdown/excalidraw/registry.tsx', 'utf8');
        const handler = /const handleChange = React\.useCallback\(\([^)]*\) => \{\s*if \(!excalidrawHasInteracted\(api\)\) return;/.test(source);
        expect(handler).toBe(true);
        expect(source).toContain("addEventListener('pointerdown', note, true)");
        expect(source).toContain("addEventListener('keydown', note, true)");
    });

    it('the standalone editor refuses too, and reads the api through a ref not state', () => {
        const source = fs.readFileSync('src/client/features/excalidraw/ExcalidrawStandaloneEditor.tsx', 'utf8');
        expect(source).toContain('if (!excalidrawHasInteracted(apiRef.current)) return;');
        expect(source).toContain('apiRef.current = excalidrawApi;');
        expect(source).toContain("addEventListener('pointerdown', note, true)");
    });
});
