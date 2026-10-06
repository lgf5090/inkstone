/**
 * DOM helpers for mind map blocks: reading what the renderer registered for a
 * placeholder, and the two degraded states (source fallback, error banner).
 * These are the only paths that touch the block markup, so the mount/static
 * renderers and the preview interaction handlers stay in sync on the contract.
 */
import { t } from '../../i18n';
import { decodeDataValue } from '../data-attr';
import { normalizeEol } from './body';
import { MINDMAP_THEME_ATTR, type MindmapThemeChoice } from './theme';
import type { MindmapFenceRef } from './types';

export const MINDMAP_BLOCK_SELECTOR = '[data-mindmap]';
export const MINDMAP_PLACEHOLDER_SELECTOR = '[data-mindmap-placeholder]';
export const MINDMAP_CANVAS_CLASS = 'mindmap-canvas';
/** The library's own toolbar button that asks the browser for native full screen. */
export const MINDMAP_NATIVE_FULLSCREEN_SELECTOR = '#fullscreen';
/** The header's palette control; the value it holds is one of the `theme=` names. */
export const MINDMAP_THEME_PICK_SELECTOR = '[data-mindmap-theme-pick]';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The block's header buttons ship as empty markup because the sanitizer keeps
 * SVG out of the prose whitelist (mXSS-prone element combinations), so their
 * icons are appended as DOM nodes here, next to the other post-sanitize
 * producers (task checkboxes, KaTeX output). Path data: lucide's expand and
 * maximize-2.
 */
const CONTROL_ICONS: Record<string, string[]> = {
    'data-mindmap-fit': ['m15 15 6 6', 'm15 9 6-6', 'M21 16v5h-5', 'M21 8V3h-5', 'M3 16v5h5', 'm3 21 6-6', 'M3 8V3h5', 'M9 9 3 3'],
    'data-mindmap-fullscreen': ['M15 3h6v6', 'm21 3-7 7', 'm3 21 7-7', 'M9 21H3v-6'],
};

function iconSvg(paths: string[]): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const data of paths) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', data);
        svg.append(path);
    }
    return svg;
}

/** Adds the header icons to a freshly rendered block; a no-op on later passes. */
export function decorateMindmapControls(node: HTMLElement): void {
    for (const [attribute, paths] of Object.entries(CONTROL_ICONS)) {
        const button = node.querySelector<HTMLElement>(`[${attribute}]`);
        if (button && !button.querySelector('svg'))
            button.append(iconSvg(paths));
    }
}

/**
 * The library's toolbar ships a full screen button that puts its canvas — not
 * the app — into the browser's own full screen. That cannot hold here: the
 * preview re-renders the note's markup on every commit, and the registry then
 * re-parents the canvas into the fresh placeholder, which detaches it and makes
 * the browser drop the full screen. Adding a sibling with Enter is enough to
 * trigger it, because the edit schedules a write. The native request is switched
 * off and the button is routed to our full screen overlay instead, which is
 * built for this view and survives the re-render; see features/preview/Preview.tsx.
 */
export function disarmNativeFullscreen(root: ParentNode): void {
    const button = root.querySelector<HTMLElement>(MINDMAP_NATIVE_FULLSCREEN_SELECTOR);
    if (button)
        button.onclick = null;
}

/**
 * The element the library draws in. Its ARIA role says what the widget is: the
 * library owns the arrow keys, Tab and Enter inside it, which is what
 * `application` tells assistive tech to expect.
 */
export function createMindmapCanvas(editable: boolean): HTMLElement {
    const container = document.createElement('div');
    container.className = MINDMAP_CANVAS_CLASS;
    container.dataset.mindmapCanvas = '1';
    container.tabIndex = 0;
    container.setAttribute('role', 'application');
    container.setAttribute('aria-label', t('preview.mindmap'));
    if (!editable)
        container.classList.add('is-readonly');
    return container;
}

export function mindmapBlocks(root: ParentNode): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(MINDMAP_BLOCK_SELECTOR)];
}

/**
 * The block's canonical body: what the renderer encoded onto it, with the final line
 * feed markdown-it appends to a fence removed. Everything that compares bodies
 * (write-back, source sync) goes through here so both sides agree.
 */
export function mindmapBody(node: HTMLElement): string {
    return normalizeEol(decodeDataValue(node.dataset.mindmap)).replace(/\n$/, '');
}

/**
 * The palette the fence asks for in its own info string (` ```mindmap theme=dark `), as
 * written, or null when it names none. The renderer puts it on the block because the
 * registry is the only layer that gets to interpret it (see ./theme).
 */
export function mindmapThemeAnnotation(node: HTMLElement): string | null {
    return node.getAttribute(MINDMAP_THEME_ATTR);
}

