/**
 * The ceiling on how much body a single chart block will read.
 *
 * A chart body is the note's own text, and both doors into it — `JSON.parse` for a config, the row walk
 * for a table — cost more the longer the string is, and the drawing engine then lays the picture out
 * synchronously. Nothing else bounds them: a shared note hands one author's text to a visitor's browser,
 * and a block can be written by hand as well as pasted. The limit is set far above anything a person
 * authors and reads on a chart — a ten-series year of daily points is a few tens of kilobytes — so it
 * refuses a blob rather than a big chart.
 */
export const CHART_BODY_LIMIT_BYTES = 256 * 1024;

/** A body past that ceiling. Every caller turns this into the block's error state. */
export class ChartBodyTooLargeError extends Error {
    constructor(readonly limitKb: number = CHART_BODY_LIMIT_BYTES / 1024) {
        super('too-large');
    }
}

/** Checked before either reader runs, so the size is never paid for in order to be declined. */
export function assertChartBodySize(body: string): void {
    if (body.length > CHART_BODY_LIMIT_BYTES)
        throw new ChartBodyTooLargeError();
}
