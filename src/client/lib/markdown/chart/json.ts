/**
 * The JSON half of a ```chart body. Chart blocks tolerate formatting: comment and `**` markers stripped
 * and trailing commas allowed before the strict parse is retried, because a config typed out of a
 * documentation page arrives with both.
 */
import { assertChartBodySize } from './limit';
import { safeReviver } from './table';

function cleanChartConfig(raw: string): string {
    return raw
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
        .replace(/,\s*([\]}])/g, '$1')
        .replace(/\*\*/g, '');
}

/**
 * The config a note wrote, with the keys every other object shares refused on the way in. The keyword
 * cell of a chart table already runs its hand-written JSON through the reviver; a body is the same
 * author's hand-written JSON arriving by the other door, so it goes through the same guard.
 */
export function parseChartJson(raw: string): Record<string, unknown> {
    assertChartBodySize(raw);
    let initialErr: unknown = null;
    try {
        return JSON.parse(raw, safeReviver) as Record<string, unknown>;
    }
    catch (err) {
        initialErr = err;
    }
    try {
        return JSON.parse(cleanChartConfig(raw), safeReviver) as Record<string, unknown>;
    }
    catch {
        throw initialErr;
    }
}
