/**
 * The tolerant JSON reader behind the preview.
 *
 * `JSON.parse` is not used, because the preview has to be able to write the body back out and a value
 * tree cannot do that: `JSON.stringify(JSON.parse(text))` turns `1.0` into `1`, `1e10` into
 * `10000000000`, and a twenty-digit integer into different digits — the same argument
 * `lib/markdown/code-formatter/json.ts` makes about re-indenting. So this scanner records, for every
 * entry, the source slice it came from, and `write.ts` emits those slices back for the parts the reader
 * never touched.
 *
 * What it tolerates is what an author actually types into a notebook: `//` and block comments, trailing
 * commas, single-quoted strings, unquoted keys, bare words for values, and `0x`/`.5`/`1.` numbers. The
 * ported reference recovered the same shapes with one regular expression over the whole text, which
 * cannot tell a key from the inside of a string — `{"href":"https://x/a:b"}` lost its value and
 * `{"note":"it's here"}` stopped parsing. Scanning recovers both without looking inside a string.
 */
import type {
    JsonDocument,
    JsonFailure,
    JsonKind,
    JsonNode,
    JsonParseLimits,
    JsonParseOutcome,
    JsonRepair,
} from './types';
import { JSON_VIEW_BODY_LIMIT_BYTES, JSON_VIEW_MAX_DEPTH, JSON_VIEW_MAX_NODES } from './types';

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const SIMPLE_ESCAPES: Record<string, string> = {
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    "'": "'",
};
/** A numeric run, scanned maximal-first so `0x1f` and `1e-5` are judged as whole tokens. */
const NUMBER_RUN = /[0-9a-fA-FxXoO+\-.eE_]+/y;
const NUMBER_START = /[\d+\-.]/;
const STRICT_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const LOOSE_NUMBER = /^[+-]?(?:\d+\.?|\.\d+)(?:[eE][+-]?\d+)?$/;
const HEX_NUMBER = /^0[xX][0-9a-fA-F]+$/;
const OCTAL_NUMBER = /^0[oO][0-7]+$/;
/** A key written without quotes: an identifier, so `a-b` is not mistaken for two tokens. */
const BARE_KEY = /^[A-Za-z_$\u0080-\uFFFF][\w$\u0080-\uFFFF]*/;
const WORD = /^[A-Za-z_$][\w$]*/;

interface Reader {
    source: string
    pos: number
    nodes: number
    depth: number
    repairs: Set<JsonRepair>
    maxDepth: number
    maxNodes: number
    failure: JsonFailure | null
}

function stop(reader: Reader, index: number, reason: string, detail?: string): null {
    if (!reader.failure) {
        const before = reader.source.slice(0, index);
        reader.failure = {
            reason,
            line: before.split('\n').length,
            column: index - (before.lastIndexOf('\n') + 1) + 1,
            detail,
        };
    }
    return null;
}

function done(reader: Reader): boolean {
    return reader.pos >= reader.source.length;
}

function charAt(reader: Reader): string {
    return reader.source[reader.pos] ?? '';
}

/** Steps over whitespace and comments, flagging the latter as a repair. False once it has failed. */
function skipTrivia(reader: Reader): boolean {
    for (;;) {
        const char = charAt(reader);
        if (WHITESPACE.has(char)) {
            reader.pos++;
            continue;
        }
        if (char !== '/')
            return true;
        const next = reader.source[reader.pos + 1];
        if (next === '/') {
            const newline = reader.source.indexOf('\n', reader.pos);
            reader.pos = newline === -1 ? reader.source.length : newline;
            reader.repairs.add('comment');
            continue;
        }
        if (next === '*') {
            const close = reader.source.indexOf('*/', reader.pos + 2);
            if (close === -1) {
                stop(reader, reader.pos, 'preview.json_error_unterminated');
                return false;
            }
            reader.pos = close + 2;
            reader.repairs.add('comment');
            continue;
        }
        return true;
    }
}

/**
 * One quoted token, returning its decoded text and the slice it came from. The single quotes an author
 * reaches for on a phone keyboard are accepted; the source slice is kept so an untouched string is
 * written back with its escapes as they were typed.
 */
