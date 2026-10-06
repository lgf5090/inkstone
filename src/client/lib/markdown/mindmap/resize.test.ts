import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayoutMindmap, watchMindmapBox, watchMindmapContainer } from './resize';
import type { MindmapHandle } from './types';

class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    targets: Element[] = [];
    disconnects = 0;
    constructor(readonly callback: (reports: Array<{ contentRect: { width: number, height: number } }>) => void) {
        FakeResizeObserver.instances.push(this);
    }
    observe(target: Element): void {
        this.targets.push(target);
    }
    disconnect(): void {
        this.disconnects++;
    }
    report(width: number, height: number): void {
        this.callback([{ contentRect: { width, height } }]);
    }
}

function fakeHandle(order: string[]): MindmapHandle {
    const bump = (name: string) => () => {
        order.push(name);
    };
    return {
        getData: () => null,
        refresh: () => {},
        applyTheme: () => {},
        toCenter: () => {},
        layout: bump('layout'),
        scaleFit: bump('scaleFit'),
        focus: () => {},
        undo: () => {},
        redo: () => {},
        clearHistory: () => {},
        destroy: () => {},
        exportSvg: async () => new Blob(),
        exportPng: async () => new Blob(),
    };
}

/** A map's own element holding one node the library has just finished rebuilding. */
function canvasWithTopic(topic: string): HTMLElement {
    const container = document.createElement('div');
    const node = document.createElement('me-tpc');
    node.textContent = topic;
    container.append(node);
    document.body.append(container);
    return container;
}

function stubObserver(): void {
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
}

afterEach(() => {
    vi.unstubAllGlobals();
    FakeResizeObserver.instances = [];
    document.body.replaceChildren();
});

describe('relayoutMindmap', () => {
    it('measures the nodes for the box the map has now, then moves the viewport over them', () => {
        const order: string[] = [];
        relayoutMindmap({ container: canvasWithTopic('Core'), handle: fakeHandle(order) });
        expect(order).toEqual(['layout', 'scaleFit']);
    });

    it('puts the wiki links back on the topics the rebuild threw away', () => {
        const container = canvasWithTopic('[[Alpha]]');
        relayoutMindmap({ container, handle: fakeHandle([]) });
        expect(container.querySelector('a[data-mindmap-node-link]')?.textContent).toBe('Alpha');
    });

    it('does nothing while the block has no instance', () => {
        const container = canvasWithTopic('[[Alpha]]');
        relayoutMindmap({ container, handle: null });
        expect(container.querySelector('a')).toBeNull();
    });
});

describe('watchMindmapBox', () => {
    it('declines to watch where the environment has no ResizeObserver', () => {
        const seen: number[] = [];
        expect(watchMindmapBox({ container: canvasWithTopic('Core'), handle: null }, () => seen.push(1))).toBeNull();
        expect(seen).toEqual([]);
    });

    it('declines to watch an element that does not exist yet', () => {
        stubObserver();
        expect(watchMindmapBox({ container: null, handle: null }, () => {
            throw new Error('nothing is watched');
        })).toBeNull();
        expect(FakeResizeObserver.instances).toEqual([]);
    });

    it('reports every real box and no zero one', () => {
        stubObserver();
        let boxed = 0;
        watchMindmapBox({ container: canvasWithTopic('Core'), handle: null }, () => {
            boxed++;
        });
        const observer = FakeResizeObserver.instances[0]!;
        observer.report(0, 0);
        expect(boxed).toBe(0);
        observer.report(600, 400);
        expect(boxed).toBe(1);
        observer.report(600, 0);
        expect(boxed).toBe(1);
        observer.report(640, 420);
        expect(boxed).toBe(2);
    });
});

describe('watchMindmapContainer', () => {
    it('declines to watch where the environment has no ResizeObserver', () => {
        expect(watchMindmapContainer({ container: canvasWithTopic('Core'), handle: fakeHandle([]) })).toBeNull();
    });

    it('declines to watch a block whose canvas has not been built yet', () => {
        stubObserver();
        expect(watchMindmapContainer({ container: null, handle: fakeHandle([]) })).toBeNull();
        expect(FakeResizeObserver.instances).toEqual([]);
    });

    it('watches the map\'s own element rather than the block around it', () => {
        stubObserver();
        const container = canvasWithTopic('Core');
        expect(watchMindmapContainer({ container, handle: fakeHandle([]) })).not.toBeNull();
        expect(FakeResizeObserver.instances[0]?.targets).toEqual([container]);
    });

    it('re-measures and re-fits on every report of a real box', () => {
        stubObserver();
        const order: string[] = [];
        const container = canvasWithTopic('[[Alpha]]');
        watchMindmapContainer({ container, handle: fakeHandle(order) });
        FakeResizeObserver.instances[0]?.report(600, 400);
        expect(order).toEqual(['layout', 'scaleFit']);
        expect(container.querySelector('a[data-mindmap-node-link]')).not.toBeNull();
    });

    it('repairs a map that mounted into a hidden tab once the tab gets a box', () => {
        stubObserver();
        const order: string[] = [];
        watchMindmapContainer({ container: canvasWithTopic('Core'), handle: fakeHandle(order) });
        // The report an observer makes the instant it starts observing, taken while the panel is
        // still hidden: fitting to a zero box is what put NaN into the connectors in the first place.
        FakeResizeObserver.instances[0]?.report(0, 0);
        expect(order).toEqual([]);
        FakeResizeObserver.instances[0]?.report(619, 459);
        expect(order).toEqual(['layout', 'scaleFit']);
    });
});
