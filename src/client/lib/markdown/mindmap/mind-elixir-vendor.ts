/**
 * The only module that touches mind-elixir (MIT, zero runtime dependencies).
 * It is reached exclusively through a dynamic import (see ./loader), so the
 * library, its stylesheet and the plaintext converter stay in an async chunk
 * and never reach the first-screen bundle.
 *
 * Everything the rest of the app needs is narrowed to ./types: the vendor
 * adapter shape, a handle with view operations, and the body parse/serialize
 * pair. Nothing above this file knows the library's own API — except that the
 * body it hands over has already been through ./nodes.
 */
import MindElixir from 'mind-elixir';
import 'mind-elixir/style.css';
import { en, zh_CN, type LangPack } from 'mind-elixir/i18n';
import { mindElixirToPlaintext, plaintextToMindElixir } from 'mind-elixir/plaintextConverter';
import type { MindElixirData, MindElixirInstance, Options } from 'mind-elixir';
import type { AppLocale } from '@shared/types';
import { safeReviver } from '../chart';
import { normalizeEol, type MindmapMode } from './body';
import { assertMindmapBodySize, mindmapTextAsMarkup, sanitizeMindmapData } from './nodes';
import { APP_THEME_CHOICE, readThemeChoice, resolveThemeChoice, type MindmapPalette } from './theme';
import type { MindmapCreateOptions, MindmapHandle, MindmapParseResult, MindmapThemeInput, MindmapVendor } from './types';

