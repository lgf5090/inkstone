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

/**
 * A scene arrives from note text, which is the one input in this app that is never authored by the
 * person reading it: an imported vault, a pasted board, a shared note. Every limit below exists
 * because the renderer turns each element into roughjs work on the main thread and each file into a
 * dataURL that travels back out through the note body, so an unbounded scene is a denial of service
 * against the browser tab. An "embeddable" element is worse still: it is an iframe whose src the
 * note chose.
 */
export const EXCALIDRAW_BODY_LIMIT_BYTES = 1_800_000;
export const EXCALIDRAW_MAX_ELEMENTS = 8_000;
export const EXCALIDRAW_MAX_POINTS_PER_ELEMENT = 20_000;
export const EXCALIDRAW_MAX_FILES = 60;
export const EXCALIDRAW_MAX_FILE_BYTES = 1_500_000;
export const EXCALIDRAW_MAX_TOTAL_FILE_BYTES = 1_500_000;

export const EXCALIDRAW_ALLOWED_MIME = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
]);

/**
 * A stencil library is imported whole - one file, dozens of items - and every item it holds is drawn
 * later by the library tree through `exportToSvg`. The library is therefore capped a little tighter
 * than a single note: a board has to be readable, while a stencil set only has to be usable.
 */
export const EXCALIDRAW_MAX_LIBRARY_ITEMS = 500;
export const EXCALIDRAW_MAX_LIBRARY_BYTES = 1_400_000;

const ALLOWED_LINK_PREFIXES = ['http://', 'https://', 'mailto:'];

function isAllowedLink(link: unknown): boolean {
    if (typeof link !== 'string' || !link.trim()) return false;
    const lowered = link.trim().toLowerCase();
    if (lowered.startsWith('[[')) return true;
    return ALLOWED_LINK_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

export function sanitizeElements(input: unknown): { elements: any[]; dropped: number; error?: string } {
    if (!Array.isArray(input)) return { elements: [], dropped: 0 };
    if (input.length > EXCALIDRAW_MAX_ELEMENTS) {
        return {
            elements: [],
            dropped: input.length,
            error: 'Drawing has ' + input.length + ' elements, over the ' + EXCALIDRAW_MAX_ELEMENTS + ' limit',
        };
    }
    const kept: any[] = [];
    let dropped = 0;
    for (const raw of input) {
        if (!raw || typeof raw !== 'object') {
            dropped += 1;
            continue;
        }
        const element = raw as Record<string, unknown>;
        if (element.type === 'embeddable') {
            dropped += 1;
            continue;
        }
        if ('link' in element && !isAllowedLink(element.link)) {
            element.link = null;
        }
        if (Array.isArray(element.points) && element.points.length > EXCALIDRAW_MAX_POINTS_PER_ELEMENT) {
            dropped += 1;
            continue;
        }
        kept.push(element);
    }
    return { elements: kept, dropped };
}

function sanitizeFiles(input: unknown): { files: Record<string, any>; dropped: number; error?: string } {
    if (!input || typeof input !== 'object') return { files: {}, dropped: 0 };
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > EXCALIDRAW_MAX_FILES) {
        return {
            files: {},
            dropped: entries.length,
            error: 'Drawing carries ' + entries.length + ' files, over the ' + EXCALIDRAW_MAX_FILES + ' limit',
        };
    }
    const files: Record<string, any> = {};
    let total = 0;
    let dropped = 0;
    for (const [id, value] of entries) {
        const file = value as Record<string, unknown> | null;
        const dataURL = file && typeof file.dataURL === 'string' ? file.dataURL : '';
        const mime = file && typeof file.mimeType === 'string' ? file.mimeType : '';
        if (!dataURL || !EXCALIDRAW_ALLOWED_MIME.has(mime)) {
            dropped += 1;
            continue;
        }
        if (dataURL.length > EXCALIDRAW_MAX_FILE_BYTES || total + dataURL.length > EXCALIDRAW_MAX_TOTAL_FILE_BYTES) {
            dropped += 1;
            continue;
        }
        total += dataURL.length;
        files[id] = file;
    }
    return { files, dropped };
}

export function parseExcalidrawBody(body: string): { ok: boolean; data: ExcalidrawSceneData; error?: string; dropped?: number } {
    const trimmed = normalizeEol(body).trim();
    if (!trimmed) {
        return { ok: true, data: createDefaultExcalidrawScene() };
    }
    if (trimmed.length > EXCALIDRAW_BODY_LIMIT_BYTES) {
        return {
            ok: false,
            data: createDefaultExcalidrawScene(),
            error: 'Drawing is ' + trimmed.length + ' characters, over the ' + EXCALIDRAW_BODY_LIMIT_BYTES + ' limit',
        };
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) {
            return { ok: false, data: createDefaultExcalidrawScene(), error: 'Excalidraw data must be an object' };
        }
        const elements = sanitizeElements(parsed.elements);
        if (elements.error) {
            return { ok: false, data: createDefaultExcalidrawScene(), error: elements.error };
        }
        const files = sanitizeFiles(parsed.files);
        if (files.error) {
            return { ok: false, data: createDefaultExcalidrawScene(), error: files.error };
        }
        const appState = typeof parsed.appState === 'object' && parsed.appState !== null ? parsed.appState : {};
        return {
            ok: true,
            data: {
                type: 'excalidraw',
                version: parsed.version ?? 2,
                source: parsed.source ?? 'https://excalidraw.com',
                elements: elements.elements,
                appState,
                files: files.files,
            },
            dropped: elements.dropped + files.dropped,
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
        version: data.version ?? 2,
        source: data.source ?? 'https://excalidraw.com',
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
