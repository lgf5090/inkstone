import { describe, expect, it } from 'vitest';
import { applyFencePatchAtSource, fenceAt, splitLines } from './fence-edit';

const LANGS = ['chart'] as const;
const FENCE = '`'.repeat(3);

describe('locating a fence by the line it was drawn at', () => {
    it('returns the body between the two fence lines', () => {
        const content = `intro\n${FENCE}chart\nline one\nline two\n${FENCE}\ntail\n`;
        expect(fenceAt(content, 1, LANGS)).toEqual({ info: 'chart', body: 'line one\nline two' });
    });

    it('answers null for a line that holds something else', () => {
        expect(fenceAt(`${FENCE}js\n1\n${FENCE}\n`, 0, LANGS)).toBeNull();
        expect(fenceAt('plain\n', 0, LANGS)).toBeNull();
    });

    it('reads a tilde fence and an indented one', () => {
        expect(fenceAt('~~~chart\nbody\n~~~\n', 0, LANGS)?.body).toBe('body');
        expect(fenceAt('  ```chart\nbody\n  ```\n', 0, LANGS)?.body).toBe('body');
    });

    it('keeps a body that itself holds a shorter fence', () => {
        const content = `${FENCE}chart\n${'`'.repeat(2)}x\n${FENCE}\n`;
        expect(fenceAt(content, 0, LANGS)?.body).toBe('``x');
    });

    it('normalizes a CRLF body to LF', () => {
        expect(fenceAt(`${FENCE}chart\r\na\r\nb\r\n${FENCE}\r\n`, 0, LANGS)?.body).toBe('a\nb');
    });
});

describe('rewriting one fence', () => {
    it('leaves every line outside the block byte-identical', () => {
        const content = `intro\n${FENCE}chart\nold\n${FENCE}\ntail\n`;
        const next = applyFencePatchAtSource(content, { line: 1, body: 'old' }, { body: 'new' }, LANGS);
        expect(next).toBe(`intro\n${FENCE}chart\nnew\n${FENCE}\ntail\n`);
    });

    it('keeps the CRLF endings and the trailing-newline state', () => {
        const crlf = `a\r\n${FENCE}chart\r\nold\r\n${FENCE}\r\n`;
        expect(applyFencePatchAtSource(crlf, { line: 1, body: 'old' }, { body: 'x\ny' }, LANGS))
            .toBe(`a\r\n${FENCE}chart\r\nx\r\ny\r\n${FENCE}\r\n`);
        const noFinalNewline = `${FENCE}chart\nold\n${FENCE}`;
        expect(applyFencePatchAtSource(noFinalNewline, { line: 0, body: 'old' }, { body: 'new' }, LANGS))
            .toBe(`${FENCE}chart\nnew\n${FENCE}`);
    });

    it('widens the fence when the new body could close it early', () => {
        const content = `${FENCE}chart\nold\n${FENCE}\n`;
        const next = applyFencePatchAtSource(content, { line: 0, body: 'old' }, { body: FENCE }, LANGS);
        expect(next).toBe(`${'`'.repeat(4)}chart\n${FENCE}\n${'`'.repeat(4)}\n`);
    });

    it('leaves a body line that only starts with a fence alone, since it cannot close one', () => {
        const content = `${FENCE}chart\nold\n${FENCE}\n`;
        const next = applyFencePatchAtSource(content, { line: 0, body: 'old' }, { body: `${FENCE}inner` }, LANGS);
        expect(next).toBe(`${FENCE}chart\n${FENCE}inner\n${FENCE}\n`);
    });

    it('rewrites the info string beside the body', () => {
        const content = `${FENCE}chart\nold\n${FENCE}\n`;
        expect(applyFencePatchAtSource(content, { line: 0, body: 'old' }, { body: 'new', info: 'chart style=table' }, LANGS))
            .toBe(`${FENCE}chart style=table\nnew\n${FENCE}\n`);
    });

    it('keeps the blocks indentation', () => {
        const content = `  ${FENCE}chart\n  old\n  ${FENCE}\n`;
        expect(applyFencePatchAtSource(content, { line: 0, body: 'old' }, { body: 'a\nb' }, LANGS))
            .toBe(`  ${FENCE}chart\n  a\n  b\n  ${FENCE}\n`);
    });

    it('reads an indented body the way markdown-it hands it over', () => {
        // The renderer stamps the block with markdown-it's de-indented content, so a write that compared
        // the raw lines would decline every chart fence that sits inside a list item.
        expect(fenceAt(`  ${FENCE}chart\n  old\n  ${FENCE}\n`, 0, LANGS)?.body).toBe('old');
    });

    it('declines when the recorded line no longer holds that body', () => {
        const target = { line: 0, body: 'old' };
        expect(applyFencePatchAtSource(`${FENCE}chart\ndifferent\n${FENCE}\n`, target, { body: 'new' }, LANGS)).toBeNull();
    });

    it('follows the fence when it moved but its body did not', () => {
        const target = { line: 0, body: 'old' };
        const content = `intro\n${FENCE}chart\nold\n${FENCE}\n`;
        expect(applyFencePatchAtSource(content, target, { body: 'new' }, LANGS))
            .toBe(`intro\n${FENCE}chart\nnew\n${FENCE}\n`);
    });

    it('declines rather than guess between two identical fences', () => {
        const target = { line: 9, body: 'old' };
        const one = `${FENCE}chart\nold\n${FENCE}\n`;
        expect(applyFencePatchAtSource(`${one}x\n${one}`, target, { body: 'new' }, LANGS)).toBeNull();
    });

    it('closes a fence the note left unclosed', () => {
        const content = `${FENCE}chart\nold\n`;
        expect(applyFencePatchAtSource(content, { line: 0, body: 'old' }, { body: 'new' }, LANGS))
            .toBe(`${FENCE}chart\nnew\n${FENCE}\n`);
    });
});

describe('splitting a note into lines', () => {
    it('reports the ending style and puts it back', () => {
        const { lines, eol, trailingNewline } = splitLines('a\r\nb\r\n');
        expect([lines, eol, trailingNewline]).toEqual([['a', 'b'], '\r\n', true]);
    });
});
