import { t } from '../../i18n';
import { decodeDataValue } from '../data-attr';
import type { ExcalidrawFenceRef } from './types';

export const EXCALIDRAW_BLOCK_SELECTOR = '[data-excalidraw]';
export const EXCALIDRAW_PLACEHOLDER_SELECTOR = '[data-excalidraw-placeholder]';
export const EXCALIDRAW_CANVAS_CLASS = 'excalidraw-canvas-container';

const SVG_NS = 'http://www.w3.org/2000/svg';

const CONTROL_ICONS: Record<string, string[]> = {
    'data-excalidraw-source': ['m18 16 4-4-4-4', 'm6 8-4 4 4 4', 'm14.5 4-5 16'],
    'data-excalidraw-fit': ['m15 15 6 6', 'm15 9 6-6', 'M21 16v5h-5', 'M21 8V3h-5', 'M3 16v5h5', 'm3 21 6-6', 'M3 8V3h5', 'M9 9 3 3'],
    'data-excalidraw-fullscreen': ['M15 3h6v6', 'm21 3-7 7', 'm3 21 7-7', 'M9 21H3v-6'],
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

export function decorateExcalidrawControls(node: HTMLElement): void {
    for (const [attribute, paths] of Object.entries(CONTROL_ICONS)) {
        const button = node.querySelector<HTMLElement>(`[${attribute}]`);
        if (button && !button.querySelector('svg')) {
            button.append(iconSvg(paths));
        }
    }
}

export function excalidrawBlocks(root: ParentNode): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(EXCALIDRAW_BLOCK_SELECTOR)];
}

export function excalidrawBody(node: HTMLElement): string {
    const raw = node.getAttribute('data-excalidraw');
    return raw ? decodeDataValue(raw) : '';
}

export function excalidrawIndex(node: HTMLElement): number {
    const raw = node.getAttribute('data-excalidraw-index');
    return raw ? Number.parseInt(raw, 10) : 0;
}

export function excalidrawFenceRef(node: HTMLElement): ExcalidrawFenceRef {
    const rawLine = node.getAttribute('data-line');
    const line = rawLine ? Number.parseInt(rawLine, 10) : undefined;
    return {
        index: excalidrawIndex(node),
        line,
        rawBody: excalidrawBody(node),
    };
}

export function createExcalidrawToolbar(_node?: HTMLElement): HTMLElement {
    const header = document.createElement('div');
    header.className = 'excalidraw-block-head';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'excalidraw-head-title';
    titleWrap.textContent = t('preview.excalidraw_drawing') || 'Excalidraw';

    const actions = document.createElement('div');
    actions.className = 'excalidraw-head-actions';

    const sourceBtn = document.createElement('button');
    sourceBtn.type = 'button';
    sourceBtn.className = 'excalidraw-action-btn';
    sourceBtn.setAttribute('data-excalidraw-source', '1');
    sourceBtn.title = t('preview.excalidraw_show_source') || 'Source code';

    const fitBtn = document.createElement('button');
    fitBtn.type = 'button';
    fitBtn.className = 'excalidraw-action-btn';
    fitBtn.setAttribute('data-excalidraw-fit', '1');
    fitBtn.title = t('preview.excalidraw_fit') || 'Zoom to fit';

    const fullBtn = document.createElement('button');
    fullBtn.type = 'button';
    fullBtn.className = 'excalidraw-action-btn';
    fullBtn.setAttribute('data-excalidraw-fullscreen', '1');
    fullBtn.title = t('preview.excalidraw_fullscreen') || 'Fullscreen';

    actions.append(sourceBtn, fitBtn, fullBtn);
    header.append(titleWrap, actions);
    return header;
}

export function markExcalidrawReady(node: HTMLElement): void {
    node.classList.remove('loading');
    node.removeAttribute('aria-busy');
    const placeholder = node.querySelector(EXCALIDRAW_PLACEHOLDER_SELECTOR);
    placeholder?.remove();
}

export function showExcalidrawError(node: HTMLElement, message: string, onRetry?: () => void): void {
    node.classList.remove('loading');
    node.removeAttribute('aria-busy');
    const placeholder = node.querySelector(EXCALIDRAW_PLACEHOLDER_SELECTOR);
    placeholder?.remove();

    let errorBox = node.querySelector<HTMLElement>('.excalidraw-error');
    if (!errorBox) {
        errorBox = document.createElement('div');
        errorBox.className = 'excalidraw-error';
        node.append(errorBox);
    }
    errorBox.replaceChildren();

    const msgEl = document.createElement('div');
    msgEl.className = 'excalidraw-error-message';
    msgEl.textContent = message;
    errorBox.append(msgEl);

    if (onRetry) {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'excalidraw-retry';
        retryBtn.textContent = t('preview.excalidraw_retry') || 'Retry';
        retryBtn.onclick = onRetry;
        errorBox.append(retryBtn);
    }
}
