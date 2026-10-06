import { describe, expect, it } from 'vitest';
import {
    APP_THEME_CHOICE,
    MINDMAP_THEME_ATTR,
    fenceThemeChoice,
    readFenceAnnotation,
    readThemeChoice,
    resolveThemeChoice,
    withFenceAnnotation,
} from './theme';

describe('readThemeChoice', () => {
    it.each([[undefined], [null], ['auto'], ['Auto'], [' app ']])('treats %s as following the app', (value) => {
        expect(readThemeChoice(value)).toEqual({ choice: APP_THEME_CHOICE });
    });

    it.each(['light', ' DARK '])('reads %s as a named palette', (value) => {
        const read = readThemeChoice(value);
        expect('choice' in read && read.choice.kind).toBe(value.trim().toLowerCase());
    });

    it('keeps a theme object as written, which is the shape the library\'s own files carry', () => {
        const theme = { name: 'mine', palette: ['#111'] };
        expect(readThemeChoice(theme)).toEqual({ choice: { kind: 'custom', theme } });
    });

    it.each([42, true, ['dark']])('reports a %s rather than drawing in a guessed palette', (value) => {
        expect('error' in readThemeChoice(value)).toBe(true);
    });
});

describe('readFenceAnnotation', () => {
    it.each([
        ['mindmap theme=dark', 'dark'],
        ['mindmap title="Plan" theme=light', 'light'],
        ['mindmap theme="two words"', 'two words'],
        ["mindmap theme='single'", 'single'],
        ['mindmap   theme=auto  ', 'auto'],
    ])('reads the annotation out of %s', (info, raw) => {
        expect(readFenceAnnotation(info)).toBe(raw);
    });

    it('names nothing when the line has no annotation', () => {
        expect(readFenceAnnotation('mindmap title="Plan"')).toBeNull();
    });

    it('does not mistake a word that merely ends in theme=', () => {
        expect(readFenceAnnotation('mindmap mytheme=dark')).toBeNull();
    });

    it('reads a brace-free value past a JSON-ish info line but stops at a brace', () => {
        expect(readFenceAnnotation('mindmap theme=dark{')).toBe('dark');
    });

    it('caps the raw value, since it is echoed back into the note', () => {
        expect(readFenceAnnotation(`mindmap theme=${'x'.repeat(200)}`)).toHaveLength(64);
    });
});

describe('withFenceAnnotation', () => {
    it('appends to a bare language', () => {
        expect(withFenceAnnotation('mindmap', 'dark')).toBe('mindmap theme=dark');
    });

    it('leaves every other field of the line alone', () => {
        expect(withFenceAnnotation('mindmap title="Plan" wrap', 'light')).toBe('mindmap title="Plan" wrap theme=light');
    });

    it('replaces an existing annotation rather than stacking a second one', () => {
        expect(withFenceAnnotation('mindmap theme=dark', 'light')).toBe('mindmap theme=light');
    });

    it('removes the annotation for null, including a quoted one', () => {
        expect(withFenceAnnotation('mindmap theme="two words" wrap', null)).toBe('mindmap wrap');
    });

    it('is a round trip: reading back what was written gives the same value', () => {
        const info = 'mindmap title="Plan" theme=dark';
        expect(readFenceAnnotation(withFenceAnnotation(info, 'light'))).toBe('light');
    });
});

describe('fenceThemeChoice', () => {
    it('lets the body win over the annotation', () => {
        expect(fenceThemeChoice({ kind: 'light' }, 'dark')).toEqual({ choice: { kind: 'light' } });
    });

    it('falls back to the annotation only when the body names nothing', () => {
        expect(fenceThemeChoice(APP_THEME_CHOICE, 'dark')).toEqual({ choice: { kind: 'dark' } });
    });

    it('reports an annotation it cannot read, rather than drawing in the app palette', () => {
        expect(fenceThemeChoice(APP_THEME_CHOICE, 'neon')).toEqual({ error: expect.any(String) });
    });

    it('has nothing to report when there is no annotation at all', () => {
        expect(fenceThemeChoice(APP_THEME_CHOICE, null)).toEqual({ choice: APP_THEME_CHOICE });
    });
});

describe('resolveThemeChoice', () => {
    it('maps the app setting onto a body that follows it', () => {
        expect(resolveThemeChoice(APP_THEME_CHOICE, true)).toEqual({ kind: 'dark' });
        expect(resolveThemeChoice(APP_THEME_CHOICE, false)).toEqual({ kind: 'light' });
    });

    it('leaves a pinned palette alone when the app switches', () => {
        expect(resolveThemeChoice({ kind: 'light' }, true)).toEqual({ kind: 'light' });
    });

    it('passes a custom theme object straight through', () => {
        const theme = { palette: ['#111'] };
        expect(resolveThemeChoice({ kind: 'custom', theme }, true)).toEqual({ kind: 'custom', theme });
    });
});

describe('MINDMAP_THEME_ATTR', () => {
    it('is the data attribute the renderer stamps and the registry reads', () => {
        expect(MINDMAP_THEME_ATTR).toBe('data-mindmap-theme');
    });
});
