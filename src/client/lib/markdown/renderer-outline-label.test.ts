import { describe, expect, it } from 'vitest';
import { renderOutlineLabel } from './renderer';

function textOf(markup: string): string {
    const frame = document.createElement('span');
    frame.innerHTML = markup;
    return frame.textContent ?? '';
}

describe('renderOutlineLabel', () => {
    it('carries the emphasis written in the heading', () => {
        expect(renderOutlineLabel('**Ship** the `release` build')).toBe('<strong>Ship</strong> the <code>release</code> build');
    });

    it('leaves a plain heading alone', () => {
        expect(renderOutlineLabel('Nothing styled here')).toBe('Nothing styled here');
    });

    it('escapes raw html instead of passing it through', () => {
        const out = renderOutlineLabel('<img src=x onerror=alert(1)>Title');
        expect(out).not.toContain('onerror');
        expect(out).not.toContain('<img');
        expect(textOf(out)).toContain('Title');
    });

    it('keeps the words of a link but not the anchor', () => {
        const out = renderOutlineLabel('Read the [Guide](https://example.com) first');
        expect(out).not.toContain('<a');
        expect(out).not.toContain('href');
        expect(textOf(out)).toBe('Read the Guide first');
    });

    it('flattens an internal link to its title', () => {
        const out = renderOutlineLabel('See [[Other Note]]');
        expect(out).not.toContain('data-wikilink');
        expect(textOf(out)).toContain('Other Note');
    });

    it('strips every attribute from a surviving tag', () => {
        const out = renderOutlineLabel('<span onclick="alert(1)" title="t">Text</span>');
        expect(out).not.toContain('onclick');
        expect(out).not.toContain('title');
        expect(textOf(out)).toContain('Text');
    });

    it('returns nothing for a heading whose only content is math', () => {
        expect(textOf(renderOutlineLabel('$x^2$'))).toBe('');
    });
});
