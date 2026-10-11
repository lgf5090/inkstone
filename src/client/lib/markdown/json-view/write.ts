/**
 * Turning the preview's document model back into note text.
 *
 * The rule the whole module hangs on: an entry whose subtree nobody edited is written back as the slice
 * it was parsed from, and only the entries on the path to an edit are rebuilt. That is what makes
 * "rename one key in a 400-line config" a change of one line rather than a reflow of the file — and it
 * is the property the ported reference lacked, where every save re-serialized the tree through
 * `JSON.stringify` and quietly rewrote `1.0`, `1e10` and any integer past the safe range.
 */
import type { JsonDocument, JsonNode } from './types';
import { defineMember, isFresh } from './types';
import { parseJsonDocument } from './parse';

/** A rebuilt entry's `key: value` separator. */
const KEY_SEPARATOR = ': ';

export function encodeKey(key: string): string {
    return JSON.stringify(key);
}

/** A scalar as JSON text, preferring what the author wrote over what the engine would print. */
function encodeScalar(node: JsonNode): string {
    switch (node.kind) {
        case 'string':
            return JSON.stringify(node.value ?? '');
        case 'number':
            return node.literal ?? String(node.value ?? 0);
        case 'boolean':
            return node.value === true ? 'true' : 'false';
        default:
            return 'null';
    }
}

function emitEntry(node: JsonNode, document: JsonDocument, depth: number): string {
    if (isFresh(node) && node.raw !== null)
        return node.raw;
    const value = emitValue(node, document, depth);
    return node.key === null ? value : `${encodeKey(node.key ?? '')}${KEY_SEPARATOR}${value}`;
}

function emitValue(node: JsonNode, document: JsonDocument, depth: number): string {
    const children = node.children;
    if (children === null)
        return node.stale || node.valueRaw === null ? encodeScalar(node) : node.valueRaw;
    const open = node.kind === 'object' ? '{' : '[';
    const close = node.kind === 'object' ? '}' : ']';
    if (children.length === 0)
        return `${open}${node.tail ?? ''}${close}`;
    const pad = document.indent.repeat(depth + 1);
    let out = open;
    children.forEach((child, index) => {
        out += index > 0 ? ',' : '';
        out += child.lead ?? `\n${pad}`;
        out += emitEntry(child, document, depth + 1);
        out += child.trail;
    });
    out += node.tail ?? `\n${document.indent.repeat(depth)}`;
    return `${out}${close}`;
}

/**
 * The body as it should land in the note.
 *
 * The root's own leading trivia and whatever came after its closing bracket are part of the fence body
 * the reader saw, so both travel back out: a comment above the first brace stays above it, and the
 * newline markdown-it left at the end of the body does not turn into a missing line.
 */
export function writeJsonDocument(document: JsonDocument): string {
    const root = document.root;
    const lead = root.lead ?? '';
    if (isFresh(root) && root.raw !== null)
        return `${lead}${root.raw}${document.trailer}`;
    return `${lead}${emitValue(root, document, 0)}${document.trailer}`;
}

/**
 * The whole tree re-emitted with one indent, ignoring every stored slice.
 *
 * This is the one operation that *means* to touch every line, so it drops the verbatim text on purpose —
 * and with it the comments, which is why the toolbar asks before running it.
 */
export function reindentJsonDocument(document: JsonDocument, indent: string): string {
    const next: JsonDocument = { ...document, indent };
    const walk = (node: JsonNode): void => {
        node.stale = true;
        node.raw = null;
        node.lead = null;
        node.trail = '';
        node.tail = null;
        node.children?.forEach(walk);
    };
    walk(next.root);
    return `${emitValue(next.root, next, 0)}${document.trailer}`;
}

/**
 * A brand-new node from a parsed value, with no source behind it.
 *
 * `raw` stays null so the writer rebuilds it: a node built from a JS value has no claim on how the
 * author formatted anything, and inventing a slice would let it be emitted verbatim forever.
 */
