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
import { isMindmapErrorCode, mindmapError } from './errors';
import { normalizeEol, type MindmapMode } from './body';
import { mindmapNodeId } from './document';
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

/**
 * A message from one of the guards in ./nodes already names its own code, and that code is
 * what the interface looks up. Re-wrapping it as a JSON complaint would tell a reader their
 * body is malformed when what it is, in fact, too big — which is the mistake this module
 * made until a 300 KB document was measured on screen.
 */
function coded(message: string): string {
    const colon = message.indexOf(':');
    const head = (colon === -1 ? message : message.slice(0, colon)).trim();
    return isMindmapErrorCode(head) ? message : mindmapError('bad-json', message);
}

function asData(value: unknown): MindElixirData {
    return isRecord(value) ? (value as MindElixirData) : MindElixir.new('');
}

/**
 * The top-level fields the library reads off the file itself, checked on the way in.
 * `init` assigns `direction` to the instance without looking at it, so a body naming
 * `"direction": "down"` would leave the drawer computing offsets against a string and
 * drawing `NaN` connectors — the same reason `theme` is refused rather than ignored.
 *
 * A detail here is the offending value, spelled the way the file spells it, and nothing
 * else: the sentence that explains it belongs to the locale, and an English one in the
 * brackets would be the only English a reader in another language ever sees.
 */
