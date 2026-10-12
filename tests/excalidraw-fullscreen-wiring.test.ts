import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('the fullscreen helpers are the only way these two surfaces touch the view', () => {
    it('the whole-page editor asks the helper and reports a refusal', () => {
        const source = fs.readFileSync('src/client/features/excalidraw/ExcalidrawStandaloneEditor.tsx', 'utf8');
        expect(source).toContain('await toggleElementFullscreen(containerRef.current)');
        expect(source).toContain("t('excalidraw.fullscreen_unavailable')");
        expect(source).not.toMatch(/requestFullscreen\(\)\.then\([^)]*\)\.catch\(\(\) => \{\}\)/);
    });

    it('the fence block locks the body scroll through the helper', () => {
        const source = fs.readFileSync('src/client/features/preview/use-excalidraw-blocks.ts', 'utf8');
        expect(source).toContain('lockBodyScroll()');
        expect(source).toContain('applyScrollLock(isFull);');
        expect(source).toContain('applyScrollLock(false);');
        expect(source).not.toContain("document.body.style.overflow = ''");
        expect(source).not.toContain("document.body.style.overflow = 'hidden'");
    });
});
