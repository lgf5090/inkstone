import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { AppLocale } from '@shared/types';
import { t } from '../../lib/i18n';
import {
    decorateMindmapLinks,
    hasLayoutBox,
    loadMindmapVendor,
    watchMindmapBox,
    watchMindmapContainer,
    type MindmapHandle,
    type MindmapMode,
    type MindmapThemeChoice,
    type MindmapVendor,
    type MindmapVendorLoader,
} from '../../lib/markdown/mindmap';

export type MindmapDocumentStatus = 'loading' | 'ready' | 'error';

export interface MindmapDocumentController {
    /** The element the library draws into; it owns the map's whole box. */
    hostRef: RefObject<HTMLDivElement | null>
    status: MindmapDocumentStatus
    error: string | null
    /** The live map, or null before it is drawn and after it is torn down. */
    map(): MindmapHandle | null
    /** The document as it stands on screen, rendered into the given body format. */
    serializeAs(mode: MindmapMode): string | null
}

interface Options {
    content: string
    editable: boolean
    dark: boolean
    locale: AppLocale
    autoSaveMs: number
    /** Called with the whole new body after the map settles; the note's text is the document. */
    onBodyChange: (next: string) => void
    /** Stands in for the library chunk in tests; the registry takes the same seam. */
    loadVendor?: MindmapVendorLoader
}

interface Live {
    vendor: MindmapVendor
    handle: MindmapHandle
    extra: Record<string, unknown>
    choice: MindmapThemeChoice
}

/**
 * Draws one mind map document and keeps the note's text in step with it.
 *
 * A fence block is mounted by the registry, which owns a map per block and re-parents
 * it through every preview render. A `.elixir` note has no markup to be a block in —
 * the whole note *is* the body — so this hook owns exactly one instance for the life of
 * the surface, and the two directions of sync are correspondingly simple: the map's
 * operations are serialized out on a debounce, and text that arrives from anywhere else
 * (the code view, an undo, another device) is parsed back in.
 *
 * The `emitted` ref is what keeps those two from chasing each other: a body the hook
 * just handed over is never re-loaded, because the map already shows it and reloading
 * would drop the camera, the selection and the undo stack on every keystroke.
 */
