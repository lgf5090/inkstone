/**
 * Mind map blocks (```mindmap) rendered with mind-elixir.
 *
 * `body.ts` owns the note-facing format (detection, fence surgery) and is
 * dependency-free; everything that needs the library goes through
 * `loadMindmapVendor`, which imports it dynamically so a note without a mind map
 * never downloads it.
 */
export {
    applyBodyAtFence,
    applyFencePatchAtSource,
    detectMindmapMode,
    insertTextAfterFence,
    mindmapFenceRange,
    MINDMAP_LANGUAGES,
    normalizeEol,
    replaceFenceWithText,
    type MindmapFence,
    type MindmapFencePatch,
    type MindmapFenceRange,
    type MindmapMode,
} from './body';
export { loadMindmapVendor } from './loader';
export {
    MINDMAP_BODY_LIMIT_BYTES,
    MINDMAP_NODE_LIMIT,
    MindmapBodyTooLargeError,
    assertMindmapBodySize,
    mindmapTextAsMarkup,
    sanitizeMindmapData,
} from './nodes';
export {
    captureMindmapFocus,
    destroyAllMindmaps,
    destroyMindmaps,
    fitMindmapBlock,
    flushMindmaps,
    mindmapEntryForNode,
    mindmapEntryKey,
    mindmapThemeMenuState,
    mountMindmaps,
    pickMindmapTheme,
    remeasureMindmapBlock,
    retryMindmap,
    setMindmapThemeMenuOpen,
    subscribeMindmaps,
    type MindmapBlockEntry,
    type MindmapMountOptions,
    type MindmapThemeMenuState,
} from './registry';
export { applyEntryBody, flushEntry, serializeEntry, serializeEntryAs } from './write';
export { openMindmapSession, type MindmapSession } from './session';
export { markdownToMindmapOutline, mindmapOutlineToMarkdown } from './outline';
export { parseMindmapNodeLink, splitMindmapTopicLinks, type MindmapTopicSegment } from './links';
export { decorateMindmapLinks, MINDMAP_NODE_LINK_ATTR, MINDMAP_NODE_LINK_CLASS } from './node-links';
export {
    APP_THEME_CHOICE,
    MINDMAP_THEME_ATTR,
    fenceThemeChoice,
    readFenceAnnotation,
    readThemeChoice,
    resolveThemeChoice,
    withFenceAnnotation,
    type MindmapPalette,
    type MindmapThemeChoice,
} from './theme';
export { MINDMAP_IMAGE_CLASS, renderStaticMindmapBlocks, renderStaticMindmaps, type StaticMindmapOptions } from './static';
export {
    createMindmapCanvas,
    decorateMindmapControls,
    disarmNativeFullscreen,
    isMindmapWritableHere,
    markMindmapLoading,
    markMindmapReady,
    MINDMAP_BLOCK_SELECTOR,
    MINDMAP_CANVAS_CLASS,
    MINDMAP_NATIVE_FULLSCREEN_SELECTOR,
    MINDMAP_PLACEHOLDER_SELECTOR,
    MINDMAP_THEME_AUTO,
    MINDMAP_THEME_PICK_SELECTOR,
    MINDMAP_THEME_PICKS,
    mindmapBlocks,
    mindmapBody,
    mindmapEditing,
    mindmapFenceRef,
    mindmapIndex,
    mindmapPlaceholder,
    mindmapThemeAnnotation,
    mindmapThemeButton,
    mindmapThemeLabel,
    mindmapThemeMenuPicks,
    resetMindmapNode,
    showMindmapError,
    showMindmapSource,
    showMindmapSourceAll,
    showMindmapThemeChoice,
    type MindmapThemePick,
    type MindmapThemePickName,
} from './view';
export type {
    MindmapCreateOptions,
    MindmapFenceRef,
    MindmapFenceWriter,
    MindmapHandle,
    MindmapParsedBody,
    MindmapParseResult,
    MindmapThemeInput,
    MindmapVendor,
    MindmapVendorLoader,
    MindmapWriter,
    MindmapWriteResult,
} from './types';
