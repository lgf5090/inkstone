/**
 * Reading a model node the way the view shows it.
 *
 * Every function here answers a display question only. The text a row prints and the text the writer
 * emits are deliberately different things: a 4 KB string is truncated for the row and untouched in the
 * note, and a number keeps the digits the author typed rather than the ones `String()` would print.
 */
import type { JsonKind, JsonNode } from './types';
import { pathKey } from './types';

/** Kind tokens the view maps to localized labels. */
export const JSON_KIND_LABELS: Record<JsonKind, string> = {
    object: 'obj',
    array: 'arr',
    string: 'str',
    number: 'num',
    boolean: 'bool',
    null: 'null',
};

export const JSON_KIND_ORDER: JsonKind[] = ['string', 'number', 'boolean', 'null', 'object', 'array'];

/** How many characters a row shows before it tails the value with an ellipsis. */
export const JSON_TEXT_PREVIEW = 220;

/**
 * The value as the row prints it.
 *
 * A number answers from `literal`, which is what the note holds: `String(1e21)` is `1e+21` and a
 * twenty-digit integer comes back with different digits, so a row built from the parsed value would show
 * the reader a number their note does not contain.
 */
export function displayValue(node: JsonNode, limit = JSON_TEXT_PREVIEW): string {
    switch (node.kind) {
        case 'string': {
            const text = typeof node.value === 'string' ? node.value : '';
            return truncate(text.replace(/\n/g, '⏎'), limit);
        }
        case 'number':
            return node.literal ?? String(node.value ?? 0);
        case 'boolean':
            return node.value === true ? 'true' : 'false';
        case 'null':
            return 'null';
        default:
            return '';
    }
}

function truncate(text: string, limit: number): string {
    if (limit <= 0 || text.length <= limit)
        return text;
    return `${text.slice(0, limit)}…`;
}

/** The count a folded container shows in place of its contents. */
export function displaySummary(node: JsonNode): string {
    const count = node.children?.length ?? 0;
    return node.kind === 'array' ? `[${count}]` : `{${count}}`;
}

export function displayKey(node: JsonNode): string {
    if (node.key !== null)
        return node.key;
    return '';
}

export function isContainerNode(node: JsonNode): boolean {
    return node.kind === 'object' || node.kind === 'array';
}

/**
 * Which paths a filter keeps.
 *
 * A match on a leaf has to bring its whole branch with it, or the row the reader searched for appears
 * with nothing around it to say what it belongs to; a match on a container keeps its subtree, because
 * "show me everything under `config`" is the same request in the other direction.
 */
export function filterJsonTree(
    root: JsonNode,
    test: (node: JsonNode, path: (string | number)[]) => boolean,
): Set<string> {
    const kept = new Set<string>();
    const walk = (node: JsonNode, path: (string | number)[]): boolean => {
        let descendantMatched = false;
        (node.children ?? []).forEach((child, index) => {
            const segment = node.kind === 'array' ? index : (child.key ?? '');
            if (walk(child, [...path, segment]))
                descendantMatched = true;
        });
        const self = test(node, path);
        if (self || descendantMatched)
            kept.add(pathKey(path));
        return self || descendantMatched;
    };
    walk(root, []);
    return kept;
}

/**
 * Whether a node's own text is about the query.
 *
 * Containers are judged on their key alone: matching `{` against a query would keep every row in the
 * document, and matching the child count would keep the ones whose digits happen to appear.
 */
export function nodeMatchesText(node: JsonNode, test: (text: string) => boolean): boolean {
    if (node.key !== null && test(node.key))
        return true;
    if (isContainerNode(node))
        return false;
    return test(displayValue(node, 0));
}
