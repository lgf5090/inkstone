import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactJSXRuntime from 'react/jsx-runtime';
import type { ExcalidrawLib } from './types';

let libPromise: Promise<ExcalidrawLib> | null = null;

function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
        if (existing) {
            if ((window as any).ExcalidrawLib) {
                resolve();
                return;
            }
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', (e) => reject(e), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = (err) => reject(new Error(`Failed to load script ${src}: ${String(err)}`));
        document.head.appendChild(script);
    });
}

function loadStylesheet(href: string): void {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
}

import { t } from '../../i18n';
import { convertMermaidToExcalidrawElements } from './mermaid';

let activeActionHandler: ((action: string) => void) | null = null;

/**
 * The engine's host protocol has one global `runAction` callback, so only one surface can own it at a
 * time — but the previous shape (pass `null` to unregister) let any surface's cleanup blank out the
 * handler that a *different* surface had installed last, which silently killed "insert LaTeX / note
 * card / link" on every canvas at once with no error anywhere. The returned disposer now only steps
 * aside if it is still the current owner, restoring whoever held it before.
 */
export function registerExcalidrawActionHandler(
    handler: ((action: string) => void) | null,
): () => void {
    if (!handler) return () => { /* nothing registered, nothing to release */ }
    const previous = activeActionHandler
    activeActionHandler = handler
    return () => {
        if (activeActionHandler === handler) activeActionHandler = previous
    }
}

/**
 * The engine only normalises elements it is handed at restore time (`initialData`, its own paste and
 * drop paths). `updateScene` takes whatever it is given, so a caller that builds an element by hand
 * ships one with no `seed`, no fractional `index` and no `versionNonce` — which is enough to make the
 * rough shape re-randomise and the z-order compare against `undefined`.
 */
export function restoreSceneElements(api: any, elements: any[]): any[] {
    const lib: any = typeof window !== 'undefined' ? (window as any).ExcalidrawLib : null;
    if (lib && typeof lib.restoreElements === 'function') {
        const local = typeof api?.getSceneElements === 'function' ? api.getSceneElements() : [];
        return lib.restoreElements(elements, local);
    }
    return elements;
}

export function applySceneElements(api: any, elements: any[]): void {
    api.updateScene({ elements: restoreSceneElements(api, elements) });
}

function getHostLabel(key: string): string {
    switch (key) {
        case 'ABOUT_LIBRARIES':
            return t('excalidraw.label_about_libraries');
        case 'COMP_FRAME':
            return t('excalidraw.frame_tool');
        case 'COMP_FRAME_HINT':
            return t('excalidraw.label_frame_hint');
        case 'COMP_IMG':
            return t('excalidraw.insert_image');
        case 'COMP_IMG_FROM_SYSTEM':
            return t('excalidraw.label_comp_img_from_system');
        case 'COMP_IMG_ANY_FILE':
            return t('excalidraw.label_comp_img_any_file');
        case 'INSERT_CARD':
            return t('excalidraw.label_insert_card');
        case 'COMP_IMG_LaTeX':
            return t('excalidraw.insert_latex');
        default:
            return key;
    }
}

export async function loadExcalidrawLib(): Promise<ExcalidrawLib> {
    if ((window as any).ExcalidrawLib) {
        return (window as any).ExcalidrawLib as ExcalidrawLib;
    }
    if (libPromise) {
        return libPromise;
    }

    libPromise = (async () => {
        (window as any).EXCALIDRAW_ASSET_PATH = '/vendor/excalidraw/';
        (window as any).React = React;
        (window as any).ReactDOM = ReactDOM;
        (window as any).ReactJSXRuntime = ReactJSXRuntime;
        if (typeof globalThis !== 'undefined') {
            (globalThis as any).EXCALIDRAW_ASSET_PATH = '/vendor/excalidraw/';
            (globalThis as any).React = React;
            (globalThis as any).ReactDOM = ReactDOM;
            (globalThis as any).ReactJSXRuntime = ReactJSXRuntime;
        }

        loadStylesheet('/vendor/excalidraw/excalidraw.production.min.css');
        await loadScript('/vendor/excalidraw/excalidraw.production.min.js');

        const lib = (window as any).ExcalidrawLib;
        if (typeof lib.configureObsidianCommonHost === 'function') {
            lib.configureObsidianCommonHost({
                protocolVersion: 1,
                getCanvasLimits: () => ({ areaLimit: 16777216, widthHeightLimit: 32767 }),
                getHighlightColor: () => 'rgba(0,118,255,1)',
                getDeviceInfo: () => null,
                getDesktopUIMode: () => 'full',
                getPreferredUIMode: (formFactor: string) => (formFactor === 'phone' ? 'mobile' : 'full'),
            });
        }
        if (typeof lib.configureObsidianExcalidrawHost === 'function') {
            lib.configureObsidianExcalidrawHost({
                protocolVersion: 2,
                isDoubleTapEraserEnabled: () => false,
                getZoomToFitMaxLevel: () => 2,
                isPenModeCrosshairVisible: () => false,
                isSingleFingerPanningEnabled: () => false,
                isDoubleClickTextEditingDisabled: () => false,
                getZoomStep: () => 0.1,
                getZoomMin: () => 0.1,
                getZoomMax: () => 30,
                isContextMenuDisabled: () => false,
                shouldSyncElementLinkWithText: () => true,
                loadFontFromFile: async () => undefined,
                getMermaid: async () => ({
                    loaded: true,
                    api: Promise.resolve({
                        parseMermaidToExcalidraw: async (definition: string) => {
                            const elements = convertMermaidToExcalidrawElements(definition);
                            return { elements, files: {} };
                        },
                    }),
                }),
                runAction: (action: string) => {
                    activeActionHandler?.(action);
                },
                getLabel: getHostLabel,
                attachInlineLinkSuggester: () => ({ isBlockingKeys: () => false, close: () => {} }),
            });
        }

        return lib as ExcalidrawLib;
    })().catch((err) => {
        libPromise = null;
        throw err;
    });

    return libPromise;
}

export function setExcalidrawLibForTesting(lib: ExcalidrawLib | null): void {
    if (typeof window !== 'undefined') {
        (window as any).ExcalidrawLib = lib;
    }
    libPromise = lib ? Promise.resolve(lib) : null;
}
