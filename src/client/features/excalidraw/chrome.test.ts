import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { reparentMainMenuIntoFooter } from './chrome';

function hostWith(parts: Record<string, HTMLElement | null>): HTMLElement {
    const host = document.createElement('div');
    const island = document.createElement('div');
    island.className = 'excalidraw-ui-top-left';
    const wrapper = document.createElement('div');
    wrapper.className = 'dropdown-menu-event-wrapper';
    const trigger = document.createElement('button');
    trigger.className = 'main-menu-trigger';
    wrapper.append(trigger);
    island.append(wrapper);
    host.append(island);
    if (parts.undoRow) {
        const footer = document.createElement('div');
        footer.className = 'layer-ui__wrapper__footer-left';
        footer.append(parts.undoRow);
        host.append(footer);
    }
    return host;
}

const RealObserver = globalThis.MutationObserver

describe('reparentMainMenuIntoFooter', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => {
        vi.useRealTimers();
        globalThis.MutationObserver = RealObserver
    })

    it('moves the menu wrapper into the undo row', () => {
        const undoRow = document.createElement('div');
        undoRow.className = 'undo-redo-buttons';
        const host = hostWith({ undoRow });
        const cancel = reparentMainMenuIntoFooter(host);

        expect(undoRow.firstElementChild?.className).toBe('dropdown-menu-event-wrapper');
        cancel();
    });

    it('waits for a footer that renders late, then stops polling', () => {
        const host = hostWith({ undoRow: null });
        const cancel = reparentMainMenuIntoFooter(host, 10, 50);

        expect(host.querySelector('.undo-redo-buttons')).toBeNull();
        vi.advanceTimersByTime(120);

        const undoRow = document.createElement('div');
        undoRow.className = 'undo-redo-buttons';
        const footer = host.querySelector<HTMLElement>('.layer-ui__wrapper__footer-left')
        if (footer) footer.append(undoRow)
        else host.append(undoRow)
        vi.advanceTimersByTime(60);

        expect(undoRow.firstElementChild?.className).toBe('dropdown-menu-event-wrapper');
        cancel();
    });

    it('gives up after its attempt budget instead of polling forever', () => {
        const host = hostWith({ undoRow: null });
        reparentMainMenuIntoFooter(host, 3, 50);
        const before = vi.getTimerCount();
        vi.advanceTimersByTime(500);
        expect(vi.getTimerCount()).toBe(0);
        expect(before).toBeGreaterThan(0);
    });

    it('stops polling once cancelled', () => {
        const host = hostWith({ undoRow: null });
        const cancel = reparentMainMenuIntoFooter(host, 20, 50);
        cancel();
        vi.advanceTimersByTime(1000);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never observes the canvas subtree to do this', () => {
        const spy = vi.fn();
        globalThis.MutationObserver = class {
            constructor(cb: MutationCallback) { spy(cb) }
            observe() { /* */ }
            disconnect() { /* */ }
            takeRecords() { return [] }
        } as unknown as typeof MutationObserver

        const undoRow = document.createElement('div');
        undoRow.className = 'undo-redo-buttons';
        const host = hostWith({ undoRow });
        const cancel = reparentMainMenuIntoFooter(host);

        expect(spy).not.toHaveBeenCalled();
        cancel();
    });
});