export function useMindmapDocument(options: Options): MindmapDocumentController {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const [status, setStatus] = useState<MindmapDocumentStatus>('loading');
    const [error, setError] = useState<string | null>(null);
    const live = useRef<Live | null>(null);
    const emitted = useRef(options.content);
    const writeTimer = useRef<number | null>(null);
    const bodyChange = useRef(options.onBodyChange);
    const autoSave = useRef(options.autoSaveMs);
    const contentRef = useRef(options.content);
    const loadVendor = useRef<MindmapVendorLoader>(options.loadVendor ?? loadMindmapVendor);
    const darkAtMount = useRef(options.dark);
    const localeAtMount = useRef(options.locale);
    const editableAtMount = useRef(options.editable);

    useEffect(() => {
        bodyChange.current = options.onBodyChange;
    });
    autoSave.current = options.autoSaveMs;
    contentRef.current = options.content;
    loadVendor.current = options.loadVendor ?? loadMindmapVendor;
    darkAtMount.current = options.dark;
    localeAtMount.current = options.locale;
    editableAtMount.current = options.editable;

    const flush = useCallback(() => {
        if (writeTimer.current !== null) {
            window.clearTimeout(writeTimer.current);
            writeTimer.current = null;
        }
        const current = live.current;
        if (!current)
            return;
        const next = current.vendor.serialize(current.handle.getData(), 'json', current.extra);
        // Re-decorate on the way out, not only on a reload: an inline topic edit, a rename
        // through the API and an added branch all rebuild that node from its text, and a
        // node that names another note stops being a link until this runs again.
        decorateMindmapLinks(hostRef.current);
        if (next === emitted.current)
            return;
        emitted.current = next;
        bodyChange.current(next);
    }, []);

    const scheduleWrite = useCallback(() => {
        if (!live.current)
            return;
        if (writeTimer.current !== null)
            window.clearTimeout(writeTimer.current);
        writeTimer.current = window.setTimeout(flush, autoSave.current);
    }, [flush]);

    const mountKey = `${options.editable}|${options.locale}`;

    useEffect(() => {
        const host = hostRef.current;
        if (!host)
            return;
        let cancelled = false;
        let observer: ResizeObserver | null = null;
        const entry = { container: host as HTMLElement | null, handle: null as MindmapHandle | null };
        const editable = editableAtMount.current;
        const dark = darkAtMount.current;
        const locale = localeAtMount.current;

        const adopt = (vendor: MindmapVendor, handle: MindmapHandle, extra: Record<string, unknown>, choice: MindmapThemeChoice) => {
            if (cancelled) {
                handle.destroy();
                return;
            }
            live.current = { vendor, handle, extra, choice };
            entry.handle = handle;
            observer?.disconnect();
            observer = watchMindmapContainer(entry);
            decorateMindmapLinks(host);
            setStatus('ready');
        };

        const build = async () => {
            const vendor = await loadVendor.current();
            if (cancelled)
                return;
            // Read the text as it is now, not as it was when the surface mounted: a
            // note can be edited, undone or synced into while the chunk is still arriving.
            emitted.current = contentRef.current;
            const parsed = vendor.parse(emitted.current, 'json', t('preview.mindmap_untitled'));
            if (!parsed.ok) {
                setError(parsed.error);
                setStatus('error');
                return;
            }
            const create = () => vendor.create({
                el: host,
                body: parsed,
                editable,
                dark,
                locale,
                newTopicName: t('preview.mindmap_new_topic'),
                // The document owns its viewport: plain wheel pans and zooms here, where a
                // block in a scrolling preview has to leave the wheel to the note.
                modifierWheelZoom: false,
                onOperation: scheduleWrite,
                onEditingChange: (editing) => {
                    // Finishing an inline edit rebuilds that node from its topic text, so the
                    // link has to be put back on it before the debounce gets there.
                    if (!editing)
                        decorateMindmapLinks(host);
                },
            });
            // The library measures node boxes out of the DOM as it draws, so a host with no
            // box — a pane that is not showing — would be laid out against zeros and draw NaN
            // connectors. Wait for a real box instead.
            if (!hasLayoutBox(host)) {
                observer = watchMindmapBox(entry, () => {
                    if (cancelled || live.current)
                        return;
                    adopt(vendor, create(), parsed.extra, parsed.theme);
                });
                if (!observer)
                    adopt(vendor, create(), parsed.extra, parsed.theme);
                return;
            }
            adopt(vendor, create(), parsed.extra, parsed.theme);
        };

        void build();
        return () => {
            cancelled = true;
            if (writeTimer.current !== null) {
                window.clearTimeout(writeTimer.current);
                writeTimer.current = null;
            }
            observer?.disconnect();
            flush();
            live.current?.handle.destroy();
            live.current = null;
            entry.handle = null;
            host.replaceChildren();
        };
    }, [flush, mountKey, scheduleWrite]);

    // Text that did not come from this map: load it in, palette and all.
    useEffect(() => {
        const current = live.current;
        if (!current || options.content === emitted.current)
            return;
        const parsed = current.vendor.parse(options.content, 'json', t('preview.mindmap_untitled'));
        if (!parsed.ok) {
            setError(parsed.error);
            setStatus('error');
            return;
        }
        emitted.current = options.content;
        setError(null);
        current.extra = parsed.extra;
        current.choice = parsed.theme;
        current.handle.refresh({ ...parsed, theme: parsed.theme });
        decorateMindmapLinks(hostRef.current);
        setStatus('ready');
    }, [options.content]);

    useEffect(() => {
        const current = live.current;
        if (current)
            current.handle.applyTheme({ dark: options.dark, choice: current.choice });
    }, [options.dark, status]);

    const map = useCallback((): MindmapHandle | null => live.current?.handle ?? null, []);

    const serializeAs = useCallback((mode: MindmapMode) => {
        const current = live.current;
        // The JSON body keeps the fields it came with; an outline body has nowhere to
        // hold them, and writing them into a tree format would invent syntax.
        return current
            ? current.vendor.serialize(current.handle.getData(), mode, mode === 'json' ? current.extra : {})
            : null;
    }, []);

    return { hostRef, status, error, map, serializeAs };
}
