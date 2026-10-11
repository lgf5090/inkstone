import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as loader from '../src/client/lib/markdown/excalidraw/loader';

describe('the excalidraw interaction gate', () => {
    it('does not record the touch on the api object the engine hands out', () => {
        // That api arrives from onExcalidrawAPI, which may not have run yet when the reader first touches
        // the canvas. A flag keyed on it loses that touch and stays shut for the life of the canvas, which
        // reads to the user as "drawing does not save at all" - and no unit test can see it, because the
        // tests never run the engine.
        expect(loader).not.toHaveProperty('markExcalidrawInteracted');
        expect(loader).not.toHaveProperty('excalidrawHasInteracted');
    });

    it('the fence block keeps the flag on the mount itself', () => {
        const source = fs.readFileSync('src/client/lib/markdown/excalidraw/registry.tsx', 'utf8');
        expect(source).toContain('let interacted = false;');
        expect(source).toContain('const note = () => { interacted = true; };');
        expect(source).toContain('if (!interacted) return;');
        expect(source).toContain("addEventListener('pointerdown', note, true)");
        expect(source).toContain("addEventListener('keydown', note, true)");
    });

    it('the standalone editor records the touch the same way', () => {
        const source = fs.readFileSync('src/client/features/excalidraw/ExcalidrawStandaloneEditor.tsx', 'utf8');
        expect(source).toContain('const interactedRef = useRef(false);');
        expect(source).toContain('interactedRef.current = true;');
        expect(source).toContain('if (!interactedRef.current) return;');
        expect(source).toContain("addEventListener('pointerdown', note, true)");
    });
});
