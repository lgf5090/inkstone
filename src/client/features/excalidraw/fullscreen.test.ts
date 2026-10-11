import { describe, expect, it, vi, afterEach } from 'vitest';
import { lockBodyScroll, toggleElementFullscreen } from './fullscreen';

function host(): HTMLElement {
    const el = document.createElement('div');
    document.body.append(el);
    return el;
}

afterEach(() => {
    document.body.style.overflow = '';
    document.body.replaceChildren();
});

describe('toggleElementFullscreen', () => {
    it('says unsupported instead of throwing where the api is absent', async () => {
        expect(await toggleElementFullscreen(host())).toBe('unsupported');
    });

    it('says unsupported when there is no element to ask', async () => {
        expect(await toggleElementFullscreen(null)).toBe('unsupported');
    });

    it('says denied when the browser refuses', async () => {
        const el = host();
        el.requestFullscreen = () => Promise.reject(new Error('Permissions check failed'));
        expect(await toggleElementFullscreen(el)).toBe('denied');
    });

    it('says entered when the request resolves', async () => {
        const el = host();
        const request = vi.fn(() => Promise.resolve());
        el.requestFullscreen = request;
        expect(await toggleElementFullscreen(el)).toBe('entered');
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('exits whatever is fullscreen rather than asking again', async () => {
        const el = host();
        const exit = vi.fn(() => Promise.resolve());
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });
        Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
        try {
            expect(await toggleElementFullscreen(el)).toBe('exited');
            expect(exit).toHaveBeenCalledTimes(1);
        } finally {
            Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
            Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: undefined });
        }
    });
});

describe('lockBodyScroll', () => {
    it('gives back the value that was there, not an empty string', () => {
        document.body.style.overflow = 'clip';
        const release = lockBodyScroll();
        expect(document.body.style.overflow).toBe('hidden');
        release();
        expect(document.body.style.overflow).toBe('clip');
    });

    it('releases once, so a late cleanup cannot undo someone else’s lock', () => {
        const release = lockBodyScroll();
        release();
        document.body.style.overflow = 'scroll';
        release();
        expect(document.body.style.overflow).toBe('scroll');
    });
});
