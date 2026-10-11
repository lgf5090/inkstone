import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import type { BlockActionContext } from './block-overlay';
import { JSON_BLOCK_SELECTOR, jsonBlockState } from './json-block-toolbar';
import type { JsonViewMode } from './json-tree-view';

interface UseJsonBlocksOptions {
    hostRef: RefObject<HTMLDivElement | null>
    /** Bumped once the preview has committed its markup, which is when a fresh host exists to fill. */
    epoch: number
    /** Read at mount time rather than captured, so a write always sees the committed text. */
    context: () => BlockActionContext
}

interface JsonFullscreen {
    block: HTMLElement
    mode: JsonViewMode
}

/**
 * Draws the structure and mind-map faces of the note's JSON blocks after each commit.
 *
 * The head a reader presses is built earlier, on the staging markup, so it is part of what the preview
 * diffs against — a toolbar added after the swap would be wiped by the next keystroke. Only the *body*
 * of a view comes from here, because it needs the document model, and that is fetched on demand: a note
 * full of JSON that is read as text never downloads it.
 */
export function useJsonBlocks({ hostRef, epoch, context }: UseJsonBlocksOptions) {
    const [fullscreen, setFullscreen] = useState<JsonFullscreen | null>(null);

    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host || !epoch)
            return;
        const blocks = [...host.querySelectorAll<HTMLElement>(JSON_BLOCK_SELECTOR)];
        const open = blocks.filter((block) => jsonBlockState(block, { view: 'source', fold: 2 }).mode !== 'source');
        if (open.length === 0)
            return;
        void import('./json-view-mount')
            .then(module => module.mountJsonBlocks(open, context()))
            .catch((error: unknown) => {
                // A block that could not be drawn keeps its source view standing, which is the state
                // the reader can still read; the reason belongs in the console, not in their note.
                console.warn('[inkstone] JSON view mount failed', error);
            });
    }, [context, epoch, hostRef]);

    // A block whose face was closed by the last commit has nothing left to draw, and the host keeps the
    // rows it built: dropping them here is what stops a stale tree being read back after a mode change.
    useEffect(() => {
        const host = hostRef.current;
        if (!host)
            return;
        for (const block of host.querySelectorAll<HTMLElement>(JSON_BLOCK_SELECTOR)) {
            if (jsonBlockState(block, { view: 'source', fold: 2 }).mode !== 'source')
                continue;
            if (block.dataset.jsonCleared === String(epoch))
                continue;
            block.dataset.jsonCleared = String(epoch);
            block.querySelector<HTMLElement>(':scope > [data-json-host]')?.replaceChildren();
        }
    }, [epoch, hostRef]);

    const openFullscreen = useCallback((node: HTMLElement) => {
        const block = node.closest<HTMLElement>(JSON_BLOCK_SELECTOR) ?? node;
        const mode = jsonBlockState(block, { view: 'source', fold: 2 }).mode;
        setFullscreen({ block, mode });
    }, []);

    const closeFullscreen = useCallback(() => setFullscreen(null), []);

    return { fullscreen, openFullscreen, closeFullscreen };
}