function readQuoted(reader: Reader): { text: string, raw: string } | null {
    const quote = charAt(reader);
    const from = reader.pos;
    reader.pos++;
    let text = '';
    while (reader.pos < reader.source.length) {
        const char = reader.source[reader.pos]!;
        if (char === quote) {
            reader.pos++;
            return { text, raw: reader.source.slice(from, reader.pos) };
        }
        if (char === '\n' || char === '\r') {
            stop(reader, reader.pos, 'preview.json_error_unterminated');
            return null;
        }
        if (char !== '\\') {
            text += char;
            reader.pos++;
            continue;
        }
        const escape = reader.source[reader.pos + 1];
        if (escape === 'u' || escape === 'x') {
            const width = escape === 'u' ? 4 : 2;
            const hex = reader.source.slice(reader.pos + 2, reader.pos + 2 + width);
            if (hex.length !== width || !/^[\da-fA-F]+$/.test(hex)) {
                stop(reader, reader.pos, 'preview.json_error_bad_escape');
                return null;
            }
            text += String.fromCharCode(Number.parseInt(hex, 16));
            reader.pos += 2 + width;
            continue;
        }
        if (escape === '\n' || escape === '\r') {
            // A line continuation: the break carries no character into the string.
            reader.pos += escape === '\r' && reader.source[reader.pos + 2] === '\n' ? 3 : 2;
            continue;
        }
        if (escape === undefined || SIMPLE_ESCAPES[escape] === undefined) {
            stop(reader, reader.pos, 'preview.json_error_bad_escape');
            return null;
        }
        text += SIMPLE_ESCAPES[escape];
        reader.pos += 2;
    }
    stop(reader, reader.pos, 'preview.json_error_unterminated');
    return null;
}

/**
 * A number, judged after being scanned whole.
 *
 * The strict grammar is tried first so an ordinary number costs one test. What fails it is then given
 * the shapes an author writes — a leading `+`, a bare `1.`, a `_` separator, an `0x` radix — and each of
 * those is a repair the view badges. A run that is none of those is a failure naming the text, rather
 * than a silent `NaN` reaching the tree.
 */
function readNumber(reader: Reader): { literal: string, value: number } | null {
    const from = reader.pos;
    NUMBER_RUN.lastIndex = from;
    const literal = NUMBER_RUN.exec(reader.source)?.[0] ?? '';
    if (!literal) {
        stop(reader, from, 'preview.json_error_unexpected');
        return null;
    }
    reader.pos = from + literal.length;
    if (!STRICT_NUMBER.test(literal)) {
        const radix = HEX_NUMBER.test(literal) ? 16 : OCTAL_NUMBER.test(literal) ? 8 : 0;
        const cleaned = literal.replaceAll('_', '');
        if (!radix && !LOOSE_NUMBER.test(cleaned)) {
            stop(reader, from, 'preview.json_error_unexpected', literal);
            return null;
        }
        reader.repairs.add('loose-number');
        const value = radix ? Number.parseInt(cleaned.slice(2), radix) : Number(cleaned);
        if (!Number.isFinite(value)) {
            stop(reader, from, 'preview.json_error_too_precise', literal);
            return null;
        }
        return { literal, value };
    }
    const value = Number(literal);
    if (!Number.isFinite(value)) {
        stop(reader, from, 'preview.json_error_too_precise', literal);
        return null;
    }
    return { literal, value };
}

function leaf(
    kind: JsonKind,
    key: string | null,
    value: string | number | boolean | null,
    literal: string | null,
    raw: string,
    valueRaw: string,
    lead: string,
): JsonNode {
    return {
        kind,
        key,
        value,
        literal,
        children: null,
        raw,
        valueRaw,
        lead,
        trail: '',
        tail: '',
        stale: false,
        collapsed: false,
    };
}

/**
 * One value, at any position.
 *
 * `from` is where the *entry* begins, which for an object member is its key rather than its value: the
 * slice the writer emits back has to carry the key, or renaming a neighbour would drop it. `lead` is the
 * trivia in front of that, where an author's comment about the line lives.
 */
