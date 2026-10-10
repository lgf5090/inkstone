import type { ExcalidrawFenceRef, ExcalidrawSceneData } from './types';

export const EXCALIDRAW_LANGUAGES = ['excalidraw'] as const;

export function normalizeEol(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

export function createDefaultExcalidrawScene(): ExcalidrawSceneData {
    return {
        type: 'excalidraw',
        version: 2,
        source: 'https://excalidraw.com',
        elements: [],
        appState: {
            viewBackgroundColor: '#ffffff',
            gridSize: null,
        },
        files: {},
    };
}

export function parseExcalidrawBody(body: string): { ok: boolean; data: ExcalidrawSceneData; error?: string } {
    const trimmed = normalizeEol(body).trim();
    if (!trimmed) {
        return { ok: true, data: createDefaultExcalidrawScene() };
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) {
            return { ok: false, data: createDefaultExcalidrawScene(), error: 'Excalidraw data must be an object' };
        }
        const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
        const appState = typeof parsed.appState === 'object' && parsed.appState !== null ? parsed.appState : {};
        const files = typeof parsed.files === 'object' && parsed.files !== null ? parsed.files : {};
        return {
            ok: true,
            data: {
                type: 'excalidraw',
                version: parsed.version ?? 2,
                source: parsed.source ?? 'https://excalidraw.com',
                elements,
                appState,
                files,
            },
        };
    } catch (err: unknown) {
        return {
            ok: false,
            data: createDefaultExcalidrawScene(),
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

export function serializeExcalidrawBody(data: ExcalidrawSceneData): string {
    const cleanData: ExcalidrawSceneData = {
        type: 'excalidraw',
        version: 2,
        source: 'https://excalidraw.com',
        elements: data.elements || [],
        appState: {
            viewBackgroundColor: data.appState?.viewBackgroundColor ?? '#ffffff',
            gridSize: data.appState?.gridSize ?? null,
        },
        files: data.files || {},
    };
    return JSON.stringify(cleanData, null, 2);
}

const FENCE_PATTERN = /(?:^|\n)(```+)[ \t]*excalidraw[^\n]*\n([\s\S]*?)\n\1(?=\n|$)/g;

export interface ExcalidrawFenceMatch {
    matchStart: number;
    matchEnd: number;
    fenceOpen: string;
    body: string;
    bodyStart: number;
    bodyEnd: number;
    index: number;
}

export function findExcalidrawFences(content: string): ExcalidrawFenceMatch[] {
    const matches: ExcalidrawFenceMatch[] = [];
    const normalized = normalizeEol(content);
    let match: RegExpExecArray | null;
    let index = 0;
    FENCE_PATTERN.lastIndex = 0;
    while ((match = FENCE_PATTERN.exec(normalized)) !== null) {
        const fullMatch = match[0];
        const matchStart = match.index + (fullMatch.startsWith('\n') ? 1 : 0);
        const matchEnd = match.index + fullMatch.length;
        const fenceOpen = match[1];
        const body = match[2];
        const bodyStart = match.index + fullMatch.indexOf(body);
        const bodyEnd = bodyStart + body.length;
        matches.push({
            matchStart,
            matchEnd,
            fenceOpen,
            body,
            bodyStart,
            bodyEnd,
            index: index++,
        });
    }
    return matches;
}

export function findExcalidrawFence(content: string, index: number): ExcalidrawFenceRef | null {
    const fences = findExcalidrawFences(content);
    const target = fences.find((f) => f.index === index);
    if (!target) return null;
    return {
        index,
        rawBody: target.body,
    };
}

export function applyBodyAtFence(content: string, ref: ExcalidrawFenceRef, nextBody: string): string | null {
    const fences = findExcalidrawFences(content);
    const target = fences.find((f) => f.index === ref.index);
    if (!target) return null;

    const currentTrimmed = target.body.trim();
    const refTrimmed = ref.rawBody.trim();
    if (currentTrimmed !== refTrimmed && currentTrimmed.length > 0 && refTrimmed.length > 0) {
        return null;
    }

    const normalized = normalizeEol(content);
    const formattedNext = nextBody.trim();
    const before = normalized.slice(0, target.bodyStart);
    const after = normalized.slice(target.bodyEnd);
    return before + formattedNext + after;
}