export function nodeFromValue(value: unknown, key: string | null = null): JsonNode {
    const kind = kindOfValue(value);
    const base: JsonNode = {
        kind,
        key,
        value: kind === 'string' || kind === 'number' || kind === 'boolean' ? value as string | number | boolean : null,
        literal: kind === 'number' ? String(value) : kind === 'boolean' ? String(value) : null,
        children: null,
        raw: null,
        valueRaw: null,
        lead: null,
        trail: '',
        tail: null,
        stale: true,
        collapsed: false,
    };
    if (kind === 'object' || kind === 'array') {
        base.value = null;
        base.literal = null;
        base.children = kind === 'object'
            ? Object.keys(value as Record<string, unknown>).map(name => nodeFromValue((value as Record<string, unknown>)[name], name))
            : (value as unknown[]).map(item => nodeFromValue(item, null));
    }
    return base;
}

function kindOfValue(value: unknown): JsonNode['kind'] {
    if (value === null || value === undefined)
        return 'null';
    if (Array.isArray(value))
        return 'array';
    if (typeof value === 'object')
        return 'object';
    if (typeof value === 'number' && Number.isFinite(value))
        return 'number';
    if (typeof value === 'boolean')
        return 'boolean';
    return 'string';
}

/**
 * What a typed value means.
 *
 * The reference resolved this with a chain of string tests that treated `1️23` as a number and turned a
 * failed `{`-prefixed parse into a string. Here the same scanner that reads the note decides, so a pasted
 * object arrives with its own formatting and `1.0` stays `1.0` instead of being rounded to `1` on the way
 * through `Number`.
 */
export function nodeFromInput(text: string, key: string | null): JsonNode {
    const trimmed = text.trim();
    const first = trimmed[0];
    const scalar = { allowScalar: true };
    if (first === '{' || first === '[') {
        const parsed = parseJsonDocument(trimmed);
        if (parsed.ok && parsed.document) {
            const built = parsed.document.root;
            built.key = key;
            built.lead = null;
            return built;
        }
        return stringNode(text, key);
    }
    if (trimmed === 'true' || trimmed === 'false') {
        const node = nodeFromValue(trimmed === 'true', key);
        node.raw = trimmed;
        node.valueRaw = trimmed;
        node.stale = false;
        return node;
    }
    if (trimmed === 'null') {
        const node = nodeFromValue(null, key);
        node.raw = 'null';
        node.valueRaw = 'null';
        node.stale = false;
        return node;
    }
    if (first === '"') {
        const parsed = parseJsonDocument(trimmed, scalar);
        if (parsed.ok && parsed.document?.root.kind === 'string') {
            const node = parsed.document.root;
            node.key = key;
            node.lead = null;
            return node;
        }
        return stringNode(text, key);
    }
    if (/^[+-]?[\d.]/.test(trimmed)) {
        const parsed = parseJsonDocument(trimmed, scalar);
        if (parsed.ok && parsed.document?.root.kind === 'number') {
            const node = parsed.document.root;
            node.key = key;
            node.lead = null;
            return node;
        }
    }
    return stringNode(text, key);
}

function stringNode(text: string, key: string | null): JsonNode {
    const node = nodeFromValue(text, key);
    node.raw = JSON.stringify(text);
    node.valueRaw = node.raw;
    return node;
}

/**
 * The JS value behind a node, for the actions that hand a subtree to another surface.
 *
 * `defineMember` rather than assignment: a note may hold a `__proto__` key, and `obj[key] = …` on that
 * name retypes the object instead of adding a member.
 */
export function valueOfNode(node: JsonNode): unknown {
    if (node.kind === 'object') {
        const out: Record<string, unknown> = {};
        for (const child of node.children ?? [])
            defineMember(out, child.key ?? '', valueOfNode(child));
        return out;
    }
    if (node.kind === 'array')
        return (node.children ?? []).map(valueOfNode);
    if (node.kind === 'null')
        return null;
    if (node.kind === 'boolean')
        return node.value === true;
    if (node.kind === 'number')
        return typeof node.value === 'number' && Number.isFinite(node.value) ? node.value : 0;
    return node.value ?? '';
}

/** The source text of one subtree, verbatim where nothing under it was edited. */
export function writeJsonNode(document: JsonDocument, node: JsonNode): string {
    return emitEntry(node, document, 0);
}
