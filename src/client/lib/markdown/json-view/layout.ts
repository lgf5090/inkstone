/**
 * The mind map's geometry, computed apart from anything that draws it.
 *
 * The map is drawn as **cards**, not as one box per value. A container is a card; each of its members is
 * a row inside it; only a member that is itself a container gets a card to the right, and the name that
 * produced it is written on the connector rather than repeated at the head of the child's box. That is
 * what makes a nested config read as a picture: one pill per scalar turns a 1200-key object into 1200
 * pills in a column 48 022px tall, which was measured on the previous round's build.
 *
 * Two things the ported reference hardcoded are still decided from the content instead. It placed every
 * level at `depth * 190` and drew each connector from `parent.x + 160`, so a label wider than the slot
 * ran into its neighbour and every line started somewhere inside the box it claimed to leave — visible on
 * its own demo, where `structured editor` is wider than the gap. Column widths therefore come from the
 * widest card on each level, and a link runs from the parent's right edge to the child's left edge.
 *
 * The layout produces the row's two strings (`key` and `value`) by asking the caller for them, and hands
 * the same row object to the caller's measure function, so the width a card is given is the width of the
 * text it will actually paint — handle, colour swatch and all. `label` is those two joined, kept because
 * it is what a test can assert on without knowing how the view splits a row into spans.
 */
import type { JsonNode, JsonPath } from './types';
import { pathKey } from './types';

/** One line inside a card. */
export interface MapRow {
    node: JsonNode
    /**
     * The name the card prints, or empty.
     *
     * A member that got a card has its name written on the connector instead, so the card leaves the name
     * out — that duplication is the whole reason the row is not a box of its own. A folded branch has no
     * card and therefore no connector, so it keeps its name in the row, next to the handle that opens it.
     */
    key: string
    /** A scalar's own text, or a container's summary. */
    value: string
    /** `key : value`, or just `value` when the key went to the connector: the text the card is measured by. */
    label: string
    /** A branch row owns the card to the right; a scalar row is only text. */
    branch: boolean
    /** The card this row reaches, or null for a leaf and for a branch that is folded shut. */
    slot: MapSlot | null
    /** This member's path, which is not `slot.path` when the slot does not exist. */
    path: JsonPath
    /** Vertical center of the row, in canvas coordinates. */
    y: number
    /** The count of the members this card left out, rather than a member itself. */
    more: boolean
}

export interface MapSlot {
    node: JsonNode
    path: JsonPath
    key: string
    depth: number
    /** Left edge of the card. */
    x: number
    /** Vertical center of the whole card. */
    y: number
    w: number
    h: number
    parent: MapSlot | null
    rows: MapRow[]
    collapsed: boolean
    /**
     * Members this card has but does not list, because a picture of 1200 siblings is not a picture of
     * anything. The model keeps all of them; the tree face shows all of them.
     */
    hiddenChildren: number
    /** The name written on the connector into this card. Empty for the root. */
    edgeLabel: string
}

export interface MapLink {
    from: MapSlot
    to: MapSlot
    /** The child's name, which the child's own card does not repeat. */
    label: string
    /** Where that name sits: the midpoint of the connector. */
    x: number
    y: number
}

export interface MapLayout {
    slots: MapSlot[]
    links: MapLink[]
    /** By `key`, so a re-layout can find the card a node moved to. */
    byKey: Map<string, MapSlot>
    width: number
    height: number
    /** The row pitch and card padding actually used, so the painter can place rows without guessing. */
    rowHeight: number
    cardPadding: number
    /** True when a ceiling stopped the walk: the map is showing less than the document holds. */
    truncated: boolean
}

export interface MapLayoutOptions {
    /**
     * The text one member paints as its value: a scalar's own, or a container's summary.
     *
     * `hidden` is how many of that member's own children the drawing left out, which the value text has
     * to name — a card showing three of nine rows has to say so, or the reader counts three. The member's
     * *name* is not asked for here: the layout already knows it, and needs it to decide what the row
     * measures as and what the connector prints.
     */
    valueFor: (node: JsonNode, hidden: number) => string
    /** Width in canvas units for one row's content, before the card's padding. */
    measure: (row: MapRow) => number
    rowHeight?: number
    cardPadding?: number
    levelGap?: number
    siblingGap?: number
    padding?: number
    maxNodes?: number
    maxChildren?: number
    /**
     * Whether an array of objects is drawn as one card per element instead of a card holding the array.
     *
     * The reference style promotes them: three fruits become three cards, each reached by a connector
     * labelled `fruits`, which is how a reader sees that three cards are siblings of one list rather than
     * three unrelated objects.
     */
    promoteArrays?: boolean
}

