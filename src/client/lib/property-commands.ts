export type PropertyDecorationKind = 'cover' | 'banner' | 'icon';

interface DecorationRequest {
    kind: PropertyDecorationKind;
    noteId: string;
    x: number;
    y: number;
}

type Listener = (request: DecorationRequest | null) => void;

let current: DecorationRequest | null = null;
const listeners = new Set<Listener>();

export function requestPropertyDecoration(kind: PropertyDecorationKind, noteId: string, anchor?: { x: number, y: number }): void {
    current = { kind, noteId, x: anchor?.x ?? 160, y: anchor?.y ?? 160 };
    for (const listener of listeners)
        listener(current);
}

export function clearPropertyDecoration(): void {
    current = null;
    for (const listener of listeners)
        listener(null);
}

export function subscribePropertyDecoration(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function peekPropertyDecoration(): DecorationRequest | null {
    return current;
}
