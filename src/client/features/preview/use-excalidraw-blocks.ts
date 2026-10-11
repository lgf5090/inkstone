import { useEffect, useLayoutEffect, useMemo, type RefObject } from 'react';
import { useLocale, t } from '../../lib/i18n';
import { registerFenceBodies, type FenceBodies } from '../../lib/markdown/fence-bodies';
import {
    destroyExcalidrawBlocks,
    mountExcalidrawBlocks,
    type ExcalidrawBlockEntry,
} from '../../lib/markdown/excalidraw';
import { createExcalidrawWriter } from './excalidraw-sync';

interface UseExcalidrawBlocksOptions {
    scope: string;
    noteId: string | null;
    hostRef: RefObject<HTMLDivElement | null>;
    epoch: number;
    dark: boolean;
    /**
     * The scene bodies this markup was rendered from, registered on the live host before mounting: the
     * preview registers them on its detached staging copy, and a block that was moved into the host
     * reads nothing above it without this. Also a mount trigger, because a body-only edit leaves the
     * markup string identical. Null until the pane has committed markup once — mounting before that
     * would park every block on an empty scene it can no longer be told out of.
     */
    fences: FenceBodies | null;
}

export function useExcalidrawBlocks(options: UseExcalidrawBlocksOptions) {
    const { scope, noteId, hostRef, epoch, dark, fences } = options;
    const locale = useLocale();
    const writer = useMemo(() => createExcalidrawWriter(noteId), [noteId]);

    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host || !epoch || !fences) return;

        registerFenceBodies(host, fences);
        void mountExcalidrawBlocks(host, {
            scope,
            noteId,
            dark,
            locale,
            editable: true,
            writeBack: writer,
        }).catch((err: unknown) => {
            console.warn('[inkstone] excalidraw mount failed', err);
        });
    }, [epoch, dark, locale, noteId, scope, writer, hostRef, fences]);

    useEffect(() => {
        return () => {
            destroyExcalidrawBlocks(scope);
        };
    }, [scope]);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const handleFullscreen = (e: Event) => {
            const customEvent = e as CustomEvent<{ entry: ExcalidrawBlockEntry }>;
            const entry = customEvent.detail?.entry;
            if (!entry) return;

            const block = entry.container;
            const isFull = block.classList.toggle('excalidraw-fullscreen');

            const fullBtn = block.querySelector<HTMLButtonElement>('[data-excalidraw-fullscreen]');
            if (fullBtn) {
                fullBtn.title = isFull
                    ? t('preview.excalidraw_exit_fullscreen') || 'Exit full screen'
                    : t('preview.excalidraw_fullscreen') || 'Fullscreen';
            }

            if (isFull) {
                document.body.style.overflow = 'hidden';
            } else {
                document.body.style.overflow = '';
            }

            block.dispatchEvent(new CustomEvent('excalidraw-fullscreen-change', { detail: { isFullscreen: isFull } }));

            requestAnimationFrame(() => {
                entry.zoomToFit();
            });
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                const fullscreenBlock = host.querySelector<HTMLElement>('.excalidraw-block.excalidraw-fullscreen');
                if (fullscreenBlock) {
                    fullscreenBlock.classList.remove('excalidraw-fullscreen');
                    document.body.style.overflow = '';
                    const fullBtn = fullscreenBlock.querySelector<HTMLButtonElement>('[data-excalidraw-fullscreen]');
                    if (fullBtn) {
                        fullBtn.title = t('preview.excalidraw_fullscreen') || 'Fullscreen';
                    }
                    fullscreenBlock.dispatchEvent(new CustomEvent('excalidraw-fullscreen-change', { detail: { isFullscreen: false } }));
                }
            }
        };

        host.addEventListener('excalidraw-fullscreen', handleFullscreen);
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            host.removeEventListener('excalidraw-fullscreen', handleFullscreen);
            window.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = '';
        };
    }, [hostRef]);
}
