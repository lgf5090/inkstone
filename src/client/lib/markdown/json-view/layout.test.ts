/**
 * The mind map's geometry, checked without a browser.
 *
 * The claims worth pinning are the ones the card style rests on, and the two the ported reference got
 * wrong by hardcoding (`depth * 190` for every level, `parent.x + 160` for every connector). Both are
 * asserted as invariants over the slots rather than as fixed numbers, so any measure function satisfies
 * them — but the row rules (what becomes a row, what becomes a card, and where a member's name is
 * written) are the design, and they are asserted directly.
 */
import { describe, expect, it } from 'vitest';
import { layoutJsonMap, mapLinkPath, MAP_CARD_PADDING, MAP_LEVEL_GAP, MAP_ROW_HEIGHT, type MapRow } from './layout';
import { collapseToDepth, findNode } from './edit';
import { displaySummary } from './inspect';
import { parseJsonDocument } from './parse';
import type { JsonNode, JsonPath } from './types';

function tree(body: string): JsonNode {
    return parseJsonDocument(body).document!.root;
}

/** The text the view would paint, in the layout's own terms: a container by size, a scalar by value. */
function valueFor(node: JsonNode, hidden: number): string {
    if (node.kind === 'object' || node.kind === 'array')
        return `${displaySummary(node)}${hidden > 0 ? ` +${hidden}` : ''}`;
    return String(node.value ?? '');
}

/** Monospace at 8px: the measure a browser would hand back for the row's own text. */
function widthOf(row: MapRow): number {
    return row.label.length * 8;
}

function options(over: Record<string, unknown> = {}) {
    return { valueFor, measure: widthOf, ...over };
}

const body = '{\n  "project": "json-editor",\n  "features": ["structured editor", "mindmap"],\n  "n": {"deep": {"deeper": 1}}\n}';

function rowsOf(layout: ReturnType<typeof layoutJsonMap>, key: string): MapRow[] {
    return layout.byKey.get(key)!.rows;
}

