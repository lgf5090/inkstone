import { decorateMindmapLinks } from './node-links';
import type { MindmapHandle } from './types';

/** The slice of a registry entry the watcher needs; keeps this module decoupled. */
export interface MindmapResizeTarget {
    container: HTMLElement | null
    handle: MindmapHandle | null
}

/**
 * Re-measure a map against its container and draw the result.
 *
 * The library measures node boxes once at init and on explicit layout calls, so anything that changed
 * the box since then leaves the drawing stale: `scaleFit` alone only moves the viewport over the old
 * geometry. A relayout rebuilds every node from its topic text and draws no connector, which is why
 * `handle.layout()` pairs the library's `layout` with its `linkDiv`, and why the link decorator has to
 * run again afterwards.
 */
export function relayoutMindmap(entry: MindmapResizeTarget): void {
    if (!entry.handle)
        return;
    entry.handle.layout();
    entry.handle.scaleFit();
    decorateMindmapLinks(entry.container);
}

/**
 * The library measures node boxes once at init and on explicit layout calls; it
 * never watches its container. When the host pane changes size afterwards — a
 * split-layout cycle after the map mounted, a dragged divider, a resized
 * window — the drawing keeps its stale geometry and can end up outside the
 * block entirely, unreachable for clicks. Watching the container re-fits the
 * map whenever its box actually changes; jsdom has no ResizeObserver, and the
 * degraded surfaces that use the registry would not re-fit anyway.
 */
export function watchMindmapContainer(entry: MindmapResizeTarget): ResizeObserver | null {
    if (typeof ResizeObserver === 'undefined' || !entry.container)
        return null;
    const observer = new ResizeObserver((observed) => {
        const box = observed[0]?.contentRect;
        // A zero box means the pane is currently hidden (edit-only layout); there
        // is nothing to fit into, and the next resize will bring one.
        if (!box || box.width === 0 || box.height === 0)
            return;
        // The observer reports once the moment it starts observing, which is right after the map was
        // first drawn; a fresh map therefore arrives re-laid-out once for free, which is also what
        // keeps a map that mounted into a hidden pane from staying broken.
        relayoutMindmap(entry);
    });
    observer.observe(entry.container);
    return observer;
}
