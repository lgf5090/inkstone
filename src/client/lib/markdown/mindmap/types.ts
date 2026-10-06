import type { AppLocale } from '@shared/types';
import type { MindmapFencePatch, MindmapMode } from './body';
import type { MindmapThemeChoice } from './theme';

/**
 * One fence body as the vendor read it: what the library draws from, the fields
 * the outline format cannot carry, and the palette the body asks for (see
 * ./theme for how that meets the app's own setting). The three travel together
 * through the vendor's create/refresh pair, so a caller cannot hand over the data
 * and forget the theme it came with.
 */
export interface MindmapParsedBody {
    data: unknown
    extra: Record<string, unknown>
    theme: MindmapThemeChoice
}

/**
 * The narrow surface the rest of the app talks to. mind-elixir is wrapped
 * behind these interfaces (`./mind-elixir-vendor`) so the registry, the full screen view
 * and the static snapshot path never import the library directly — and so unit
 * tests can drive them with a stub vendor instead of a real instance.
 */
export interface MindmapHandle {
    getData(): unknown
    /** Loads a body the fence no longer matches, palette included. */
    refresh(body: MindmapParsedBody): void
    /**
     * Paints the palette those two inputs resolve to (./theme). The library bakes a
     * theme into the element it draws in (the colour variables are written as inline
     * styles, and the branch palette is painted into the connectors when they are
     * drawn), which is why a map has to be told rather than left to follow the app's
     * CSS — and why a pin it cannot honour is not something it can notice by itself.
     */
    applyTheme(theme: MindmapThemeInput): void
    toCenter(): void
    /**
     * Rebuilds the nodes for the box the map now has. The library draws the connectors in a
     * pass of its own and rebuilding takes the drawn ones with it, so the palette's own
     * branch groups are drawn again here: a caller that only wanted the new geometry still
     * wants the map connected. Every measurement it takes comes off the DOM, so the caller
     * has to have the element in the document already — a detached map reads zero-sized
     * nodes and draws `NaN` connectors from them (the preview re-parents it on every
     * commit, which is what makes this an ordering contract rather than a detail).
     */
    layout(): void
    scaleFit(): void
    /** Puts DOM focus on the map's own keyboard surface, so its shortcuts fire. */
    focus(): void
    undo(): void
    redo(): void
    clearHistory(): void
    destroy(): void
    /** SVG snapshot used by the share page, HTML/PDF export and the export menu. */
    exportSvg(): Promise<Blob>
    exportPng(): Promise<Blob | null>
}

/**
 * What a map draws its palette from: the app's appearance setting, and the palette the
 * fence it lives in asks for. Both travel together because either can change on its own
 * and the answer is only meaningful as a pair.
 */
export interface MindmapThemeInput {
    dark: boolean
    choice: MindmapThemeChoice
}

export interface MindmapCreateOptions {
    el: HTMLElement
    body: MindmapParsedBody
    editable: boolean
    dark: boolean
    locale: AppLocale
    newTopicName: string
    /**
     * Inline blocks sit in the scrolling preview, so plain wheel keeps scrolling
     * the note and only Ctrl/⌘ + wheel zooms; the full screen map owns its viewport
     * and gets the library's default pan/zoom wheel handling.
     */
    modifierWheelZoom: boolean
    onOperation: () => void
    onEditingChange: (editing: boolean) => void
}

export type MindmapParseResult = ({ ok: true } & MindmapParsedBody) | { ok: false; error: string };

export interface MindmapVendor {
    create(options: MindmapCreateOptions): MindmapHandle
    parse(body: string, mode: MindmapMode, fallbackTitle: string): MindmapParseResult
    serialize(data: unknown, mode: MindmapMode, extra: Record<string, unknown>): string
}

export type MindmapVendorLoader = () => Promise<MindmapVendor>;

/** Where a block's body lives in the note, as reported by the renderer. */
export interface MindmapFenceRef {
    line: number
    body: string
}

export type MindmapWriteResult = 'written' | 'moved' | 'conflict' | 'missing';

/** Writes a new fence body back into the note; see features/preview/mindmap-sync.ts. */
export type MindmapWriter = (ref: MindmapFenceRef, nextBody: string) => MindmapWriteResult;

/**
 * Rewrites the fence itself — the body, the palette named on its info line, or both at
 * once, in a single note edit. The header's palette control goes through this one,
 * because the two places a palette can be stated have to move together.
 */
export type MindmapFenceWriter = (ref: MindmapFenceRef, patch: MindmapFencePatch) => MindmapWriteResult;
