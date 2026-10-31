/**
 * The renderer generation a snapshot was produced with.
 *
 * A published snapshot is a *still* of the note body, but the reading runtime re-renders the same
 * markdown through the same pipeline. The number is part of the runtime URL and is written into every
 * snapshot, so a reader can only ever load the runtime that matches the markup it is given: after a
 * renderer change old snapshots keep their still until they are rebuilt, instead of silently swapping
 * in a different renderer.
 */
export const BLOG_RENDERER_VERSION = 'inkstone-blog-v3'
