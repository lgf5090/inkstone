/**
 * What the registry keeps per block: the instance, the element it draws in and
 * everything the mount pass, the write-back and the full screen overlay need to
 * act on it later. It lives in its own module so those layers can share it
 * without importing each other.
 */
import type { AppLocale } from '@shared/types';
import type { MindmapMode } from './body';
import type { watchMindmapContainer } from './resize';
import type { MindmapThemeChoice } from './theme';
import type { MindmapFenceRef, MindmapFenceWriter, MindmapHandle, MindmapVendor, MindmapVendorLoader, MindmapWriter } from './types';

export interface MindmapBlockEntry {
    key: string
    scope: string
    /** The note the block belongs to, so an action can rewrite it around the fence. */
    noteId: string | null
    index: number
    host: HTMLElement
    mode: MindmapMode
    source: string
    extra: Record<string, unknown>
    editable: boolean
    owner: 'inline' | 'overlay'
    dark: boolean
    /** What the fence's own body says about its palette (./theme). */
    bodyChoice: MindmapThemeChoice
    /** The palette the fence names in its info string, as written, or null. */
    annotation: string | null
    /** What the map draws with once both of the above have been resolved. */
    choice: MindmapThemeChoice
    locale: AppLocale
    load: MindmapVendorLoader
    vendor: MindmapVendor | null
    handle: MindmapHandle | null
    container: HTMLElement | null
    /** Watches the inline container: to re-fit a drawn map, or to catch the first real box. */
    observer: ReturnType<typeof watchMindmapContainer>
    ref: MindmapFenceRef | null
    write: MindmapWriter | null
    /** Rewrites the whole fence (body and/or annotation) for the header's palette control. */
    writeFence: MindmapFenceWriter | null
    /** The body's drawing data, to tell a palette-only fence edit from a real one. */
    dataKey: string
    dirty: boolean
    timer: number | null
    /** The instance currently being built for this block, shared by concurrent passes. */
    pending: Promise<void> | null
    /** Set while the block is kept out of the layout: its first drawing waits for a real box. */
    awaitingBox: boolean
}