export const MAP_ROW_HEIGHT = 26;
export const MAP_CARD_PADDING = 9;
/** Wide enough to hold the name that sits on the connector. */
export const MAP_LEVEL_GAP = 130;
export const MAP_SIBLING_GAP = 18;
export const MAP_PADDING = 32;
/**
 * How many members one card may list.
 *
 * A flat 1200-key config laid out one row per sibling is a card 31 000px tall; no amount of fitting makes
 * that a picture, so a card stops at this many rows and names how many it left out.
 */
export const MAP_MAX_CHILDREN = 40;

function isContainer(node: JsonNode): boolean {
    return node.kind === 'object' || node.kind === 'array';
}

/** An array of containers is drawn as the containers themselves; an array of scalars stays one card. */
function promotable(node: JsonNode): boolean {
    return node.kind === 'array'
      && node.children !== null
      && node.children.length > 0
      && node.children.every(child => isContainer(child));
}

/**
 * Lays out the visible part of a document, left to right, as cards.
 *
 * A folded card lists no rows and spawns no children, which is what keeps a 20 000-node document
 * drawable: the ceilings are applied to what is actually on screen, not to the tree.
 */
export function layoutJsonMap(root: JsonNode, options: MapLayoutOptions): MapLayout {
    const rowHeight = options.rowHeight ?? MAP_ROW_HEIGHT;
    const cardPadding = options.cardPadding ?? MAP_CARD_PADDING;
    const levelGap = options.levelGap ?? MAP_LEVEL_GAP;
    const siblingGap = options.siblingGap ?? MAP_SIBLING_GAP;
    const padding = options.padding ?? MAP_PADDING;
    const maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
    const maxChildren = options.maxChildren ?? MAP_MAX_CHILDREN;
    const promoteArrays = options.promoteArrays !== false;
    const slots: MapSlot[] = [];
    const byKey = new Map<string, MapSlot>();
    let truncated = false;

    const open = (node: JsonNode, path: JsonPath, depth: number, parent: MapSlot | null, edgeLabel: string): MapSlot | null => {
        if (slots.length >= maxNodes) {
            truncated = true;
            return null;
        }
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
            rows: [],
            collapsed: node.collapsed,
            hiddenChildren: Math.max(0, (node.children?.length ?? 0) - maxChildren),
            edgeLabel,
        };
        slots.push(slot);
        byKey.set(slot.key, slot);
        return slot;
    };

    /**
     * A row for one member, and the card it reaches if it has one.
     *
     * `named` is the name the *card* prints; it is empty when the name has gone to the connector, which is
     * only when there is a connector. So a folded branch keeps `features : [2]` in its row while an open one
     * shows just `[2]` and spells `features` on the line.
     */
    const rowFor = (node: JsonNode, name: string, hidden: number, path: JsonPath, slot: MapSlot | null, branch: boolean): MapRow => {
        const value = options.valueFor(node, hidden);
        const named = slot ? '' : name;
        return {
            node,
            key: named,
            value,
            label: named ? `${name} : ${value}` : value,
            branch,
            slot,
            path,
            y: 0,
            more: false,
        };
    };

    /** A card that left members out says so on its last line, or the reader counts what it can see. */
    const pushMore = (slot: MapSlot, hidden: number): void => {
        if (hidden <= 0)
            return;
        const text = `+${hidden}`;
        slot.rows.push({ node: slot.node, key: '', value: text, label: text, branch: false, slot: null, path: slot.path, y: 0, more: true });
    };

    /** Rows first, then the cards they point at, so a branch row's card is known while the card is built. */
    const fill = (slot: MapSlot): void => {
        const node = slot.node;
        const children = node.children;
        if (node.collapsed || !children || children.length === 0)
            return;
        children.slice(0, maxChildren).forEach((child, index) => {
            const segment = node.kind === 'array' ? String(index) : (child.key ?? '');
            const pathSegment = node.kind === 'array' ? index : segment;
            const hidden = Math.max(0, (child.children?.length ?? 0) - maxChildren);
            if (!isContainer(child)) {
                slot.rows.push(rowFor(child, segment, hidden, [...slot.path, pathSegment], null, false));
                return;
            }
            if (child.collapsed) {
                slot.rows.push(rowFor(child, segment, hidden, [...slot.path, pathSegment], null, true));
                return;
            }
            if (promoteArrays && promotable(child)) {
                // The array's own name goes on every connector into its elements, which is the only way
                // the reader can tell three sibling cards from three unrelated ones.
                const elements = child.children ?? [];
                elements.slice(0, maxChildren).forEach((element, position) => {
                    const at = [...slot.path, pathSegment, position];
                    const branch = element.collapsed
                        ? null
                        : open(element, at, slot.depth + 1, slot, segment);
                    slot.rows.push(rowFor(element, String(position), Math.max(0, (element.children?.length ?? 0) - maxChildren), at, branch, true));
                    if (branch)
                        fill(branch);
                });
                pushMore(slot, Math.max(0, elements.length - maxChildren));
                return;
            }
            const at = [...slot.path, pathSegment];
            const branch = open(child, at, slot.depth + 1, slot, segment);
            slot.rows.push(rowFor(child, segment, hidden, at, branch, true));
            if (branch)
                fill(branch);
        });
        pushMore(slot, Math.max(0, children.length - maxChildren));
    };

    const rootSlot = open(root, [], 0, null, '');
    if (rootSlot)
        fill(rootSlot);

    let deepest = 0;
    const columnWidth: number[] = [];
    for (const slot of slots) {
        deepest = Math.max(deepest, slot.depth);
        const widest = slot.rows.reduce((best, row) => Math.max(best, options.measure(row)), 0);
        slot.w = widest + 2 * cardPadding;
        // A folded or empty card still has to hold its own name and handle, so it is never zero tall.
        slot.h = Math.max(1, slot.rows.length) * rowHeight + 2 * cardPadding;
        columnWidth[slot.depth] = Math.max(columnWidth[slot.depth] ?? 0, slot.w);
    }
    const columnLeft: number[] = [];
    let left = padding;
    for (let depth = 0; depth <= deepest; depth++) {
        columnLeft[depth] = left;
        left += (columnWidth[depth] ?? 0) + levelGap;
    }

    let cursor = 0;
    /** Places one card and returns its center plus the lowest point under it, gap included. */
    const place = (slot: MapSlot): { center: number, bottom: number } => {
        slot.x = columnLeft[slot.depth] ?? padding;
        const branches = slot.rows.filter(row => row.slot);
        if (branches.length === 0) {
            slot.y = cursor + slot.h / 2;
            cursor = slot.y + slot.h / 2 + siblingGap;
            return { center: slot.y, bottom: cursor };
        }
        const placed = branches.map(row => place(row.slot!));
        slot.y = (placed[0]!.center + placed[placed.length - 1]!.center) / 2;
        const bottom = Math.max(slot.y + slot.h / 2 + siblingGap, ...placed.map(item => item.bottom));
        cursor = Math.max(cursor, bottom);
        return { center: slot.y, bottom };
    };
    if (rootSlot)
        place(rootSlot);

    let height = 0;
    for (const slot of slots) {
        const top = slot.y - slot.h / 2;
        slot.rows.forEach((row, index) => {
            row.y = top + cardPadding + rowHeight * (index + 0.5);
        });
        height = Math.max(height, slot.y + slot.h / 2);
    }

    const links: MapLink[] = [];
    for (const slot of slots) {
        for (const row of slot.rows) {
            if (!row.slot)
                continue;
            links.push({
                from: slot,
                to: row.slot,
                label: row.slot.edgeLabel,
                x: (slot.x + slot.w + row.slot.x) / 2,
                y: (row.y + row.slot.y) / 2,
            });
        }
    }

    const lastColumn = columnWidth[deepest] ?? 0;
    return {
        slots,
        links,
        byKey,
        width: (columnLeft[deepest] ?? padding) + lastColumn + padding,
        height: height + padding,
        rowHeight,
        cardPadding,
        truncated,
    };
}

/**
 * The bezier a connector draws: out of the parent card's right edge at the row that names the member,
 * into the child card's left edge at its own center. Leaving from the *row* rather than the card center
 * is what keeps a four-row card's four branches from all leaving from the same point.
 */
export function mapLinkPath(link: MapLink): string {
    const x1 = link.from.x + link.from.w;
    const y1 = link.from.rows.find(row => row.slot === link.to)?.y ?? link.from.y;
    const x2 = link.to.x;
    const y2 = link.to.y;
    const bend = Math.max(18, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}
