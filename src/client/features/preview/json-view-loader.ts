/**
 * The one place the JSON views' lazy module is held.
 *
 * The module is fetched on demand so a note full of JSON that is only ever read as text never downloads
 * a document model and a layout engine. But a promise resolves after paint, and the preview commits its
 * new markup — with an empty view host — before that resolution lands, so every commit showed the reader
 * an empty box for a frame. This module keeps the resolved value as well as the promise, so a caller
 * running inside a layout effect can paint synchronously once the chunk is warm.
 */
import type * as JsonViews from './json-view-mount';

let loaded: typeof JsonViews | null = null;
let pending: Promise<typeof JsonViews> | null = null;

/** The resolved module, or null when it has not come in yet. */
export function jsonViewsSync(): typeof JsonViews | null {
    return loaded;
}

/** The module, fetching it the first time anything asks. */
export function jsonViews(): Promise<typeof JsonViews> {
    if (loaded)
        return Promise.resolve(loaded);
    pending ??= import('./json-view-mount').then((module) => {
        loaded = module;
        return module;
    });
    return pending;
}
