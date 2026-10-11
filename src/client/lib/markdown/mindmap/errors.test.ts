import { beforeAll, describe, expect, it } from 'vitest';
import { EN_US_MESSAGES } from '@shared/locales/en-US';
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN';
import { initI18n } from '../../i18n';
import {
    MINDMAP_ERROR_CODES,
    MINDMAP_ERROR_MESSAGES,
    mindmapError,
    mindmapErrorCode,
    mindmapErrorText,
} from './errors';
import { MINDMAP_BODY_LIMIT_BYTES, MINDMAP_NODE_LIMIT, MindmapBodyTooLargeError, MindmapTooManyNodesError } from './nodes';

// Both catalogs read as plain tables: their keys are a narrowed union that also covers the
// note-template bodies, which live in another file.
const en = EN_US_MESSAGES as unknown as Record<string, string>;
const zh = ZH_CN_MESSAGES as unknown as Record<string, string>;

beforeAll(async () => {
    await initI18n();
});

describe('mindmapError', () => {
    it('writes the code first, so the half a test can pin is the half that never changes', () => {
        expect(mindmapError('bad-json', 'Unexpected end at 12')).toBe('bad-json: Unexpected end at 12');
        expect(mindmapError('no-node-data')).toBe('no-node-data');
    });

    it('reads the code back off both halves', () => {
        for (const code of MINDMAP_ERROR_CODES) {
            expect(mindmapErrorCode(code)).toBe(code);
            expect(mindmapErrorCode(mindmapError(code, 'some detail'))).toBe(code);
        }
    });

    it('reads a message the table does not know as a failure, rather than as its own name', () => {
        expect(mindmapErrorCode('Cannot read properties of undefined (reading topic)')).toBe('render-failed');
        expect(mindmapErrorCode('')).toBe('render-failed');
        expect(mindmapErrorCode('too-large-ish: 3')).toBe('render-failed');
    });

    it('every code has a sentence in both languages, and the sentence is not the key', () => {
        for (const [code, key] of Object.entries(MINDMAP_ERROR_MESSAGES)) {
            expect(en[key], `en-US: ${code}`).toBeTruthy();
            expect(zh[key], `zh-CN: ${code}`).toBeTruthy();
        }
    });

    it('the two limit errors carry their number, which is the half the reader can act on', () => {
        expect(mindmapErrorCode(new MindmapBodyTooLargeError().message)).toBe('too-large');
        expect(new MindmapBodyTooLargeError().message).toContain(`${MINDMAP_BODY_LIMIT_BYTES / 1024} KB`);
        expect(mindmapErrorCode(new MindmapTooManyNodesError().message)).toBe('too-many-nodes');
        expect(new MindmapTooManyNodesError().message).toContain(String(MINDMAP_NODE_LIMIT));
    });
});

describe('mindmapErrorText', () => {
    it('answers a known code in the reader language, with the measurement beside it', () => {
        const text = mindmapErrorText(mindmapError('bad-direction', '"down"'));
        expect(text).not.toContain('bad-direction');
        expect(text).toContain('"down"');
        expect(text).toBe(`${en[MINDMAP_ERROR_MESSAGES['bad-direction']]} ("down")`);
    });

    it('keeps a JSON position, which is the one thing a source view can be corrected with', () => {
        const detail = 'Unexpected token } in JSON at position 144180';
        expect(mindmapErrorText(mindmapError('bad-json', detail))).toContain(detail);
    });

    it('prints a sentence, not a token, for the body the ceiling refused', () => {
        expect(mindmapErrorText('too-large')).toBe(en[MINDMAP_ERROR_MESSAGES['too-large']]);
    });

    it('shows an unknown message whole, because that text is the only description there is', () => {
        const crash = 'TypeError: cannot read topic of undefined';
        expect(mindmapErrorText(crash)).toContain(crash);
    });
});
