/**
 * Why a mind map body did not draw, as something the interface can name.
 *
 * The drawer used to hand its own diagnostic straight to the screen, so a reader saw
 * `too-large` — a token from the source of a library they have never opened. The code is
 * the stable half: it is what the interface looks a translation up by, and what a test can
 * assert without pinning the wording of an English sentence. The detail after the colon is
 * the variable half — a measurement or a value the file spelled, never a sentence, because
 * an English sentence in the brackets would be the only English in another language's
 * interface — and it is shown alongside the translated label so the reader still gets the
 * one part they can act on.
 */
import type { MessageKey } from '@shared/locales/en-US';
import { t } from '../../i18n';

/** The codes `./mind-elixir-vendor` and `./nodes` report. A new one needs a locale entry. */
export type MindmapErrorCode =
    | 'too-large'
    | 'no-node-data'
    | 'bad-json'
    | 'bad-theme'
    | 'bad-direction'
    | 'bad-compact'
    | 'too-many-nodes'
    | 'render-failed'
    | 'empty-export';

/** The sentence each code is told with, in the locale the reader is reading. */
export const MINDMAP_ERROR_MESSAGES: Record<MindmapErrorCode, MessageKey> = {
    'too-large': 'mindmap.error.too_large',
    'no-node-data': 'mindmap.error.no_node_data',
    'bad-json': 'mindmap.error.bad_json',
    'bad-theme': 'mindmap.error.bad_theme',
    'bad-direction': 'mindmap.error.bad_direction',
    'bad-compact': 'mindmap.error.bad_compact',
    'too-many-nodes': 'mindmap.error.too_many_nodes',
    'render-failed': 'preview.mindmap_render_failed',
    'empty-export': 'mindmap.error.empty_export',
};

const CODES = Object.keys(MINDMAP_ERROR_MESSAGES) as MindmapErrorCode[];

/** Whether a word is one of the codes this module knows, so a guard can pass its own message through. */
export function isMindmapErrorCode(value: string): value is MindmapErrorCode {
    return (CODES as readonly string[]).includes(value);
}

export { CODES as MINDMAP_ERROR_CODES };

/** `code: what the reader can change`, the form every reporter in this module writes. */
export function mindmapError(code: MindmapErrorCode, detail?: string): string {
    return detail ? `${code}: ${detail}` : code;
}

/** The stable half of a diagnostic string; anything the table does not know reads as a failure. */
export function mindmapErrorCode(error: string): MindmapErrorCode {
    const colon = error.indexOf(':');
    const head = (colon === -1 ? error : error.slice(0, colon)).trim();
    return CODES.includes(head as MindmapErrorCode) ? head as MindmapErrorCode : 'render-failed';
}

/** What the reader is told: the code's sentence, with whatever the drawer measured beside it. */
export function mindmapErrorText(error: string): string {
    const code = mindmapErrorCode(error);
    const label = t(MINDMAP_ERROR_MESSAGES[code]);
    // A code the table knows carries its measurement after the colon, and that is what goes
    // in the brackets. A message it does not know has been reported as `render-failed` — and
    // the message itself is then the only description there is, so dropping it would turn a
    // crash into a shrug; it is shown whole instead.
    const measured = error.startsWith(code) ? error.slice(code.length).replace(/^:\s*/, '').trim() : '';
    const detail = measured || (code === 'render-failed' ? error : '');
    // Straight brackets, not the full-width pair Chinese typesets with: this file is not a
    // locale, and the interface gate keeps CJK punctuation out of everything that is not one.
    return detail ? `${label} (${detail})` : label;
}
