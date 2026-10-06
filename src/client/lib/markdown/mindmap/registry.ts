/**
 * Live mind map instances, one per block; the write-back itself lives in ./write.
 *
 * The preview re-renders by replacing the note's HTML wholesale, which destroys
 * every node inside it — including a map's DOM. So the registry owns the map's
 * own element (`container`) and re-parents it into the placeholder of each new
 * render: the instance, its camera, its selection and its undo stack all survive
 * a keystroke in the editor. That re-parenting is what makes two-way editing
 * feel native rather than a rebuild per keystroke.
 *
 * Blocks are matched to entries by their body first and by their number second,
 * so inserting a map above another one moves the instance with its text instead
 * of feeding it the neighbour's.
 */
import type { AppLocale } from '@shared/types';
import { t } from '../../i18n';
import { detectMindmapMode, normalizeEol } from './body';
import type { MindmapBlockEntry } from './entry';
import { loadMindmapVendor } from './loader';
import { decorateMindmapLinks } from './node-links';
import { watchMindmapContainer } from './resize';
import { renderStaticMindmapBlocks } from './static';
import { APP_THEME_CHOICE, fenceThemeChoice, type MindmapThemeChoice } from './theme';
import type { MindmapFenceWriter, MindmapVendorLoader, MindmapWriteResult, MindmapWriter } from './types';
import { flushEntry, scheduleWrite, setEntryTheme } from './write';
import { createMindmapCanvas, decorateMindmapControls, disarmNativeFullscreen, isMindmapWritableHere, markMindmapLoading, markMindmapReady, markMindmapThemeMenuOpen, MINDMAP_PLACEHOLDER_SELECTOR, mindmapBlocks, mindmapBody, mindmapIndex, mindmapThemeAnnotation, showMindmapError, showMindmapThemeChoice, type MindmapThemePickName } from './view';

export type { MindmapBlockEntry } from './entry';

export interface MindmapMountOptions {
    /** Stable id of the surface that owns these blocks (one per preview instance). */
    scope: string
    noteId: string | null
    dark: boolean
    locale: AppLocale
    editable: boolean
    writeBack?: MindmapWriter
    /** How the header's palette control rewrites the fence; without it the control is dead. */
    writeFence?: MindmapFenceWriter
    loadVendor?: MindmapVendorLoader
}