function readEntry(reader: Reader, key: string | null, lead: string, from: number): JsonNode | null {
    if (reader.nodes >= reader.maxNodes)
        return stop(reader, reader.pos, 'preview.json_error_too_many');
    if (reader.depth >= reader.maxDepth)
        return stop(reader, reader.pos, 'preview.json_error_too_deep');
    reader.nodes++;
    const char = charAt(reader);
    if (char === '{' || char === '[')
        return readContainer(reader, key, lead, char, from);
    const valueFrom = reader.pos;
    if (char === '"' || char === '\'') {
        if (char === '\'')
            reader.repairs.add('single-quote');
        const text = readQuoted(reader);
        if (!text)
            return null;
        return leaf('string', key, text.text, null, reader.source.slice(from, reader.pos), text.raw, lead);
    }
    const word = WORD.exec(reader.source.slice(valueFrom))?.[0] ?? '';
    if (word === 'true' || word === 'false') {
        reader.pos += word.length;
        return leaf('boolean', key, word === 'true', word, reader.source.slice(from, reader.pos), word, lead);
    }
    if (word === 'null') {
        reader.pos += 4;
        return leaf('null', key, null, 'null', reader.source.slice(from, reader.pos), 'null', lead);
    }
    if (NUMBER_START.test(char)) {
        const number = readNumber(reader);
        if (!number)
            return null;
        return leaf('number', key, number.value, number.literal, reader.source.slice(from, reader.pos), number.literal, lead);
    }
    if (word) {
        // A bare word where a value belongs is the one recovery the reference's regex got right, so it
        // is kept — as a string, and only where a string could legally stand.
        reader.pos += word.length;
        reader.repairs.add('bare-value');
        return leaf('string', key, word, null, reader.source.slice(from, reader.pos), JSON.stringify(word), lead);
    }
    // The position the reader reports is the character it could not use, not the start of the entry: a
    // row that fails on its value should scroll to the value, and a caret on the key would point at the
    // one part of the line that was read correctly.
    return stop(reader, reader.pos, char ? 'preview.json_error_unexpected' : 'preview.json_error_truncated', char || undefined);
}

function readKey(reader: Reader): string | null {
    const char = charAt(reader);
    if (char === '"' || char === '\'') {
        if (char === '\'')
            reader.repairs.add('single-quote');
        const text = readQuoted(reader);
        return text ? text.text : null;
    }
    const word = BARE_KEY.exec(reader.source.slice(reader.pos))?.[0] ?? '';
    if (!word) {
        stop(reader, reader.pos, char ? 'preview.json_error_bad_key' : 'preview.json_error_truncated', char || undefined);
        return null;
    }
    reader.pos += word.length;
    reader.repairs.add('unquoted-key');
    return word;
}

function containerNode(
    kind: JsonKind,
    key: string | null,
    lead: string,
    children: JsonNode[],
    raw: string,
    tail: string,
): JsonNode {
    return {
        kind,
        key,
        value: null,
        literal: null,
        children,
        raw,
        valueRaw: null,
        lead,
        trail: '',
        tail,
        stale: false,
        collapsed: false,
    };
}

/**
 * An object or an array.
 *
 * The separators are deliberately not stored anywhere: `write.ts` generates them, which is what lets a
 * member be added or removed without a stray comma and without the trailing-comma shape a tolerant read
 * accepted coming back out as invalid JSON.
 *
 * What is stored is the trivia, split at the first line break after each value. Everything up to that
 * break belongs to the entry it follows — that is where a `// note about this line` sits — and everything
 * after it belongs to the entry below. Splitting it here rather than at write time is what lets a move
 * carry a comment with the row it annotates instead of leaving it stranded on the line above.
 */
function readContainer(reader: Reader, key: string | null, lead: string, opener: string, from: number): JsonNode | null {
    const closer = opener === '{' ? '}' : ']';
    const kind: JsonKind = opener === '{' ? 'object' : 'array';
    reader.pos++;
    reader.depth++;
    const children: JsonNode[] = [];
    let nextLead = '';
    let afterComma = false;
    const close = (tail: string): JsonNode => {
        reader.pos++;
        reader.depth--;
        return containerNode(kind, key, lead, children, reader.source.slice(from, reader.pos), tail);
    };
    for (;;) {
        const triviaFrom = reader.pos;
        if (!skipTrivia(reader))
            return null;
        if (charAt(reader) === closer) {
            if (children.length > 0 && afterComma)
                reader.repairs.add('trailing-comma');
            return close(`${nextLead}${reader.source.slice(triviaFrom, reader.pos)}`);
        }
        const entryLead = children.length === 0 ? reader.source.slice(triviaFrom, reader.pos) : nextLead;
        const entryFrom = reader.pos;
        let child: JsonNode | null;
        if (kind === 'array') {
            child = readEntry(reader, null, entryLead, entryFrom);
        }
        else {
            const found = readKey(reader);
            if (found === null)
                return null;
            if (!skipTrivia(reader))
                return null;
            if (charAt(reader) !== ':')
                return stop(reader, reader.pos, 'preview.json_error_no_colon', charAt(reader) || undefined);
            reader.pos++;
            if (!skipTrivia(reader))
                return null;
            child = readEntry(reader, found, entryLead, entryFrom);
        }
        if (!child)
            return null;
        children.push(child);
        afterComma = false;
        nextLead = '';
        const valueEnd = reader.pos;
        if (!skipTrivia(reader))
            return null;
        if (done(reader))
            return stop(reader, valueEnd, 'preview.json_error_truncated');
        const before = reader.source.slice(valueEnd, reader.pos);
        const next = charAt(reader);
        if (next === closer) {
            const split = before.indexOf('\n');
            if (split === -1)
                child.trail = before;
            else {
                child.trail = before.slice(0, split);
                nextLead = before.slice(split);
            }
            return close(nextLead);
        }
        if (next !== ',')
            return stop(reader, reader.pos, 'preview.json_error_expected_comma', next);
        reader.pos++;
        afterComma = true;
        const commaEnd = reader.pos;
        if (!skipTrivia(reader))
            return null;
        const after = reader.source.slice(commaEnd, reader.pos);
        const breakAt = after.indexOf('\n');
        if (breakAt === -1) {
            child.trail = `${before}${after}`;
            continue;
        }
        child.trail = `${before}${after.slice(0, breakAt)}`;
        nextLead = after.slice(breakAt);
    }
}

