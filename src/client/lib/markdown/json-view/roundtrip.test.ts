/**
 * The property the JSON preview is built on: what the reader records, the writer gives back.
 *
 * Every case below is a body the note already holds, and the claim is that opening the view and closing
 * it again — with no edit — leaves the note byte-identical. That is the guarantee the ported reference did
 * not make: it re-serialized through `JSON.parse`/`JSON.stringify` on every save, so a body carrying
 * `1.0`, a 20-digit id, a `//` comment or a trailing comma came back out rewritten.
 */
import { describe, expect, it } from 'vitest';
import { parseJsonDocument } from './parse';
import { reindentJsonDocument, writeJsonDocument } from './write';
import { emptyChild, insertChild, moveChild, removeChild, renameEntry } from './edit';
import { findNode } from './edit';
import { valueOfNode } from './write';
import { JSON_VIEW_MAX_DEPTH, JSON_VIEW_MAX_NODES } from './types';

/** Bodies that must survive the trip exactly, each one spelling out the shape it protects. */
const VERBATIM_BODIES: Array<[string, string]> = [
    ['plain object', '{\n  "a": 1\n}'],
    ['nested', '{\n  "a": {\n    "b": [1, 2, 3]\n  }\n}'],
    ['decimal kept', '{"n": 1.0}'],
    ['exponent kept', '{"n": 1e10}'],
    ['unsafe integer kept', '{"id": 12345678901234567890}'],
    ['negative zero kept', '{"n": -0}'],
    ['escapes kept', '{"s": "a\\u0041b\\nc"}'],
    ['unicode kept', '{"标题": "深度研究笔记", "emoji": "🚀"}'],
    ['empty containers', '{"o": {},"a": []}'],
    ['line comment', '{\n  // which one the app boots with\n  "theme": "dark"\n}'],
    ['block comment', '{\n  /* both keys, on purpose */\n  "a": 1\n}'],
  ['trailing comma', '{\n  "a": 1,\n}'],
    ['single quotes', "{'a': 'b'}"],
    ['unquoted key', '{a: 1}'],
    ['bare word value', '{k: someWord}'],
    ['hex number', '{"n": 0x1f}'],
    ['tight spacing', '{"a":1,"b":2}'],
    ['wide spacing', '{  "a"  :  1  }'],
    ['array of objects', '[\n  {"i": 1},\n  {"i": 2}\n]'],
    ['duplicate keys', '{"a": 1,\n  "a": 2}'],
    ['proto key', '{"__proto__": {"polluted": true}, "ok": 1}'],
    ['leading newline', '\n{\n  "a": 1\n}\n'],
    ['colon inside a string', '{"href": "https://example.com/a:b"}'],
    ['apostrophe inside a string', '{"note": "it\'s here"}'],
    ['quotes inside a string', '{"note": "say \\"hi\\""}'],
    ['tabs as indent', '{\n\t"a": 1\n}'],
    ['comment before closer', '{\n  "a": 1\n  // nothing after this\n}'],
];

