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
    const rawElements = Array.isArray(data.elements) ? data.elements : [];
    const elements = rawElements.filter((el: any) => el && !el.isDeleted);
    const referencedFiles = new Set<string>();
    for (const el of elements) {
        if (el && el.type === 'image' && typeof el.fileId === 'string' && el.fileId) {
            referencedFiles.add(el.fileId);
        }
    }
    const cleanFiles: Record<string, any> = {};
    if (data.files && typeof data.files === 'object') {
        for (const [key, val] of Object.entries(data.files)) {
            if (referencedFiles.has(key)) {
                cleanFiles[key] = val;
            }
        }
    }
    const cleanData: ExcalidrawSceneData = {
        type: 'excalidraw',
        version: 2,
        source: 'https://excalidraw.com',
        elements,
        appState: {
            viewBackgroundColor: data.appState?.viewBackgroundColor ?? '#ffffff',
            gridSize: data.appState?.gridSize ?? null,
        },
        files: cleanFiles,
    };
    return JSON.stringify(cleanData);
}

export interface ExcalidrawFenceMatch {
    matchStart: number;
    matchEnd: number;
    fenceOpen: string;
    body: string;
    bodyStart: number;
    bodyEnd: number;
    index: number;
    line?: number;
}

export function findExcalidrawFences(content: string): ExcalidrawFenceMatch[] {
    const normalized = normalizeEol(content);
    const lines = normalized.split('\n');
    const matches: ExcalidrawFenceMatch[] = [];
    let charPos = 0;
    const lineStarts: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        lineStarts.push(charPos);
        charPos += lines[i].length + (i < lines.length - 1 ? 1 : 0);
    }

    let index = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const openMatch = /^( {0,3})(`{3,}|~{3,})[ \t]*excalidraw(?:[ \t\r\n][^\n]*)?$/.exec(line);
        if (!openMatch) continue;
        const marker = openMatch[2][0];
        const minLen = openMatch[2].length;

        let closing = -1;
        for (let j = i + 1; j < lines.length; j++) {
            const closeMatch = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
            if (closeMatch && closeMatch[2][0] === marker && closeMatch[2].length >= minLen) {
                closing = j;
                break;
            }
        }

        const endLine = closing !== -1 ? closing : lines.length - 1;
        const matchStart = lineStarts[i];
        const matchEnd = lineStarts[endLine] + lines[endLine].length;

        const bodyLines = lines.slice(i + 1, closing !== -1 ? closing : lines.length);
        const body = bodyLines.join('\n');
        const bodyStart = lineStarts[i] + line.length + (i + 1 < lines.length ? 1 : 0);
        const bodyEnd = closing !== -1 ? (lineStarts[closing] > 0 && normalized[lineStarts[closing] - 1] === '\n' && bodyLines.length > 0 ? lineStarts[closing] - 1 : lineStarts[closing]) : charPos;

        matches.push({
            matchStart,
            matchEnd,
            fenceOpen: openMatch[2],
            body,
            bodyStart,
            bodyEnd,
            index: index++,
            line: i,
        });

        if (closing !== -1) {
            i = closing;
        }
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
    const target = (ref.line !== undefined ? fences.find((f) => f.line === ref.line) : null) ?? fences.find((f) => f.index === ref.index);
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
    const sep = target.body.length === 0 ? '\n' : '';
    return before + formattedNext + sep + after;
}
