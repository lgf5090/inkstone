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

export async function loadExcalidrawLib(): Promise<ExcalidrawLib> {
    if ((window as any).ExcalidrawLib) {
        return (window as any).ExcalidrawLib as ExcalidrawLib;
    }
    if (libPromise) {
        return libPromise;
    }

    libPromise = (async () => {
        (window as any).React = React;
        (window as any).ReactDOM = ReactDOM;
        (window as any).ReactJSXRuntime = ReactJSXRuntime;
        if (typeof globalThis !== 'undefined') {
            (globalThis as any).React = React;
            (globalThis as any).ReactDOM = ReactDOM;
            (globalThis as any).ReactJSXRuntime = ReactJSXRuntime;
        }

        loadStylesheet('/vendor/excalidraw/excalidraw.production.min.css');
        await loadScript('/vendor/excalidraw/excalidraw.production.min.js');

        if (!(window as any).ExcalidrawLib) {
            throw new Error('ExcalidrawLib was not defined after loading excalidraw.production.min.js');
        }

        return (window as any).ExcalidrawLib as ExcalidrawLib;
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
