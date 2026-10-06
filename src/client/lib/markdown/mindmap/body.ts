/**
 * DOM-free helpers behind the ```mindmap fence: format detection, EOL handling
 * and the fence surgery that two-way editing needs (the map's own writes, and the
 * header's palette control). The vendor-backed parse/serialize pair lives in ./mind-elixir-vendor,
 * so this file (and its tests) can be imported without pulling mind-elixir into the
 * caller's chunk.
 *
 * The surgery itself is not mind map specific — any block that rewrites its own
 * fence needs the same locate-and-replace — so it lives in ../fence-edit and this
 * module only adds what a mind map fence carries on top: its languages, its two
 * body formats, and the palette annotation on its info line.
 */
import {
    applyBodyAtFence as applyBody,
    applyFencePatchAtSource as applyPatch,
    fenceInfoAt,
    fenceRange as rangeOf,
    insertTextAfterFence as insertAfter,
    replaceFenceWithText as replaceWithText,
    type FenceRange,
    type FenceTarget,
} from '../fence-edit';
import { withFenceAnnotation } from './theme';

export type MindmapMode = 'outline' | 'json';

/** Fence languages that render as a mind map block. */
export const MINDMAP_LANGUAGES = ['mindmap', 'mind-elixir'] as const;

/** The body text of a mind map fence plus the line its opening fence sits on. */
export interface MindmapFence extends FenceTarget {}

/**
 * What one action asks of a fence: a new body, a new `theme=` annotation, or both at
 * once. An omitted field is left exactly as the note has it, which is what keeps a
 * palette change from rewriting the body (and a body change from dropping the line's
 * other metadata).
 */
export interface MindmapFencePatch {
    body?: string
    /** The annotation to write; null removes it, omitted leaves it alone. */
    annotation?: string | null
}

/**
 * The block's line span in the note: the opening fence through its closing line,
 * or through the end of the file when the fence is left open. An editor caller
 * maps these to character positions to replace the block in one transaction.
 */
export interface MindmapFenceRange extends FenceRange {}

/** JSON bodies start with `{`; everything else is read as the outline format. */
export function detectMindmapMode(body: string): MindmapMode {
    return body.trimStart().startsWith('{') ? 'json' : 'outline';
}

export function mindmapFenceRange(content: string, target: MindmapFence): MindmapFenceRange | null {
    return rangeOf(content, target, MINDMAP_LANGUAGES);
}

export function applyBodyAtFence(content: string, target: MindmapFence, nextBody: string): string | null {
    return applyBody(content, target, nextBody, MINDMAP_LANGUAGES);
}

export function replaceFenceWithText(content: string, target: MindmapFence, text: string): string | null {
    return replaceWithText(content, target, text, MINDMAP_LANGUAGES);
}

export function insertTextAfterFence(content: string, target: MindmapFence, text: string): string | null {
    return insertAfter(content, target, text, MINDMAP_LANGUAGES);
}

/**
 * The palette annotation is a mind map statement (./theme), so it is resolved here and
 * handed to the shared rewrite as the info line it produces. A fence that can no longer
 * be found yields null rather than a rewritten note: the caller then declines to write.
 */
export function applyFencePatchAtSource(content: string, target: MindmapFence, patch: MindmapFencePatch): string | null {
    if (patch.annotation === undefined)
        return applyPatch(content, target, { body: patch.body }, MINDMAP_LANGUAGES);
    const info = fenceInfoAt(content, target, MINDMAP_LANGUAGES);
    if (info === null)
        return null;
    return applyPatch(content, target, { body: patch.body, info: withFenceAnnotation(info, patch.annotation) }, MINDMAP_LANGUAGES);
}

export { normalizeEol } from '../fence-edit';
