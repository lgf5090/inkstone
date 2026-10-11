/**
 * The mind map's geometry, computed apart from anything that draws it.
 *
 * Two things the ported reference hardcoded are decided from the nodes instead here. It placed every
 * level at `depth * 190` and drew each connector from `parent.x + 160`, so a label wider than the slot
 * ran into its neighbour and every line started somewhere inside the box it claimed to leave — visible on
 * the demo's own `structured editor` node, whose text is longer than the gap. Column widths therefore
 * come from the widest node on each level, and a link runs from the parent's right edge to the child's
 * left edge.
 *
 * The measure function is a parameter because only the caller can know how wide a label paints: the
 * browser measures text, a test hands back a rule of thumb, and neither has to agree with the other for
 * the layout to be checkable.
 */
import type { JsonNode, JsonPath } from './types';
import { pathKey } from './types';

export interface MapSlot {
    node: JsonNode
    path: JsonPath
    key: string
    depth: number
    /** Left edge of the box, in canvas coordinates. */
    x: number
    /** Vertical center of the box. */
    y: number
    w: number
    h: number
    parent: MapSlot | null
    kids: MapSlot[]
    /** A folded container still shows its handle, so the view needs to know it has children. */
    expandable: boolean
    collapsed: boolean
}

export interface MapLayout {
    slots: MapSlot[]
    /** By `key`, so a re-layout can find the box a node moved to. */
    byKey: Map<string, MapSlot>
    width: number
    height: number
    /** True when the ceiling stopped the walk: the map is showing less than the document holds. */
    truncated: boolean
}

export interface MapLayoutOptions {
    measure: (node: JsonNode, depth: number) => { w: number, h: number }
    levelGap?: number
    siblingGap?: number
    padding?: number
    maxNodes?: number
}

export const MAP_LEVEL_GAP = 34;
export const MAP_SIBLING_GAP = 10;
export const MAP_PADDING = 32;

/**
 * Lays out the visible part of a document, left to right.
 *
 * A folded container contributes one row and no children, which is what keeps a 20 000-node document
 * drawable: the ceiling is applied to the nodes that are actually on screen, not to the tree.
 */
export function layoutJsonMap(root: JsonNode, options: MapLayoutOptions): MapLayout {
    const levelGap = options.levelGap ?? MAP_LEVEL_GAP;
    const siblingGap = options.siblingGap ?? MAP_SIBLING_GAP;
    const padding = options.padding ?? MAP_PADDING;
    const maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
    const slots: MapSlot[] = [];
    const byKey = new Map<string, MapSlot>();
    let truncated = false;

    const open = (node: JsonNode, path: JsonPath, depth: number, parent: MapSlot | null): MapSlot => {
        const slot: MapSlot = {
            node,
            path,
            key: pathKey(path),
            depth,
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            parent,
            kids: [],
            expandable: (node.children?.length ?? 0) > 0,
            collapsed: node.collapsed,
        };
        slots.push(slot);
        byKey.set(slot.key, slot);
        return slot;
    };

    const collect = (node: JsonNode, path: JsonPath, depth: number, parent: MapSlot | null): MapSlot | null => {
        if (slots.length >= maxNodes) {
            truncated = true;
            return null;
        }
        const slot = open(node, path, depth, parent);
        const children = node.children;
        const folded = node.collapsed || !children || children.length === 0;
        // The box is measured before the children are walked, so a parent's row is sized by its own
        // label and not by whichever child happens to be tallest.
        const size = options.measure(node, depth);
        slot.w = size.w;
        slot.h = size.h;
        if (folded)
            return slot;
        children.forEach((child, index) => {
            const segment = node.kind === 'array' ? index : (child.key ?? '');
            const kid = collect(child, [...path, segment], depth + 1, slot);
            if (kid)
                slot.kids.push(kid);
        });
        return slot;
    };

    collect(root, [], 0, null);

    let deepest = 0;
    const columnWidth: number[] = [];
    for (const slot of slots) {
        deepest = Math.max(deepest, slot.depth);
        columnWidth[slot.depth] = Math.max(columnWidth[slot.depth] ?? 0, slot.w);
    }
    const columnLeft: number[] = [];
    let left = padding;
    for (let depth = 0; depth <= deepest; depth++) {
        columnLeft[depth] = left;
        left += (columnWidth[depth] ?? 0) + levelGap;
    }

    let cursor = 0;
    const place = (slot: MapSlot): number => {
        slot.x = columnLeft[slot.depth] ?? padding;
        if (slot.kids.length === 0) {
            slot.y = cursor + slot.h / 2;
            cursor += slot.h + siblingGap;
        }
        else {
            const centers = slot.kids.map(place);
            const first = centers[0]!;
            const last = centers[centers.length - 1]!;
            slot.y = (first + last) / 2;
            // A parent narrower than its children's span still has to keep its own row clear of the
            // sibling below it, which is what the extra advance costs when the span is short.
            cursor = Math.max(cursor, last + slot.h / 2 + siblingGap);
        }
        return slot.y;
    };
    const rootSlot = slots[0];
    if (rootSlot)
        place(rootSlot);

    let height = 0;
    for (const slot of slots)
        height = Math.max(height, slot.y + slot.h / 2);

    const lastColumn = columnWidth[deepest] ?? 0;
    return {
        slots,
        byKey,
        width: (columnLeft[deepest] ?? padding) + lastColumn + padding,
        height: height + padding,
        truncated,
    };
}

/** The bezier a link is drawn with: out of the parent's right edge, into the child's left edge. */
export function mapLinkPath(from: MapSlot, to: MapSlot): string {
    const x1 = from.x + from.w;
    const y1 = from.y;
    const x2 = to.x;
    const y2 = to.y;
    const bend = Math.max(18, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}
