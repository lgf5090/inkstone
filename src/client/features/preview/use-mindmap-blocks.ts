import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useLocale } from '../../lib/i18n';
import {
    captureMindmapFocus,
    destroyMindmaps,
    flushMindmaps,
    mindmapThemeMenuState,
    mountMindmaps,
    openMindmapSession,
    type MindmapSession,
    type MindmapThemeMenuState,
} from '../../lib/markdown/mindmap';
import { createMindmapFenceWriter, createMindmapWriter } from './mindmap-sync';

export interface MindmapFullscreenState {
    session: MindmapSession
}

interface UseMindmapBlocksOptions {
    scope: string
    noteId: string | null
    hostRef: RefObject<HTMLDivElement | null>
    /**
     * Bumped once the preview has committed its markup, which is the only moment a fresh placeholder
     * exists to take the map. A body-only edit changes that markup too, because the body rides on the
     * block as an attribute.
     */
    epoch: number
    dark: boolean
}

/**
 * Mounts a live mind map per block after each commit and keeps them out of the
 * preview's way: the map's element is re-parented into the fresh markup before
 * paint, so typing in the editor never restarts a map.
 */
export function useMindmapBlocks(options: UseMindmapBlocksOptions) {
    const { scope, noteId, hostRef, epoch, dark } = options;
    const locale = useLocale();
    const writer = useMemo(() => createMindmapWriter(noteId), [noteId]);
    const fenceWriter = useMemo(() => createMindmapFenceWriter(noteId), [noteId]);
    const [fullscreen, setFullscreen] = useState<MindmapFullscreenState | null>(null);
    const [themeMenu, setThemeMenu] = useState<MindmapThemeMenuState | null>(null);

    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host || !epoch)
            return;
        void mountMindmaps(host, { scope, noteId, dark, locale, editable: true, writeBack: writer, writeFence: fenceWriter }).catch((err: unknown) => {
            // Per-block failures render their own error banner; this only catches a
            // wholesale failure such as a detached host.
            console.warn('[inkstone] mind map mount failed', err);
        });
    }, [epoch, dark, locale, noteId, scope, writer, fenceWriter, hostRef]);

    useMindmapTeardown(scope, setFullscreen, setThemeMenu);
    useMindmapPointerFocus(hostRef, epoch);

    const openFullscreen = useCallback((node: HTMLElement) => {
        const session = openMindmapSession(node);
        if (session)
            setFullscreen({ session });
    }, []);

    const closeFullscreen = useCallback(() => {
        setFullscreen((current) => {
            current?.session.moveBack();
            current?.session.flush();
            return null;
        });
    }, []);

    // The block's state is read when the button is clicked, not kept: the map is the source
    // of truth for what it draws with, and a menu left open over a re-render would otherwise
    // mark a palette the fence has since changed.
    const openThemeMenu = useCallback((node: HTMLElement) => {
        const state = mindmapThemeMenuState(node);
        if (state)
            setThemeMenu(state);
    }, []);
    const closeThemeMenu = useCallback(() => setThemeMenu(null), []);

    return { fullscreen, openFullscreen, closeFullscreen, themeMenu, openThemeMenu, closeThemeMenu };
}

/** Leaving the note (or the pane) writes the last edit and drops the instances. */
function useMindmapTeardown(
    scope: string,
    setFullscreen: Dispatch<SetStateAction<MindmapFullscreenState | null>>,
    setThemeMenu: Dispatch<SetStateAction<MindmapThemeMenuState | null>>,
): void {
    useEffect(() => {
        return () => {
            flushMindmaps(scope);
            destroyMindmaps(scope);
            setFullscreen(null);
            setThemeMenu(null);
        };
    }, [scope, setFullscreen, setThemeMenu]);
}

/**
 * Clicking a node hands the map the DOM focus its shortcuts need — in a split
 * view the editor would otherwise swallow Tab, Delete and undo. The full screen
 * overlay is portaled outside this host, so it installs its own listener on the
 * modal body; both resolve the same entry and focus twice is harmless.
 */
function useMindmapPointerFocus(hostRef: RefObject<HTMLDivElement | null>, epoch: number): void {
    useEffect(() => {
        const host = hostRef.current;
        if (!host)
            return;
        return captureMindmapFocus(host);
    }, [hostRef, epoch]);
}