/** The indent the body was written with, so a rewrite does not reflow the block around it. */
function detectIndent(source: string): string {
    const match = /\n([ \t]+)\S/.exec(source);
    if (!match)
        return '  ';
    const run = match[1]!;
    return run.includes('\t') ? '\t' : ' '.repeat(Math.min(8, run.length));
}

function failure(reader: Reader): JsonParseOutcome {
    return { ok: false, document: null, failure: reader.failure ?? { reason: 'preview.json_error_unknown', line: 1, column: 1 } };
}

/**
 * Reads a JSON body into the preview's document model.
 *
 * Every ceiling here is a refusal, not a truncation: a half-built tree that the reader might then write
 * back over their note is worse than no tree at all, so a body that trips one keeps its source view and
 * is told why.
 */
export function parseJsonDocument(source: string, limits: JsonParseLimits = {}): JsonParseOutcome {
    if (!source.trim())
        return { ok: false, document: null, failure: { reason: 'preview.json_error_empty', line: 1, column: 1 } };
    if (source.length > JSON_VIEW_BODY_LIMIT_BYTES)
        return { ok: false, document: null, failure: { reason: 'preview.json_error_too_large', line: 1, column: 1 } };
    const reader: Reader = {
        source,
        pos: 0,
        nodes: 0,
        depth: 0,
        repairs: new Set(),
        maxDepth: limits.maxDepth ?? JSON_VIEW_MAX_DEPTH,
        maxNodes: limits.maxNodes ?? JSON_VIEW_MAX_NODES,
        failure: null,
    };
    const triviaFrom = reader.pos;
    if (!skipTrivia(reader))
        return failure(reader);
    const root = readEntry(reader, null, reader.source.slice(triviaFrom, reader.pos), reader.pos);
    if (!root)
        return failure(reader);
    const rootEnd = reader.pos;
    if (!limits.allowScalar && root.kind !== 'object' && root.kind !== 'array') {
        // A bare scalar is valid JSON but has nothing to preview: the fence already shows it, and a
        // one-row tree with a mind map of one node is a worse answer than the source.
        stop(reader, reader.pos, 'preview.json_error_not_structured');
        return failure(reader);
    }
    if (!skipTrivia(reader))
        return failure(reader);
    if (!done(reader)) {
        stop(reader, reader.pos, 'preview.json_error_trailing', charAt(reader));
        return failure(reader);
    }
    const document: JsonDocument = {
        root,
        indent: detectIndent(source),
        source,
        trailer: source.slice(rootEnd),
        repairs: [...reader.repairs],
    };
    return { ok: true, document, failure: null };
}

/**
 * Whether a body is worth a view host in the markup.
 *
 * The renderer asks this for every ```json fence before deciding what to emit, and it must not scan a
 * half-megabyte body to answer: size is the whole test, because the ceilings that need a scan are
 * reported by the parse itself when the reader opens the view.
 */
export function jsonBodyIsViewable(source: string): boolean {
    return source.length > 0 && source.length <= JSON_VIEW_BODY_LIMIT_BYTES;
}