describe('layoutJsonMap', () => {
    it('gives every level the width its widest card needs', () => {
        const layout = layoutJsonMap(tree(body), options());
        const byDepth = new Map<number, typeof layout.slots>();
        for (const slot of layout.slots)
            byDepth.set(slot.depth, [...(byDepth.get(slot.depth) ?? []), slot]);
        for (const [depth, slots] of byDepth) {
            if (depth === 0)
                continue;
            const previous = byDepth.get(depth - 1)!;
            const previousRight = Math.max(...previous.map(slot => slot.x + slot.w));
            for (const slot of slots)
                expect(slot.x).toBeGreaterThanOrEqual(previousRight + MAP_LEVEL_GAP);
        }
    });

    it('keeps sibling cards from overlapping', () => {
        const layout = layoutJsonMap(tree(body), options());
        const parents = new Map<unknown, typeof layout.slots>();
        for (const slot of layout.slots) {
            const group = parents.get(slot.parent) ?? [];
            group.push(slot);
            parents.set(slot.parent, group);
        }
        for (const group of parents.values()) {
            const sorted = [...group].sort((left, right) => left.y - right.y);
            for (let index = 1; index < sorted.length; index++) {
                const above = sorted[index - 1]!;
                const below = sorted[index]!;
                expect(below.y - below.h / 2).toBeGreaterThan(above.y + above.h / 2);
            }
        }
    });

    it('measures a card by the widest row it will actually paint', () => {
        const layout = layoutJsonMap(tree('{"a": 1, "longer": {"deep": 2}}'), options());
        const root = layout.byKey.get('[]')!;
        // The root lists two rows; the wider is `longer: {1}`, measured at 8px a character.
        const widest = Math.max(...root.rows.map(widthOf));
        expect(root.w).toBe(widest + 2 * MAP_CARD_PADDING);
    });

    it('draws a connector from the row that names the member, not the card center', () => {
        const layout = layoutJsonMap(tree('{"a": {"x": 1}, "b": {"y": 2}, "c": [1, 2]}'), options());
        const root = layout.byKey.get('[]')!;
        for (const link of layout.links) {
            const row = root.rows.find(candidate => candidate.cards.includes(link.to))!;
            const numbers = mapLinkPath(link).match(/-?[\d.]+/g)!.map(Number);
            expect(numbers[0]).toBe(root.x + root.w);
            expect(numbers[1]).toBe(row.y);
            expect(numbers[2]).toBe(root.x + root.w + Math.max(18, (link.to.x - root.x - root.w) / 2));
            expect(numbers[3]).toBe(row.y);
            expect(numbers[numbers.length - 2]).toBe(link.to.x);
            expect(numbers[numbers.length - 1]).toBeCloseTo(link.to.y);
        }
        // A three-row card must not have all its lines leave from the same point.
        expect(new Set(layout.links.map(link => mapLinkPath(link).split(',')[1])).size).toBe(layout.links.length);
    });

    it('names a member in its row and on the connector that carries it', () => {
        const layout = layoutJsonMap(tree(body), options());
        const root = layout.byKey.get('[]')!;
        const project = root.rows.find(row => row.node.key === 'project')!;
        const nested = root.rows.find(row => row.node.key === 'n')!;
        expect(project.key).toBe('project');
        expect(project.label).toBe('project: json-editor');
        // A reader tracing one member out of a big picture reads both places, so both have to say the
        // same thing: the row names it for the card, the line names it for the card it hangs.
        expect(nested.key).toBe('n');
        expect(nested.label).toBe('n: {1}');
        expect(layout.links.find(link => link.to === nested.cards[0])!.label).toBe('n');
    });

    it('keeps a folded branch as one named row and draws no card for it', () => {
        const root = tree(body);
        findNode(root, ['features'])!.collapsed = true;
        const layout = layoutJsonMap(root, options());
        const folded = rowsOf(layout, '[]').find(row => row.node.key === 'features')!;
        expect(folded.branch).toBe(true);
        expect(folded.cards).toEqual([]);
        expect(folded.path).toEqual(['features']);
        expect(folded.label).toBe('features: [2]');
        expect(layout.byKey.has(JSON.stringify(['features']))).toBe(false);
        expect(layout.links.some(link => link.label === 'features')).toBe(false);
    });

    it('spreads a card\'s rows evenly inside it', () => {
        const layout = layoutJsonMap(tree('{"a": 1, "b": 2, "c": 3}'), options());
        const root = layout.byKey.get('[]')!;
        expect(root.h).toBe(3 * MAP_ROW_HEIGHT + 2 * MAP_CARD_PADDING);
        const top = root.y - root.h / 2;
        root.rows.forEach((row, index) => {
            expect(row.y).toBe(top + MAP_CARD_PADDING + MAP_ROW_HEIGHT * (index + 0.5));
        });
    });

    it('promotes an array of objects into one row fanning out to a card per element', () => {
        const layout = layoutJsonMap(tree('{"fruits": [{"name": "apple"}, {"name": "pear"}, {"name": "plum"}]}'), options());
        // The array itself is not a card; its three elements are, and they sit one level out from the root.
        expect(layout.byKey.has(JSON.stringify(['fruits']))).toBe(false);
        const cards = layout.slots.filter(slot => slot.depth === 1);
        expect(cards).toHaveLength(3);
        expect(cards.map(slot => slot.edgeLabel)).toEqual(['fruits', 'fruits', 'fruits']);
        expect(cards.map(slot => slot.path)).toEqual([['fruits', 0], ['fruits', 1], ['fruits', 2]]);
        expect(layout.links).toHaveLength(3);
        const root = layout.byKey.get('[]')!;
        // One row, named, holding all three cards: the list is one member of the document, not three.
        expect(root.rows).toHaveLength(1);
        expect(root.rows[0]!.key).toBe('fruits');
        expect(root.rows[0]!.cards).toHaveLength(3);
        expect(layout.links.every(link => link.row === root.rows[0])).toBe(true);
        // Three cards off one row means three different arrival points, or the fan is a straight line.
        expect(new Set(cards.map(slot => slot.y)).size).toBe(3);
    });

    it('keeps an array of scalars as rows in one card', () => {
        const layout = layoutJsonMap(tree('{"sizes": [10, 11, 12]}'), options());
        expect(layout.slots).toHaveLength(2);
        expect(layout.links).toHaveLength(1);
        const sizes = layout.byKey.get(JSON.stringify(['sizes']))!;
        expect(sizes.rows.map(row => row.label)).toEqual(['0: 10', '1: 11', '2: 12']);
    });

    it('drops the members a filter rejects from the cards and the connectors alike', () => {
        const keep = (_node: JsonNode, path: JsonPath): boolean => path.includes('project');
        const layout = layoutJsonMap(tree(body), options({ keep }));
        const root = layout.byKey.get('[]')!;
        // One named row and one line saying two members exist that did not reach the picture: a filtered
        // card that looks complete is a card that lied.
        expect(root.rows.map(row => row.key)).toEqual(['project', '']);
        expect(root.rows[1]!.more).toBe(true);
        expect(root.rows[1]!.value).toBe('+2');
        expect(layout.links).toHaveLength(0);
        expect(layout.slots).toHaveLength(1);
    });

    it('names the members a card leaves out, and only when it leaves one out', () => {
        const wide = tree(`{${Array.from({ length: 45 }, (_, index) => `"k${index}": ${index}`).join(',')}}`);
        const layout = layoutJsonMap(wide, options({ maxChildren: 40 }));
        const root = layout.byKey.get('[]')!;
        // Forty members and one line saying how many did not fit.
        expect(root.rows.filter(row => !row.more)).toHaveLength(40);
        expect(root.rows.find(row => row.more)?.value).toBe('+5');
        expect(root.hiddenChildren).toBe(5);
        expect(layout.truncated).toBe(false);
        // The count line is a row, so the card is tall enough to hold it.
        expect(root.h).toBe(41 * MAP_ROW_HEIGHT + 2 * MAP_CARD_PADDING);
        const small = layoutJsonMap(tree('{"a": [1, 2]}'), options({ maxChildren: 40 }));
        expect(small.byKey.get('[]')!.hiddenChildren).toBe(0);
        expect(small.byKey.get('[]')!.rows.find(row => row.node.key === 'a')!.value).toBe('[2]');
    });

    it('passes a container\'s own overflow to the value text', () => {
        const nested = tree(`{"big": {${Array.from({ length: 42 }, (_, index) => `"k${index}": 1`).join(',')}}}`);
        const layout = layoutJsonMap(nested, options({ maxChildren: 40 }));
        const row = layout.byKey.get('[]')!.rows.find(candidate => candidate.node.key === 'big')!;
        expect(row.value).toBe('{42} +2');
    });

    it('stops at the node ceiling and says it did', () => {
        const layout = layoutJsonMap(tree(body), options({ maxNodes: 3 }));
        expect(layout.truncated).toBe(true);
        expect(layout.slots).toHaveLength(3);
    });

    it('keeps an array whose elements are all folded as a card of its own', () => {
        // Promoting a folded element draws nothing, so an all-folded array would leave its row reading
        // "expanded" with no card under it and a handle that folds what was never unfolded. Left in the
        // card, each element keeps a row and a handle that really opens it.
        const root = tree('{"fruits": [{"a": 1}, {"b": 2}]}');
        for (const element of root.children![0]!.children!)
            element.collapsed = true;
        const layout = layoutJsonMap(root, options());
        const fruits = layout.byKey.get(JSON.stringify(['fruits']));
        expect(fruits, 'the folded array was promoted and drew no card').toBeDefined();
        expect(fruits!.rows.map(row => row.label)).toEqual(['0: {1}', '1: {1}']);
        expect(fruits!.rows.every(row => row.branch && row.cards.length === 0)).toBe(true);
        // The array's own row in the root card is expanded and does have a card hanging off it.
        const row = layout.byKey.get('[]')!.rows[0]!;
        expect(row.cards).toEqual([fruits]);
    });

    it('promotes the same array as soon as one element is open', () => {
        const root = tree('{"fruits": [{"a": 1}, {"b": 2}]}');
        for (const element of root.children![0]!.children!)
            element.collapsed = true;
        root.children![0]!.children![1]!.collapsed = false;
        const layout = layoutJsonMap(root, options());
        expect(layout.byKey.has(JSON.stringify(['fruits']))).toBe(false);
        expect(layout.slots.filter(slot => slot.depth === 1)).toHaveLength(1);
        expect(layout.byKey.get('[]')!.rows[0]!.cards).toHaveLength(1);
    });

    it('lays out a single node without a column of its own', () => {
        const layout = layoutJsonMap(tree('{"only": 1}'), options());
        expect(layout.slots).toHaveLength(1);
        expect(layout.width).toBeGreaterThan(0);
        expect(layout.height).toBeGreaterThan(0);
    });

    it('holds an empty container as a card with no rows', () => {
        const layout = layoutJsonMap(tree('{"a": {}, "b": []}'), options());
        expect(layout.slots).toHaveLength(3);
        for (const key of [JSON.stringify(['a']), JSON.stringify(['b'])])
            expect(layout.byKey.get(key)!.rows).toHaveLength(0);
        expect(layout.byKey.get(JSON.stringify(['a']))!.h).toBe(MAP_ROW_HEIGHT + 2 * MAP_CARD_PADDING);
    });

    it('shrinks the picture when a subtree is folded out of it', () => {
        const expanded = layoutJsonMap(tree(body), options());
        const root = tree(body);
        collapseToDepth(root, 1);
        const folded = layoutJsonMap(root, options());
        expect(folded.slots.length).toBeLessThan(expanded.slots.length);
        expect(folded.height).toBeLessThan(expanded.height);
    });
});