function documentFields(extra: Record<string, unknown>): { fields: Record<string, unknown> } | { error: string } {
    const fields: Record<string, unknown> = {};
    const { direction, compact, meta } = extra;
    if (direction !== undefined) {
        if (direction !== 0 && direction !== 1 && direction !== 2 && direction !== 3)
            return { error: mindmapError('bad-direction', JSON.stringify(direction)) };
        fields.direction = direction;
    }
    if (compact !== undefined) {
        if (typeof compact !== 'boolean')
            return { error: mindmapError('bad-compact', JSON.stringify(compact)) };
        fields.compact = compact;
    }
    if (isRecord(meta))
        fields.meta = meta;
    return { fields };
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
        }
        catch (err) {
            // The size door is checked before the parse so the ceiling is never paid for in
            // order to be declined, and its own code has to survive: read as a syntax failure
            // it tells the reader their JSON is malformed, which is the one thing it is not.
            return { ok: false, error: coded(messageOf(err)) };
        }
        try {
            parsed = JSON.parse(text, safeReviver);
        }
        catch (err) {
            return { ok: false, error: mindmapError('bad-json', messageOf(err)) };
        }
        const { nodeData, arrows, summaries, ...extra } = isRecord(parsed) ? parsed : {};
        if (!isRecord(nodeData) || typeof nodeData.topic !== 'string')
            return { ok: false, error: mindmapError('no-node-data') };
        // Read out of `extra` instead of destructuring it away: the field is written back
        // verbatim by the serializer, so a round-trip keeps the body as it was typed.
        const theme = readThemeChoice(extra.theme);
        if ('error' in theme)
            return { ok: false, error: theme.error };
        const fields = documentFields(extra);
        if ('error' in fields)
            return { ok: false, error: fields.error };
        try {
            const data = sanitizeMindmapData({
                ...fields.fields,
                ...(present(arrows) ? { arrows } : {}),
                ...(present(summaries) ? { summaries } : {}),
                nodeData,
            });
            return { ok: true, data, extra, theme: theme.choice };
        }
        catch (err) {
            return { ok: false, error: coded(messageOf(err)) };
        }
    }
    try {
        // The same size door as the JSON branch: an outline has no byte guard of its own
        // today, which is how a five-thousand-line tree could get in, be trimmed to the
        // node budget, and come back out of the next edit with its tail gone.
        assertMindmapBodySize(text);
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
        // The guards speak in codes already; anything else is a plaintext parser complaint.
        return { ok: false, error: coded(messageOf(err)) };
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

/**
 * What the wheel handler and the fit drive: the map's transform, and the number it is
 * written from.
 *
 * Declared here rather than `Pick`ed off the library because the library types every method
 * with a `this` parameter, which a picked slice cannot keep and a test cannot fake. The
 * instance satisfies it as it stands.
 */
export interface MindmapViewport {
    scaleVal: number
    scale: (scaleVal: number, offset?: { x: number, y: number }) => void
    move: (dx: number, dy: number, smooth?: boolean) => boolean | void
}

/** What the fit needs: the same transform, and the measure that decides whether to write it. */
export interface MindmapFitViewport {
    scaleVal: number
    scale: (scaleVal: number, offset?: { x: number, y: number }) => void
    scaleFit: () => void
}

/**
 * Wheel pan and zoom, folded into one transform per animation frame.
 *
 * The library's own handler applies a `move`/`scale` per wheel event, and a trackpad or
 * a fast mouse wheel delivers those faster than the screen paints — at 1000 nodes each
 * one costs 100–125ms of rasterizing 1020 nodes and 1030 connectors, so the events queue
 * up behind each other and the gesture gets further behind the pointer with every tick.
 * Summing the deltas and paying for one frame per repaint is the only lever here that
 * does not change what the reader sees: the same pan, the same zoom, at most once a frame.
 *
 * The semantics are the library's own — plain wheel pans (shift pans sideways), Ctrl/⌘ +
 * wheel zooms about the pointer — because a map that silently rebinds the wheel is a map
 * that fights the reader's muscle memory.
 *
 * Exported for the tests, which drive it with a stand-in viewport and count the transforms.
 */
export function coalescedWheel(viewport: MindmapViewport, plainWheelPans: boolean): (event: WheelEvent) => void {
    let frame = 0;
    let zoomFactor = 1;
    let panX = 0;
    let panY = 0;
    let origin = { x: 0, y: 0 };
    const flush = () => {
        frame = 0;
        const factor = zoomFactor;
        const dx = panX;
        const dy = panY;
        const at = origin;
        zoomFactor = 1;
        panX = 0;
        panY = 0;
        if (factor !== 1)
            viewport.scale(clamp(viewport.scaleVal * factor, SCALE_MIN, SCALE_MAX), at);
        if (dx !== 0 || dy !== 0)
            viewport.move(-dx, -dy);
    };
    return (event: WheelEvent) => {
        const zooming = event.ctrlKey || event.metaKey;
        if (zooming) {
            event.preventDefault();
            zoomFactor *= 1 - event.deltaY * WHEEL_ZOOM_FACTOR;
            origin = { x: event.clientX, y: event.clientY };
        }
        else if (plainWheelPans) {
            // Same split the library makes: shift turns the wheel's vertical delta into
            // sideways travel, otherwise each axis follows the wheel.
            event.preventDefault();
            panX += event.shiftKey ? event.deltaY : event.deltaX;
            if (!event.shiftKey)
                panY += event.deltaY;
        }
        else {
            // A block in a scrolling preview leaves the bare wheel to the note: taking it
            // would trap the reader's scroll inside the map.
            return;
        }
        if (!frame)
            frame = requestAnimationFrame(flush);
    };
}

/** The instance is created after the options that mention it, so the handler holds a box. */
type ViewportBox = { current: MindmapViewport | null };

/**
 * The `handleWheel` the library is configured with. The instance does not exist yet when the
 * options are assembled, so this closes over a box that is filled in before any wheel event
 * can arrive, and builds the coalescer once, against the instance it now points at.
 */
export function wheelHandler(holder: ViewportBox, plainWheelPans: boolean): (event: WheelEvent) => void {
    let handler: ((event: WheelEvent) => void) | null = null;
    return (event: WheelEvent) => {
        if (holder.current)
            handler ||= coalescedWheel(holder.current, plainWheelPans);
        handler?.(event);
    };
}

/**
 * Drop the map's undo stack, and put back what the library drops along with it.
 *
 * `clearHistory` also calls `clearSelection`, and the library's Enter key adds a branch to
 * whatever is selected — so a reader who was editing when the ceiling arrived would find the
 * key dead from then on, with no way to tell that the map had just thrown its own memory away.
 * The selection is put back first as a group (multi-select behaves differently to a single
 * node), then as a node; a node the map no longer draws is left alone.
 */
function dropHistory(instance: MindElixirInstance): void {
    const single = instance.currentNode;
    const group = (instance.currentNodes ?? []).filter((node) => node?.isConnected);
    instance.clearHistory?.();
    if (group.length > 1)
        instance.selectNodes(group);
    else if (single?.isConnected)
        instance.selectNode(single);
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

/**
 * Fit the whole map into the box, then pull it back up to the floor the reader can read at.
 *
 * The library's own fit writes `scaleVal` directly and never consults the floor it hands to
 * the wheel, so a tall map is fitted to a fraction of a pixel per word: measured 0.034 for a
 * 1000-node document, and from there the wheel starts at a place no gesture reaches. Every
 * path that ends in a fit — the header button, the full screen attach, a block re-fitting
 * into a narrow column — comes through here, and a fit that measured nothing (a detached
 * map reads zero boxes) is left alone rather than written into the transform as `NaN`.
 */
export function fitToView(viewport: MindmapFitViewport, floor = SCALE_MIN): void {
    viewport.scaleFit();
    if (viewport.scaleVal < floor)
        viewport.scale(floor);
}

/**
 * A count of the steps a map has recorded since its history was last dropped.
 *
 * The library keeps its undo stack in a closure (`Kn` holds the array, its index and the
 * last snapshot) and hands out only `undo`, `redo` and `clearHistory` — there is no way to
 * read a length or drop the oldest entries. So the only ceiling available is the whole
 * stack, and reaching it costs the reader the deep past while leaving the recent past
 * undoable. `false` for every step but the one that has earned the drop keeps the caller
 * from clearing a history the reader may still be using.
 */
function stepCounter(limit: number): { step(): boolean; reset(): void } {
    let steps = 0;
    return {
        step: () => {
            if (!(limit > 0))
                return false;
            steps++;
            if (steps < limit)
                return false;
            steps = 0;
            return true;
        },
        reset: () => {
            steps = 0;
        },
    };
}

function createHandle(instance: MindElixirInstance, options: MindmapCreateOptions, history: { reset(): void }): MindmapHandle {
    const theme: MindmapThemeInput = { dark: options.dark, choice: options.body.theme };
    /** The library keeps the node's data on the element it drew for it. */
    const idOf = (node: unknown): string | null => {
        const obj = (node as { nodeObj?: { id?: unknown } } | null | undefined)?.nodeObj;
        return typeof obj?.id === 'string' ? obj.id : null;
    };
    /**
     * The node's element, or null when the map is not showing it. `findEle` *throws* for
     * an id it cannot see — a collapsed branch, a node another tab deleted a moment ago —
     * and an action that arrives after the selection it was offered has to decline quietly
     * rather than fail on the click.
     */
    const elementOf = (id: string) => {
        try {
            return instance.findEle(id) ?? null;
        }
        catch {
            return null;
        }
    };
    const addChild = async (id: string, topic: string): Promise<void> => {
        const parent = elementOf(id);
        if (!parent)
            return;
        await instance.addChild(parent, { id: mindmapNodeId(), topic, children: [] });
    };
    return {
        getData: () => instance.getData(),
        selectedNodeId: () => idOf(instance.currentNode),
        renameNode: (id, topic) => {
            const node = elementOf(id);
            if (node)
                void instance.setNodeTopic(node, topic);
        },
        appendChildren: (id, topics) => {
            void topics.reduce((chain, topic) => chain.then(() => addChild(id, topic)), Promise.resolve());
        },
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
        scaleFit: () => fitToView(instance),
        // The library binds every shortcut to its inner container (which carries
        // tabindex=0) and focuses it itself when an inline edit ends — this exposes
        // that same surface so a pointer interaction can do the same.
        focus: () => instance.container?.focus(),
        undo: () => instance.undo(),
        redo: () => instance.redo(),
        clearHistory: () => {
            // The reader dropping the history by hand resets the ceiling too, otherwise the
            // next step past the limit would clear a stack they had just emptied on purpose.
            history.reset();
            dropHistory(instance);
        },
        destroy: () => instance.destroy(),
        exportSvg: async () => {
            const blob = instance.exportSvg(true);
            if (!blob || blob.size === 0)
                throw new Error(mindmapError('empty-export', 'mind-elixir produced an empty SVG'));
            return blob;
        },
        exportPng: async () => {
            const blob = await instance.exportPng(true);
            return blob && blob.size > 0 ? blob : null;
        },
    };
}

/**
 * Puts the write path back in motion for the changes the library keeps to itself. `undo`
 * and `redo` restore a snapshot and re-draw by hand; `setNodeTopic` writes the topic,
 * re-renders the node and re-links the connectors — and none of them fire `operation`, so
 * the app is never told and the note goes on holding what the map used to say. All three
 * are wrapped here rather than at the call sites: the callers are the map's own key
 * bindings and context menu as much as this app's actions, and a write path that only
 * runs when Inkstone asked for the change is the one that goes stale. Both callers look
 * the method up on the instance when they fire — the library binds its Ctrl+Z handler to
 * the container and `createHandle` calls `instance.undo()` — so replacing it here reaches
 * both. A step that changed nothing costs nothing: the write path compares the body it
 * would send with the one the map came from.
 */
function announceSilentChanges(instance: MindElixirInstance, onOperation: () => void): void {
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
    const rename = instance.setNodeTopic;
    if (typeof rename === 'function') {
        instance.setNodeTopic = function (this: MindElixirInstance, el, topic) {
            const done = rename.call(this, el, topic);
            Promise.resolve(done).then(onOperation, onOperation);
            return done;
        };
    }
}

function createMindmap(options: MindmapCreateOptions): MindmapHandle {
    // The wheel handler needs the instance it zooms, but the options object is what
    // creates it: the reference is filled in before any wheel event can arrive.
    const holder: { current: MindElixirInstance | null } = { current: null };
    // Both surfaces coalesce; they differ only in whether the bare wheel pans. A block in a
    // scrolling preview must leave the bare wheel to the note, so it zooms on modifier only,
    // while the document owns its viewport and pans on the bare wheel like the library does.
    const wheel: Options['handleWheel'] = wheelHandler(holder, !options.modifierWheelZoom);
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
    // Whether an inline topic editor is open right now. Every listener here is added before the
    // library installs its own, so this flag is already current when the history bound below runs.
    let editing = false;
    instance.bus.addListener('operation', (operation) => {
        const name = isRecord(operation) ? operation.name : undefined;
        if (name === 'beginEdit') {
            editing = true;
            options.onEditingChange(true);
        }
        else if (name === 'finishEdit') {
            editing = false;
            options.onEditingChange(false);
        }
        options.onOperation();
    });
    instance.bus.addListener('expandNode', () => options.onOperation());
    const failure = instance.init(asData(options.body.data));
    if (failure)
        throw failure;
    // The library installs its history during `init`, which is why all of this runs after it.
    announceSilentChanges(instance, options.onOperation);
    // Steps since the last drop. The history lives in a closure with no length and no trim,
    // so the only ceiling available is the whole stack. This listener is deliberately a second
    // one, added after the library's: the drop has to land once the current step has been
    // written down, or the change that reached the ceiling would be lost along with everything
    // older — the reader would press undo and see nothing move.
    const history = stepCounter(options.undoStepLimit);
    let overdue = false;
    instance.bus.addListener('operation', (operation) => {
        if (isRecord(operation) && operation.name === 'beginEdit')
            return;
        if (!history.step() && !overdue)
            return;
        overdue = false;
        if (editing)
            // Dropping the stack clears the selection, and the library's Enter adds a branch to
            // whatever is selected: a reader typing a topic would lose the node under their keys.
            overdue = true;
        else
            dropHistory(instance);
    });
    return createHandle(instance, options, history);
}

/** Entry point of the dynamic import; wired up by ./loader. */
export function createMindmapVendor(): MindmapVendor {
    return { create: createMindmap, parse: parseBody, serialize: serializeData };
}