interface Assignment {
    node: HTMLElement
    entry: MindmapBlockEntry
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const entries = new Map<string, MindmapBlockEntry>();
const listeners = new Set<(scope: string) => void>();
/** Last mount options per surface, so a retry can rebuild a block on its own. */
const scopeOptions = new Map<string, MindmapMountOptions>();
/**
 * Mount passes per surface. A pass spans awaits (the vendor chunk, the instance
 * build), and a re-render can start a newer one while an older pass is still in
 * flight; the older pass must then keep its hands off — its `assignments`
 * describe the markup it was handed, and pruning against them would tear down
 * the entries the newer pass just installed (the live map included).
 */
const passTokens = new Map<string, number>();
let pendingKey = 0;

function beginPass(scope: string): number {
    const token = (passTokens.get(scope) ?? 0) + 1;
    passTokens.set(scope, token);
    return token;
}

function isCurrentPass(scope: string, token: number): boolean {
    return passTokens.get(scope) === token;
}

export function mindmapEntryKey(scope: string, index: number): string {
    return `${scope}#${index}`;
}

/**
 * The library binds every shortcut to DOM focus on its inner container, which a
 * pointer interaction does not grant: after clicking a node the focus would stay
 * wherever it was (typically the editor in a split view), and Tab, typing,
 * Delete, Ctrl+Z and Alt+arrows would act on the note instead of the map.
 * Pointer-down inside a live canvas therefore hands the map the focus before its
 * own handler runs. Targeting the entry's element (not the clicked node) keeps
 * working across re-renders, and skipping its inline editor lets text input
 * reach it untouched.
 */
export function captureMindmapFocus(root: ParentNode): () => void {
    const onPointerDown = (event: Event) => {
        const target = event.target;
        if (!(target instanceof Element))
            return;
        if (target.closest('[contenteditable="true"], input, textarea'))
            return;
        const canvas = target.closest('[data-mindmap-canvas]');
        if (!canvas)
            return;
        for (const entry of entries.values()) {
            if (entry.container === canvas)
                entry.handle?.focus();
        }
    };
    root.addEventListener('pointerdown', onPointerDown, true);
    return () => root.removeEventListener('pointerdown', onPointerDown, true);
}

/** The entry a block element belongs to, whatever key it currently holds. */
export function mindmapEntryForNode(node: HTMLElement): MindmapBlockEntry | null {
    for (const entry of entries.values()) {
        if (entry.host === node)
            return entry;
    }
    return null;
}

/** The header button of a live block; a no-op while the block is still loading. */
export function fitMindmapBlock(node: HTMLElement): void {
    mindmapEntryForNode(node)?.handle?.scaleFit();
}

/** Notifies when a block becomes ready, changes owner or starts editing. */
export function subscribeMindmaps(listener: (scope: string) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Listeners are told on a microtask: a mount pass runs inside the preview's
 * commit phase, and a listener's state update must not land there (React
 * rejects updates for one component during another's render/commit).
 */
function notify(scope: string): void {
    queueMicrotask(() => {
        for (const listener of [...listeners])
            listener(scope);
    });
}

function untitledTopic(): string {
    return t('preview.mindmap_untitled');
}

export async function mountMindmaps(root: HTMLElement, options: MindmapMountOptions): Promise<void> {
    const load = options.loadVendor ?? loadMindmapVendor;
    scopeOptions.set(options.scope, options);
    const pass = beginPass(options.scope);
    const blocks = mindmapBlocks(root);
    // A block inside an embedded note or a markdown example mirrors another
    // document: it gets a still picture instead of a live, writable instance.
    const nested = blocks.filter((node) => !options.editable || !isMindmapWritableHere(node));
    const assignments = assignEntries(blocks.filter((node) => !nested.includes(node)), options, load);
    for (const { node, entry } of assignments) {
        if (!isCurrentPass(options.scope, pass))
            return;
        try {
            await mountBlock(node, entry, options);
        }
        catch (err) {
            showMindmapError(node, messageOf(err));
        }
    }
    if (!isCurrentPass(options.scope, pass))
        return;
    pruneScope(options.scope, new Set(assignments.map(({ entry }) => entry)));
    if (nested.length > 0) {
        // Best-effort: the snapshot path reports its own failures on the block.
        void renderStaticMindmapBlocks(nested, { dark: options.dark, locale: options.locale, loadVendor: load }).catch((err: unknown) => {
            console.warn('[inkstone] nested mind map snapshot failed', messageOf(err));
        });
    }
}

/** Entry per block: same body first (it moved), then the same number (it was edited). */
function assignEntries(nodes: HTMLElement[], options: MindmapMountOptions, load: MindmapVendorLoader): Assignment[] {
    const assignments: Assignment[] = [];
    const taken = new Set<MindmapBlockEntry>();
    for (const node of nodes) {
        const body = normalizeEol(mindmapBody(node));
        const match = [...entries.values()].find(
            (entry) => entry.scope === options.scope && entry.source === body && !taken.has(entry),
        );
        if (match) {
            taken.add(match);
            assignments.push({ node, entry: match });
        }
    }
    for (const node of nodes) {
        if (assignments.some((assignment) => assignment.node === node))
            continue;
        const keyed = entries.get(mindmapEntryKey(options.scope, mindmapIndex(node)));
        if (keyed && !taken.has(keyed)) {
            taken.add(keyed);
            assignments.push({ node, entry: keyed });
            continue;
        }
        const created = createEntry(node, options, load);
        taken.add(created);
        assignments.push({ node, entry: created });
    }
    for (const { node, entry } of assignments) {
        const index = mindmapIndex(node);
        const key = mindmapEntryKey(options.scope, index);
        if (entry.key !== key)
            entries.delete(entry.key);
        entry.key = key;
        entry.index = index;
        entries.set(key, entry);
    }
    return assignments;
}

function createEntry(node: HTMLElement, options: MindmapMountOptions, load: MindmapVendorLoader): MindmapBlockEntry {
    const body = normalizeEol(mindmapBody(node));
    const created: MindmapBlockEntry = {
        // Temporary key: assignEntries() rekeys every entry once it owns a block.
        key: `${options.scope}@new-${++pendingKey}`,
        scope: options.scope,
        noteId: options.noteId,
        index: mindmapIndex(node),
        host: node,
        mode: detectMindmapMode(body),
        source: body,
        extra: {},
        editable: options.editable,
        owner: 'inline',
        dark: options.dark,
        bodyChoice: APP_THEME_CHOICE,
        annotation: null,
        choice: APP_THEME_CHOICE,
        locale: options.locale,
        load,
        vendor: null,
        handle: null,
        container: null,
        observer: null,
        ref: null,
        write: options.writeBack ?? null,
        writeFence: options.writeFence ?? null,
        dataKey: '',
        dirty: false,
        timer: null,
        pending: null,
    };
    entries.set(created.key, created);
    return created;
}

async function mountBlock(node: HTMLElement, entry: MindmapBlockEntry, options: MindmapMountOptions): Promise<void> {
    const body = normalizeEol(mindmapBody(node));
    entry.host = node;
    entry.noteId = options.noteId;
    decorateMindmapControls(node);
    // The instance outlives the markup it was built for, so a palette switch has to be
    // handed to it: both the fence's own annotation and the app's setting can move.
    const annotation = mindmapThemeAnnotation(node);
    const themeChanged = entry.dark !== options.dark || entry.annotation !== annotation;
    entry.dark = options.dark;
    entry.annotation = annotation;
    entry.locale = options.locale;
    entry.load = options.loadVendor ?? loadMindmapVendor;
    entry.ref = isMindmapWritableHere(node) ? { line: Number(node.dataset.line), body } : null;
    entry.write = options.writeBack ?? null;
    entry.writeFence = options.writeFence ?? null;
    entry.editable = options.editable && entry.ref !== null;
    if (entry.handle) {
        // In the document first: the library measures node boxes as it draws (MindmapHandle.layout).
        placeContainer(entry);
        // The staged copy this markup was diffed against always says "loading", and the swap copies
        // that class over a block whose map is back on screen. Marking it ready here is what stops the
        // block from briefly centering its canvas like a spinner; a body the vendor then refuses still
        // ends in the error state, because that path re-marks the block afterwards.
        markMindmapReady(node);
        if (themeChanged)
            applyEntryTheme(entry);
        // The fresh control ships the classic default, so the answer is written back even when
        // nothing moved: "follow the app" over a map drawn dark is the mismatch this avoids.
        else
            showMindmapThemeChoice(node, entry.choice);
        syncEntry(entry, body);
        return;
    }
    await createInstance(entry);
}

/** The fence changed in the editor: keep the instance, load the new data into it. */
function syncEntry(entry: MindmapBlockEntry, body: string): void {
    if (entry.source === body)
        return;
    entry.source = body;
    entry.mode = detectMindmapMode(body);
    const { vendor, handle } = entry;
    if (!vendor || !handle)
        return;
    const parsed = vendor.parse(body, entry.mode, untitledTopic());
    if (!parsed.ok) {
        showMindmapError(entry.host, parsed.error);
        return;
    }
    const dataKey = JSON.stringify(parsed.data);
    const dataChanged = dataKey !== entry.dataKey;
    entry.dataKey = dataKey;
    entry.extra = parsed.extra;
    entry.bodyChoice = parsed.theme;
    if (!applyEntryTheme(entry))
        return;
    // A fence edit that moved only the palette (or a field the drawing does not read) leaves
    // the map on screen exactly right: it is told about the new palette, while a refresh
    // would drop the camera, the selection and the undo stack for a colour change.
    if (dataChanged) {
        handle.refresh({ ...parsed, theme: entry.choice });
        handle.clearHistory();
        handle.toCenter();
    }
    // A refresh rebuilds every node, and a rebuilt node is drawn from its topic text again.
    decorateMindmapLinks(entry.container);
    markMindmapReady(entry.host);
    notify(entry.scope);
}

/**
 * Resolves the palette the fence asks for — its body's own field, else the annotation
 * beside it (./theme) — and paints it. Reports false when neither could be read, having
 * told the block why; the map then keeps whatever it was drawing rather than a guess.
 */
function applyEntryTheme(entry: MindmapBlockEntry): boolean {
    const declared = fenceThemeChoice(entry.bodyChoice, entry.annotation);
    if ('error' in declared) {
        showMindmapError(entry.host, declared.error);
        return false;
    }
    entry.choice = declared.choice;
    showMindmapThemeChoice(entry.host, entry.choice);
    entry.handle?.applyTheme({ dark: entry.dark, choice: entry.choice });
    return true;
}

/**
 * Builds the library instance for a block. Two passes can reach the same entry
 * when a re-render lands mid-mount, so they share one build: two `create` calls
 * would leave an orphan instance bound to an element nothing renders.
 */
function createInstance(entry: MindmapBlockEntry): Promise<void> {
    entry.pending ??= buildInstance(entry).finally(() => {
        entry.pending = null;
    });
    return entry.pending;
}

async function buildInstance(entry: MindmapBlockEntry): Promise<void> {
    markMindmapLoading(entry.host);
    const vendor = await entry.load();
    if (entries.get(entry.key) !== entry)
        return;
    const mode = detectMindmapMode(entry.source);
    const parsed = vendor.parse(entry.source, mode, untitledTopic());
    if (!parsed.ok) {
        showMindmapError(entry.host, parsed.error);
        return;
    }
    const container = createMindmapCanvas(entry.editable);
    entry.vendor = vendor;
    entry.mode = mode;
    entry.extra = parsed.extra;
    entry.bodyChoice = parsed.theme;
    entry.dataKey = JSON.stringify(parsed.data);
    // An annotation nobody can read leaves the block on its source, like a body the
    // vendor refused: a map drawn in some other palette than the one written would be
    // worse than one that says why it did not draw.
    if (!applyEntryTheme(entry))
        return;
    // The library measures node boxes as it draws, so the canvas has to be in the
    // document (inside the placeholder that gives it its height) before init runs;
    // a detached one lays out as zeros and draws NaN link paths.
    entry.container = container;
    placeContainer(entry);
    entry.handle = vendor.create({
        el: container,
        body: { ...parsed, theme: entry.choice },
        editable: entry.editable,
        dark: entry.dark,
        locale: entry.locale,
        newTopicName: t('preview.mindmap_new_topic'),
        modifierWheelZoom: true,
        onOperation: () => scheduleWrite(entry),
        onEditingChange: (editing) => {
            // Finishing an inline topic edit rebuilds that node, and a rebuilt node is
            // drawn from its topic text — the link has to be put back on it.
            if (!editing)
                decorateMindmapLinks(entry.container);
            notify(entry.scope);
        },
    });
    decorateMindmapLinks(entry.container);
    // The library's own full screen button cannot survive the re-parenting below,
    // so it hands over to the overlay rather than dropping out of the browser's
    // full screen on the first write.
    disarmNativeFullscreen(container);
    entry.observer = watchMindmapContainer(entry);
    markMindmapReady(entry.host);
    notify(entry.scope);
}

/** Re-parents the map's element into the current placeholder (or leaves it in the overlay). */
function placeContainer(entry: MindmapBlockEntry): void {
    const container = entry.container;
    if (!container || entry.owner === 'overlay')
        return;
    const target = entry.host.querySelector<HTMLElement>(MINDMAP_PLACEHOLDER_SELECTOR) ?? entry.host;
    if (container.parentElement !== target || target.childElementCount !== 1)
        target.replaceChildren(container);
}

function pruneScope(scope: string, keep: Set<MindmapBlockEntry>): void {
    for (const entry of [...entries.values()]) {
        // Entries whose block is gone have nothing left to write to, so the final
        // flush is skipped; the ones that merely changed owner stay.
        if (entry.scope === scope && !keep.has(entry))
            destroyEntry(entry, false);
    }
}

export function flushMindmaps(scope: string): void {
    for (const entry of entries.values()) {
        if (entry.scope === scope)
            flushEntry(entry);
    }
}

export function destroyMindmaps(scope: string): void {
    for (const entry of [...entries.values()]) {
        if (entry.scope === scope)
            destroyEntry(entry);
    }
}

export function destroyAllMindmaps(): void {
    for (const entry of [...entries.values()])
        destroyEntry(entry);
}

function destroyEntry(entry: MindmapBlockEntry, flush = true): void {
    // Flushing on teardown keeps the last edit of a closed pane.
    if (flush)
        flushEntry(entry);
    if (entry.timer !== null)
        window.clearTimeout(entry.timer);
    entry.observer?.disconnect();
    entry.observer = null;
    entry.handle?.destroy();
    entry.container?.remove();
    entry.handle = null;
    entry.vendor = null;
    entry.container = null;
    if (entries.get(entry.key) === entry)
        entries.delete(entry.key);
    notify(entry.scope);
}

/**
 * Everything the header's palette menu needs about the block it is open on: what the map
 * draws with now (the menu marks it and offers nothing else as selectable), and whether
 * the fence carries a theme object of its own, which is the only case the custom entry
 * can mean anything.
 */
export interface MindmapThemeMenuState {
    node: HTMLElement
    choice: MindmapThemeChoice
}

export function mindmapThemeMenuState(node: HTMLElement): MindmapThemeMenuState | null {
    const entry = mindmapEntryForNode(node)
    // A read-only block keeps its control (it still says what the map draws with); there is
    // simply nothing the menu could write, and the button on it is disabled.
    return entry && entry.editable ? { node, choice: entry.choice } : null;
}

/** Marks the block's control as open, so the menu and the button agree on the state. */
export function setMindmapThemeMenuOpen(node: HTMLElement, open: boolean): void {
    if (mindmapEntryForNode(node))
        markMindmapThemeMenuOpen(node, open);
}

/** Applies one of the menu's palettes to the block, writing the fence and repainting. */
export function pickMindmapTheme(node: HTMLElement, pick: MindmapThemePickName): MindmapWriteResult {
    const entry = mindmapEntryForNode(node);
    if (!entry || !entry.editable)
        return 'missing';
    const result = setEntryTheme(entry, pick);
    if (result === 'written' || result === 'moved')
        applyEntryTheme(entry);
    return result;
}

/**
 * Builds a block again after a failed render: the retry button on the error
 * banner has no other way back, since the mount pass only runs when the note's
 * markup is committed.
 */
export async function retryMindmap(node: HTMLElement): Promise<void> {
    const entry = mindmapEntryForNode(node);
    const options = entry ? scopeOptions.get(entry.scope) : null;
    if (entry)
        destroyEntry(entry, false);
    if (!options)
        return;
    await mountMindmaps(node.parentElement ?? node, options);
}

/**
 * Hands the live map to the full screen overlay: the same instance, so its
 * camera, selection and undo stack carry over and there is never a second copy
 * of the same map writing to the same note.
 */
export function attachMindmapToOverlay(entry: MindmapBlockEntry, target: HTMLElement): void {
    if (!entry.container)
        return;
    entry.owner = 'overlay';
    entry.container.classList.add('is-fullscreen');
    target.replaceChildren(entry.container);
    requestAnimationFrame(() => {
        entry.handle?.layout();
        entry.handle?.scaleFit();
        decorateMindmapLinks(entry.container);
    });
    notify(entry.scope);
}

export function detachMindmapFromOverlay(entry: MindmapBlockEntry): void {
    if (!entry.container)
        return;
    entry.owner = 'inline';
    entry.container.classList.remove('is-fullscreen');
    placeContainer(entry);
    entry.handle?.toCenter();
    notify(entry.scope);
}