export function mindmapIndex(node: HTMLElement): number {
    const value = Number(node.dataset.mindmapIndex);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function mindmapPlaceholder(node: HTMLElement): HTMLElement | null {
    return node.querySelector<HTMLElement>(MINDMAP_PLACEHOLDER_SELECTOR);
}

/** The fence this block mirrors, or null when writing back would be unsafe. */
export function mindmapFenceRef(node: HTMLElement): MindmapFenceRef | null {
    const raw = node.dataset.line;
    if (raw === undefined || !/^\d+$/.test(raw))
        return null;
    return { line: Number(raw), body: mindmapBody(node) };
}

/**
 * Nested renders (an embedded note, a markdown example) carry a `data-line`
 * that points into *their* source, so writing back from there would corrupt the
 * note that is open. Those blocks stay view-only, exactly like the task
 * checkboxes inside embedded notes.
 */
export function isMindmapWritableHere(node: HTMLElement): boolean {
    return Boolean(mindmapFenceRef(node)) && !node.closest('.note-embed-body, .markdown-example-preview');
}

/**
 * The library's inline topic editor. Its presence is the editing state, read
 * from the DOM rather than tracked from bus events: a missed event would leave a
 * stale flag and the overlay would stop closing on Escape.
 */
export function mindmapEditing(node: HTMLElement | null): boolean {
    return Boolean(node?.querySelector('#input-box'));
}

function removeHeadControls(node: HTMLElement): void {
    node.querySelectorAll<HTMLElement>(`[data-mindmap-fullscreen], [data-mindmap-fit], ${MINDMAP_THEME_PICK_SELECTOR}`).forEach((control) => control.remove());
}

/**
 * The palette control the block's header carries, or null when this render emitted none
 * (the degraded states remove it along with the other head controls).
 */
export function mindmapThemeButton(node: HTMLElement): HTMLButtonElement | null {
    return node.querySelector<HTMLButtonElement>(MINDMAP_THEME_PICK_SELECTOR);
}

/** What the picker's own values are called; the fence stores `theme=<one of these>`. */
export type MindmapThemePick = 'auto' | 'light' | 'dark' | 'custom';

export const MINDMAP_THEME_AUTO = 'auto';

/** The picks that name a palette a fence can be written to draw with. */
export type MindmapThemePickName = Exclude<MindmapThemePick, 'custom'>;

/** The palettes a fence can be told to draw with, in the order the menu offers them. */
export const MINDMAP_THEME_PICKS: MindmapThemePick[] = ['auto', 'light', 'dark'];

/**
 * What the menu offers: the three named palettes, plus the custom entry only when the
 * fence already carries a theme object — choosing it means "keep that object", so for
 * every other body there is nothing it could do.
 */
export function mindmapThemeMenuPicks(choice: MindmapThemeChoice): MindmapThemePick[] {
    return choice.kind === 'custom' ? [...MINDMAP_THEME_PICKS, 'custom'] : [...MINDMAP_THEME_PICKS];
}

const THEME_LABELS = {
    auto: 'preview.mindmap_theme_auto',
    light: 'preview.mindmap_theme_light',
    dark: 'preview.mindmap_theme_dark',
    custom: 'preview.mindmap_theme_custom',
} as const;

/** The name a palette goes by in the control and in the menu; a pick names itself. */
export function mindmapThemeLabel(choice: MindmapThemeChoice | MindmapThemePick): string {
    const name: keyof typeof THEME_LABELS = typeof choice === 'string'
        ? choice
        : choice.kind === 'app' ? 'auto' : choice.kind;
    return t(THEME_LABELS[name]);
}

/**
 * Shows what the map draws with, on the control itself: the palette's own name as the
 * button's text, and the full statement as its accessible name. A body that carries a
 * theme object of its own reads as "custom" here — picking another palette is what
 * replaces that object, and there is nowhere else to write one.
 */
export function showMindmapThemeChoice(node: HTMLElement, choice: MindmapThemeChoice, open = false): void {
    const button = mindmapThemeButton(node);
    if (!button)
        return;
    const label = mindmapThemeLabel(choice);
    button.textContent = label;
    button.setAttribute('aria-label', `${t('preview.mindmap_theme')}: ${label}`);
    if (choice.kind === 'custom')
        button.title = t('preview.mindmap_theme_custom_hint');
    else
        button.removeAttribute('title');
    button.setAttribute('aria-expanded', String(open));
}

export function markMindmapThemeMenuOpen(node: HTMLElement, open: boolean): void {
    mindmapThemeButton(node)?.setAttribute('aria-expanded', String(open));
}

export function markMindmapLoading(node: HTMLElement): void {
    node.classList.add('loading');
    node.classList.remove('is-ready', 'has-error', 'mindmap-source');
    node.setAttribute('aria-busy', 'true');
}

export function markMindmapReady(node: HTMLElement): void {
    node.classList.remove('loading', 'has-error', 'mindmap-source');
    node.classList.add('is-ready');
    node.setAttribute('aria-busy', 'false');
}

/** Fallback used wherever a live map cannot run: show the source, drop the inert controls. */
export function showMindmapSource(node: HTMLElement): void {
    removeHeadControls(node);
    node.classList.remove('loading', 'has-error', 'is-ready');
    node.classList.add('mindmap-source');
    node.setAttribute('aria-busy', 'false');
    const placeholder = mindmapPlaceholder(node) ?? node;
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = mindmapBody(node);
    pre.append(code);
    placeholder.replaceChildren(pre);
}

export function showMindmapSourceAll(root: ParentNode): void {
    mindmapBlocks(root).forEach(showMindmapSource);
}

export function showMindmapError(node: HTMLElement, detail: string): void {
    removeHeadControls(node);
    node.classList.remove('loading', 'is-ready');
    node.classList.add('has-error');
    node.setAttribute('aria-busy', 'false');
    const placeholder = mindmapPlaceholder(node) ?? node;
    const wrap = document.createElement('div');
    wrap.className = 'mindmap-error';
    const message = document.createElement('span');
    message.className = 'mindmap-error-message';
    message.textContent = `${t('preview.mindmap_render_failed')}: ${detail.slice(0, 500)}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'mindmap-retry';
    retry.dataset.mindmapRetry = '1';
    retry.textContent = t('common.retry');
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = mindmapBody(node);
    pre.append(code);
    wrap.append(message, retry, pre);
    placeholder.replaceChildren(wrap);
}

export function resetMindmapNode(node: HTMLElement): void {
    const placeholder = mindmapPlaceholder(node) ?? node;
    markMindmapLoading(node);
    placeholder.replaceChildren();
    const label = document.createElement('div');
    label.className = 'mindmap-block-status';
    label.textContent = t('preview.mindmap_loading');
    placeholder.append(label);
}
