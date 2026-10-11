/**
 * The mind map's geometry, checked without a browser.
 *
 * The claims worth pinning are the two the ported reference got wrong by hardcoding: it placed levels at
 * `depth * 190` and drew every connector from `parent.x + 160`, so a label wider than the slot ran into
 * its neighbour and each line started inside the box it claimed to leave. Both are asserted here as
 * invariants over the slots rather than as fixed numbers, so any measure function satisfies them.
 */
import { describe, expect, it } from 'vitest';
import { layoutJsonMap, mapLinkPath, MAP_LEVEL_GAP } from './layout';
import { collapseToDepth, findNode } from './edit';
import { parseJsonDocument } from './parse';
import type { JsonNode } from './types';

/** Monospace at 8px, with the label the node prints: the measure a browser would hand back. */
function measure(node: JsonNode): { w: number, h: number } {
    const label = node.key ?? (node.kind === 'array' ? '[]' : String(node.value ?? ''));
    return { w: label.length * 8 + 16, h: 28 };
}

function options(over: Record<string, unknown> = {}) {
    return { measure, ...over };
}

function tree(body: string): JsonNode {
    return parseJsonDocument(body).document!.root;
}

describe('layoutJsonMap', () => {
    const body = '{\n  "project": "json-editor",\n  "features": ["structured editor", "mindmap"],\n  "n": {"deep": {"deeper": 1}}\n}';

    it('gives every level the width its widest label needs', () => {
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

    it('keeps sibling boxes from overlapping', () => {
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

    it('draws a connector between the boxes, not across them', () => {
        const layout = layoutJsonMap(tree(body), options());
        // An array element has no key of its own, so the label the reference's demo shows for it —
        // `"structured editor"` — is the value, and that is what the slot has to be found by.
        const child = layout.slots.find(slot => slot.node.value === 'structured editor')!;
        const parent = child.parent!;
        const path = mapLinkPath(parent, child);
        const numbers = path.match(/-?[\d.]+/g)!.map(Number);
        expect(numbers[0]).toBe(parent.x + parent.w);
        expect(numbers[1]).toBeCloseTo(parent.y);
        expect(numbers[numbers.length - 2]).toBe(child.x);
        expect(numbers[numbers.length - 1]).toBeCloseTo(child.y);
    });

    it('folds a subtree out of the drawing', () => {
        const root = tree(body);
        const features = findNode(root, ['features'])!;
        features.collapsed = true;
        const layout = layoutJsonMap(root, options());
        expect(layout.slots.some(slot => slot.node.key === 'structured editor')).toBe(false);
        expect(layout.byKey.get(JSON.stringify(['features']))!.expandable).toBe(true);
        expect(layout.byKey.get(JSON.stringify(['features']))!.kids).toHaveLength(0);
    });

    it('keeps a folded branch on one row of its own', () => {
        const expanded = layoutJsonMap(tree(body), options());
        const root = tree(body);
        collapseToDepth(root, 1);
        const folded = layoutJsonMap(root, options());
        const features = folded.byKey.get(JSON.stringify(['features']))!;
        const project = folded.byKey.get(JSON.stringify(['project']))!;
        expect(folded.slots.length).toBeLessThan(expanded.slots.length);
        expect(features.y).toBeGreaterThan(project.y);
        expect(folded.height).toBeLessThan(expanded.height);
    });

    it('stops at the ceiling and says it did', () => {
        const layout = layoutJsonMap(tree(body), options({ maxNodes: 3 }));
        expect(layout.truncated).toBe(true);
        expect(layout.slots).toHaveLength(3);
    });

    it('lays out a single node without a column of its own', () => {
        const layout = layoutJsonMap(tree('{"only": 1}'), options());
        expect(layout.slots).toHaveLength(2);
        expect(layout.width).toBeGreaterThan(0);
        expect(layout.height).toBeGreaterThan(0);
    });

    it('holds an empty container without a child at depth one', () => {
        const layout = layoutJsonMap(tree('{"a": {}, "b": []}'), options());
        expect(layout.slots.filter(slot => slot.depth === 1)).toHaveLength(2);
    });
});
