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
 * Calls `onBoxed` for every report of a real box, and for no other.
 *
 * This is the contract both watchers share: a zero box is not a size, it is the block being kept out
 * of the layout (a tab panel that is not showing, a closed `details`, an edit-only pane), and
 * measuring against one is what puts `NaN` into the connectors. An observer also reports once the
 * moment it starts observing, so installing one on a block that already has a box calls straight back
 * — waiting for a box is safe to install and then forget.
 */
export function watchMindmapBox(entry: MindmapResizeTarget, onBoxed: () => void): ResizeObserver | null {
    if (typeof ResizeObserver === 'undefined' || !entry.container)
        return null;
    const observer = new ResizeObserver((observed) => {
        const box = observed[0]?.contentRect;
        if (!box || box.width === 0 || box.height === 0)
            return;
        onBoxed();
    });
    observer.observe(entry.container);
    return observer;
}

/**
 * The library measures node boxes once at init and on explicit layout calls; it
 * never watches its container. When the host pane changes size afterwards — a
 * split-layout cycle after the map mounted, a dragged divider, a resized
 * window — the drawing keeps its stale geometry and can end up outside the
 * block entirely, unreachable for clicks. Watching the container re-fits the
 * map whenever its box actually changes; jsdom has no ResizeObserver, and the
 * degraded surfaces that use the registry would not re-fit anyway. The report
 * taken the moment watching starts is also what re-fits a fresh map once for free.
 */
export function watchMindmapContainer(entry: MindmapResizeTarget): ResizeObserver | null {
    return watchMindmapBox(entry, () => relayoutMindmap(entry));
}
