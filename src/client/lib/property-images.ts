import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import type { PropertyImageSource } from '@shared/property-decorations';

const MAX_CACHE_ENTRIES = 160;

const urls = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function readVersion(): number {
    return version;
}

function remember(name: string, value: string | null): void {
    if (urls.size >= MAX_CACHE_ENTRIES)
        urls.clear();
    urls.set(name, value);
}

function load(name: string): Promise<string | null> {
    const running = pending.get(name);
    if (running)
        return running;
    const request = api.files.byName(name).then((result) => {
        const image = result.files.find(file => file.mime.startsWith('image/')) ?? result.files[0];
        return image ? image.url : null;
    }, () => null);
    pending.set(name, request);
    void request.then((value) => {
        if (pending.get(name) === request)
            pending.delete(name);
        remember(name, value);
    });
    return request;
}

export function forgetPropertyImages(name?: string): void {
    if (name === undefined)
        urls.clear();
    else
        urls.delete(name);
    version += 1;
    for (const listener of listeners)
        listener();
}

export function cachedPropertyImage(name: string): string | null | undefined {
    return urls.get(name);
}

export function usePropertyImage(source: PropertyImageSource | null | undefined): string | null {
    const stamp = useSyncExternalStore(subscribe, readVersion, readVersion);
    const direct = source?.kind === 'url' ? source.url : null;
    const name = source?.kind === 'attachment' ? source.name : null;
    const [resolved, setResolved] = useState<string | null>(null);
    useEffect(() => {
        if (direct)
            return;
        if (!name) {
            setResolved(null);
            return;
        }
        const cached = urls.get(name);
        if (cached !== undefined) {
            setResolved(cached);
            return;
        }
        let alive = true;
        setResolved(null);
        void load(name).then((value) => {
            if (alive)
                setResolved(value);
        });
        return () => {
            alive = false;
        };
    }, [name, direct, stamp]);
    return direct ?? resolved;
}
