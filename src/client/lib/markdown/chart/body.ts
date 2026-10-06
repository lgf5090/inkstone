/**
 * The fence-level half of a ```chart block: which languages draw a chart, which body format a body
 * carries, and the surgery that writes a converted body back into the note.
 *
 * The format comes from the body unless the note states one with `style=` (see ./style), and both homes
 * travel inside the fence, so the same block answers the same way in the preview and in an export
 * without either of them being told.
 */
import { applyFencePatchAtSource, fenceAt, type FenceTarget } from '../fence-edit';
import { isChartTableBody } from './table';
import { withFenceStyle, type DeclaredStyle } from './style';

export type ChartMode = DeclaredStyle;

/** Fence languages that render as a chart block. */
export const CHART_LANGUAGES = ['chart', 'chartjs'] as const;

/** The body a chart fence holds, the info line that opens it, and the line that holds both. */
export interface ChartFence extends FenceTarget {
    info: string
}

export function detectChartMode(body: string): ChartMode {
    return isChartTableBody(body) ? 'table' : 'json';
}

/**
 * The format a block reads its body as: what the note states, or what the body looks like when it states
 * nothing. The stated format is not a second opinion about the same fact — it decides which reader runs,
 * so a note that says `style=table` gets the message about its table even when the table is broken in a
 * way inference would not have recognised as a table at all.
 */
export function resolveChartMode(body: string, style: DeclaredStyle | null): ChartMode {
    return style ?? detectChartMode(body);
}

/**
 * The chart fence sitting on a line of the note, or null when that line holds something else. A block
 * hands over the line its markup was stamped with, so this is how a write re-reads the body it is
 * replacing rather than trusting what travelled through an attribute.
 */
export function chartFenceAt(content: string, line: number): ChartFence | null {
    const fence = fenceAt(content, line, CHART_LANGUAGES);
    return fence === null ? null : { line, body: fence.body, info: fence.info };
}

/** Rewrites the fence's body, its stated format, or both in one edit — one press, one undo. */
export function applyChartFencePatch(
    content: string,
    target: ChartFence,
    patch: { body?: string, style?: DeclaredStyle },
): string | null {
    if (patch.style === undefined)
        return applyFencePatchAtSource(content, target, { body: patch.body }, CHART_LANGUAGES);
    return applyFencePatchAtSource(
        content,
        target,
        { body: patch.body, info: withFenceStyle(target.info, patch.style) },
        CHART_LANGUAGES,
    );
}