const WHEEL_ZOOM_FACTOR = 0.0015;
const SCALE_MIN = 0.3;
const SCALE_MAX = 2.5;

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function localePack(locale: AppLocale): LangPack {
    return locale === 'zh-CN' ? zh_CN : en;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function present(value: unknown): boolean {
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
}

function asData(value: unknown): MindElixirData {
    return isRecord(value) ? (value as MindElixirData) : MindElixir.new('');
}

/** JSON bodies are validated before use; the outline parser reports its own errors. */
function parseBody(body: string, mode: MindmapMode, fallbackTitle: string): MindmapParseResult {
    const text = normalizeEol(body).trim();
    if (!text)
        return { ok: true, data: MindElixir.new(fallbackTitle), extra: {}, theme: APP_THEME_CHOICE };
    if (mode === 'json') {
        let parsed: unknown;
        try {
            assertMindmapBodySize(text);
            parsed = JSON.parse(text, safeReviver);
        }
        catch (err) {
            return { ok: false, error: messageOf(err) };
        }
        const { nodeData, arrows, summaries, ...extra } = isRecord(parsed) ? parsed : {};
        if (!isRecord(nodeData) || typeof nodeData.topic !== 'string')
            return { ok: false, error: 'a JSON body needs a "nodeData" object with a "topic"' };
        // Read out of `extra` instead of destructuring it away: the field is written back
        // verbatim by the serializer, so a round-trip keeps the body as it was typed.
        const theme = readThemeChoice(extra.theme);
        if ('error' in theme)
            return { ok: false, error: theme.error };
        const data = sanitizeMindmapData({
            ...(present(arrows) ? { arrows } : {}),
            ...(present(summaries) ? { summaries } : {}),
            nodeData,
        });
        return { ok: true, data, extra, theme: theme.choice };
    }
    try {
        // The outline format carries no fields of its own, so it always follows the app.
        // It can still carry per-node style and a summary or arrow label, so the tree the
        // library builds from it goes through the same guard as a JSON body.
        return {
            ok: true,
            data: sanitizeMindmapData(plaintextToMindElixir(text, fallbackTitle)),
            extra: {},
            theme: APP_THEME_CHOICE,
        };
    }
    catch (err) {
        return { ok: false, error: messageOf(err) };
    }
}

/**
 * Outline mode writes the library's plaintext line format back; JSON mode keeps
 * the fields the plaintext format cannot carry (theme, meta, direction, compact)
 * exactly as they were read, so a round-trip through the map never drops them.
 */
function serializeData(data: unknown, mode: MindmapMode, extra: Record<string, unknown>): string {
    if (mode === 'outline')
        return mindElixirToPlaintext(asData(data)).replace(/\s+$/, '');
    const record = isRecord(data) ? data : {};
    const payload = {
        nodeData: record.nodeData,
        ...(present(record.arrows) ? { arrows: record.arrows } : {}),
        ...(present(record.summaries) ? { summaries: record.summaries } : {}),
        ...extra,
    };
    return JSON.stringify(payload, null, 2);
}

/**
 * Maps a resolved palette onto the library's own theme objects. A custom theme is
 * used as written (the shape the library's own data files carry), laid over the
 * base its `type` names: the library reads `theme.palette` while drawing the
 * connectors and does not fall back, so a body that overrides only the colour
 * variables would otherwise throw on the first branch it paints.
 */
function libraryTheme(palette: MindmapPalette): typeof MindElixir.THEME {
    if (palette.kind === 'custom') {
        const custom = palette.theme as Partial<typeof MindElixir.THEME>;
        const base = custom.type === 'dark' ? MindElixir.DARK_THEME : MindElixir.THEME;
        return { ...base, ...custom };
    }
    return palette.kind === 'dark' ? MindElixir.DARK_THEME : MindElixir.THEME;
}

function zoomByWheel(instance: MindElixirInstance, event: WheelEvent): void {
    event.preventDefault();
    const next = clamp(instance.scaleVal * (1 - event.deltaY * WHEEL_ZOOM_FACTOR), SCALE_MIN, SCALE_MAX);
    instance.scale(next, { x: event.clientX, y: event.clientY });
}

/**
 * Paints the palette those inputs resolve to. A theme lives inside the instance:
 * `changeTheme` writes the colour variables as inline styles on the map's own
 * element, and the branch palette (`theme.palette`) is read when the connectors are
 * drawn, so the old colours survive until the connector pass runs again.
 * `shouldRefresh` is passed explicitly: the library defaults it to true, and that
 * path rebuilds every node and re-centres the camera, which would drop the
 * selection, the scroll position and any open inline topic editor with it.
 * Re-drawing the connectors is all a new palette needs, and a palette that is
 * already on screen is left alone.
 */
function paintTheme(instance: MindElixirInstance, input: MindmapThemeInput): void {
    const next = libraryTheme(resolveThemeChoice(input.choice, input.dark));
    if (next === instance.theme)
        return;
    instance.changeTheme(next, false);
    instance.linkDiv();
}

function createHandle(instance: MindElixirInstance, options: MindmapCreateOptions): MindmapHandle {
    const theme: MindmapThemeInput = { dark: options.dark, choice: options.body.theme };
    return {
        getData: () => instance.getData(),
        refresh: (body) => {
            theme.choice = body.theme;
            instance.refresh(asData(body.data));
            // The new body may name a different palette; refresh() draws with the one the
            // instance already had.
            paintTheme(instance, theme);
        },
        applyTheme: (next) => {
            theme.dark = next.dark;
            theme.choice = next.choice;
            paintTheme(instance, theme);
        },
        toCenter: () => instance.toCenter(),
        // A relayout rebuilds every node and draws no connector: the library's own pass
        // (`linkDiv`) is what paints them, and the groups a branch carries were measured
        // against the nodes that just went away. A bare `layout()` therefore loses every
        // level below the first — the main lines survive only because they hang off an
        // element that is re-appended into the new tree, and stale at that. Both callers
        // (the container watcher in ./resize, the full screen overlay in ./registry) want
        // the connectors drawn again; the watcher is why a fresh map arrived without them,
        // since a ResizeObserver reports once the moment it starts observing, right after
        // the library's own `init()` had drawn them.
        layout: () => {
            instance.layout();
            instance.linkDiv();
        },
        scaleFit: () => instance.scaleFit(),
        // The library binds every shortcut to its inner container (which carries
        // tabindex=0) and focuses it itself when an inline edit ends — this exposes
        // that same surface so a pointer interaction can do the same.
        focus: () => instance.container?.focus(),
        undo: () => instance.undo(),
        redo: () => instance.redo(),
        clearHistory: () => instance.clearHistory?.(),
        destroy: () => instance.destroy(),
        exportSvg: async () => {
            const blob = instance.exportSvg(true);
            if (!blob || blob.size === 0)
                throw new Error('mind-elixir produced an empty SVG');
            return blob;
        },
        exportPng: async () => {
            const blob = await instance.exportPng(true);
            return blob && blob.size > 0 ? blob : null;
        },
    };
}

/**
 * Puts the write path back in motion when the map steps through its own history. `undo` and `redo` are
 * the one way the map changes shape that the library keeps to itself: they restore a snapshot and
 * re-draw by hand without firing `operation`, so the app is never told and the note goes on holding
 * the edit the map just took back. Both callers look the method up on the instance when they fire —
 * the library binds its Ctrl+Z handler to the container and `createHandle` calls `instance.undo()` —
 * so replacing it here reaches both. A step that changed nothing costs nothing: the write path
 * compares the body it would send with the one the map came from.
 */
function announceHistory(instance: MindElixirInstance, onOperation: () => void): void {
    for (const command of ['undo', 'redo'] as const) {
        const step = instance[command];
        // The library installs its history during `init`, and only for a map it may edit.
        if (typeof step !== 'function')
            continue;
        instance[command] = function (this: MindElixirInstance) {
            step.call(this);
            onOperation();
        };
    }
}

function createMindmap(options: MindmapCreateOptions): MindmapHandle {
    // The wheel handler needs the instance it zooms, but the options object is what
    // creates it: the reference is filled in before any wheel event can arrive.
    const holder: { current: MindElixirInstance | null } = { current: null };
    const wheel: Options['handleWheel'] = options.modifierWheelZoom
        ? (event: WheelEvent) => {
            if (holder.current && (event.ctrlKey || event.metaKey))
                zoomByWheel(holder.current, event);
        }
        : true;
    const instance = new MindElixir({
        el: options.el,
        direction: MindElixir.SIDE,
        editable: options.editable,
        draggable: options.editable,
        contextMenu: options.editable ? { locale: localePack(options.locale), focus: true, link: true } : false,
        toolBar: options.editable,
        keypress: options.editable,
        allowUndo: options.editable,
        mouseSelectionButton: 0,
        mobileMultiSelect: true,
        theme: libraryTheme(resolveThemeChoice(options.body.theme, options.dark)),
        newTopicName: options.newTopicName,
        scaleMin: SCALE_MIN,
        scaleMax: SCALE_MAX,
        handleWheel: wheel,
        // The library writes every topic, arrow label and summary label it is given as
        // `innerHTML` unless a `markdown` renderer owns that step first. Handing it the
        // escaper is what keeps note text as text; see ./nodes for the whole contract.
        markdown: (text) => mindmapTextAsMarkup(text),
    });
    holder.current = instance;
    instance.bus.addListener('operation', (operation) => {
        const name = isRecord(operation) ? operation.name : undefined;
        if (name === 'beginEdit')
            options.onEditingChange(true);
        else if (name === 'finishEdit')
            options.onEditingChange(false);
        options.onOperation();
    });
    instance.bus.addListener('expandNode', () => options.onOperation());
    const failure = instance.init(asData(options.body.data));
    if (failure)
        throw failure;
    // The library installs its history during `init`, which is why this runs after it.
    announceHistory(instance, options.onOperation);
    return createHandle(instance, options);
}

/** Entry point of the dynamic import; wired up by ./loader. */
export function createMindmapVendor(): MindmapVendor {
    return { create: createMindmap, parse: parseBody, serialize: serializeData };
}
