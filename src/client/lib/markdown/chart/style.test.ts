import { describe, expect, it } from 'vitest';
import { NO_DECLARED_STYLE, parseStyleValue, readFenceStyle, styleSignature, withFenceStyle } from './style';

describe('the style= a chart fence may state', () => {
    it('reads the format off the info line, whichever way it is spelled', () => {
        expect(readFenceStyle('chart style=table')).toBe('table');
        expect(readFenceStyle('chartjs style="json"')).toBe('json');
        expect(readFenceStyle("chart title='x' style='table'")).toBe('table');
        expect(readFenceStyle('chart')).toBeNull();
        expect(readFenceStyle('')).toBeNull();
    });

    it('leaves a value that only looks like the annotation inside another token', () => {
        expect(readFenceStyle('chart title="style=not-this"')).toBeNull();
        expect(readFenceStyle('chart stylee=table')).toBeNull();
    });

    it('reads the format beside a leading brace group the way the fork writes one', () => {
        expect(readFenceStyle('{.chart} style=table')).toBe('table');
        expect(readFenceStyle('{.chart title="T"}')).toBeNull();
    });

    it('checks a read value against the two names a note may use', () => {
        expect(parseStyleValue(null)).toBe(NO_DECLARED_STYLE);
        expect(parseStyleValue('   ')).toBe(NO_DECLARED_STYLE);
        expect(parseStyleValue('TABLE')).toEqual({ style: 'table', invalid: null });
        expect(parseStyleValue(' json ')).toEqual({ style: 'json', invalid: null });
        expect(parseStyleValue('tabel')).toEqual({ style: null, invalid: 'tabel' });
    });

    it('writes the format back at the end of the line, leaving everything else where it was', () => {
        expect(withFenceStyle('chart', 'table')).toBe('chart style=table');
        expect(withFenceStyle('chart title="x"', 'json')).toBe('chart title="x" style=json');
        expect(withFenceStyle('chart style=json', 'table')).toBe('chart style=table');
        expect(withFenceStyle('chart   style=json', 'json')).toBe('chart style=json');
    });

    it('round-trips what it wrote', () => {
        for (const style of ['json', 'table'] as const) {
            const info = withFenceStyle('chart title="x"', style);
            expect(parseStyleValue(readFenceStyle(info))).toEqual({ style, invalid: null });
        }
    });

    it('distinguishes the two formats and a bad value in a draw signature', () => {
        expect(styleSignature(NO_DECLARED_STYLE)).toBe('');
        expect(styleSignature(parseStyleValue('table'))).toBe('table');
        expect(styleSignature(parseStyleValue('tabel'))).toBe('!tabel');
        expect(styleSignature(NO_DECLARED_STYLE)).not.toBe(styleSignature(parseStyleValue('json')));
    });
});