describe('parseJsonDocument + writeJsonDocument', () => {
    it.each(VERBATIM_BODIES)('round-trips %s byte for byte', (_name, body) => {
        const parsed = parseJsonDocument(body);
        expect(parsed.failure).toBeNull();
        expect(parsed.ok).toBe(true);
        expect(writeJsonDocument(parsed.document!)).toBe(body);
    });

    it('keeps every untouched branch when one entry is renamed', () => {
        const body = '{\n  "a": 1,\n  "b": {\n    "c": 1.0,\n    "d": 12345678901234567890\n  }\n}';
        const parsed = parseJsonDocument(body);
        const target = findNode(parsed.document!.root, ['b', 'c'])!;
        expect(renameEntry(target, 'cc')).toBe(true);
        expect(writeJsonDocument(parsed.document!)).toBe(
            '{\n  "a": 1,\n  "b": {\n    "cc": 1.0,\n    "d": 12345678901234567890\n  }\n}',
        );
    });

    it('writes a valid separator when the first member is removed', () => {
        const parsed = parseJsonDocument('{\n  "a": 1,\n  "b": 2\n}');
        removeChild(parsed.document!.root, 0);
        expect(writeJsonDocument(parsed.document!)).toBe('{\n  "b": 2\n}');
    });

    it('writes a valid separator when the last member is removed', () => {
        const parsed = parseJsonDocument('{\n  "a": 1,\n  "b": 2\n}');
        removeChild(parsed.document!.root, 1);
        expect(writeJsonDocument(parsed.document!)).toBe('{\n  "a": 1\n}');
    });

    it('drops the comma a tolerant read accepted', () => {
        const parsed = parseJsonDocument('{\n  "a": 1,\n}');
        insertChild(parsed.document!.root, 1, emptyChild(parsed.document!.root, 'b'));
        expect(writeJsonDocument(parsed.document!)).toBe('{\n  "a": 1,\n  "b": ""\n}');
    });

    it('appends a member with the document indent', () => {
        const parsed = parseJsonDocument('{\n    "a": 1\n}');
        insertChild(parsed.document!.root, 1, emptyChild(parsed.document!.root, 'b'));
        expect(writeJsonDocument(parsed.document!)).toBe('{\n    "a": 1,\n    "b": ""\n}');
    });

    it('carries a line comment with the row it annotates', () => {
        const body = '{\n  "a": 1.0, // first\n  "b": 2\n}';
        const parsed = parseJsonDocument(body);
        expect(moveChild(parsed.document!.root, 1, 0)).toBe(true);
        // `// first` was typed beside `a`, so it goes where `a` goes. Splitting the trivia at the line
        // break rather than at the comma is the whole reason the split is recorded at parse time.
        expect(writeJsonDocument(parsed.document!)).toBe('{\n  "b": 2,\n  "a": 1.0 // first\n}');
    });

    it('re-emits the whole tree only when asked to', () => {
        const body = '{\n  "a": 1,\n  "b": 2\n}';
        const parsed = parseJsonDocument(body);
        expect(reindentJsonDocument(parsed.document!, '    ')).toBe('{\n    "a": 1,\n    "b": 2\n}');
    });

    it('keeps a string that merely looks like a broken number', () => {
        const parsed = parseJsonDocument('{"a": "1.2.3"}');
        expect(valueOfNode(parsed.document!.root)).toEqual({ a: '1.2.3' });
    });
});

describe('parseJsonDocument failures', () => {
    it.each([
        ['unclosed brace', '{"a": 1'],
        ['missing colon', '{"a" 1}'],
        ['missing comma', '{"a": 1 "b": 2}'],
        ['trailing text', '{"a": 1} nope'],
        ['empty body', ''],
        ['a bare scalar', '42'],
    ])('refuses %s and names where', (_name, body) => {
        const parsed = parseJsonDocument(body);
        expect(parsed.ok).toBe(false);
        expect(parsed.failure?.reason).toMatch(/^preview\.json_error_/);
    });

    it('points at the line the reader should scroll to', () => {
        const parsed = parseJsonDocument('{\n  "a": 1,\n  "b": ,\n}');
        expect(parsed.failure?.line).toBe(3);
        expect(parsed.failure?.column).toBe(8);
    });

    it('refuses a document deeper than the view can walk', () => {
        const body = `${'['.repeat(JSON_VIEW_MAX_DEPTH + 5)}${']'.repeat(JSON_VIEW_MAX_DEPTH + 5)}`;
        expect(parseJsonDocument(body).failure?.reason).toBe('preview.json_error_too_deep');
    });

    it('refuses a document wider than the view can mount', () => {
        const body = `[${Array.from({ length: JSON_VIEW_MAX_NODES + 5 }, () => '1').join(',')}]`;
        expect(parseJsonDocument(body).failure?.reason).toBe('preview.json_error_too_many');
    });
});

describe('tolerant reading', () => {
    it('does not rewrite the inside of a string the way a regex pass would', () => {
        const parsed = parseJsonDocument('{"href": "https://example.com/a:b", "note": "it\'s here"}');
        expect(parsed.ok).toBe(true);
        expect(valueOfNode(parsed.document!.root)).toEqual({
            href: 'https://example.com/a:b',
            note: 'it\'s here',
        });
    });

    it('names each shape it had to take on faith', () => {
        const parsed = parseJsonDocument("{a: 'b', c: 1,}");
        expect(parsed.document?.repairs.sort()).toEqual(
            expect.arrayContaining(['single-quote', 'unquoted-key', 'trailing-comma']),
        );
    });

    it('keeps a duplicate key rather than picking a winner', () => {
        const parsed = parseJsonDocument('{"a": 1, "a": 2}');
        expect(parsed.document!.root.children).toHaveLength(2);
        expect(writeJsonDocument(parsed.document!)).toBe('{"a": 1, "a": 2}');
    });

    it('does not let a note key reach the prototype of a value', () => {
        const parsed = parseJsonDocument('{"__proto__": {"polluted": true}}');
        const value = valueOfNode(parsed.document!.root) as Record<string, unknown>;
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
    });
});
