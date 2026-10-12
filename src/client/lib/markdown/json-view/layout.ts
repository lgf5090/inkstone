/**
 * The mind map's geometry, computed apart from anything that draws it.
 *
 * The map is drawn as **cards**, not as one box per value. A container is a card; each of its members is
 * one row inside it, named the way the document names it (`color : #FF0000`, `details : {2 keys}`); a
 * member that is itself a container gets a card to the right, hung off the row that names it. An array of
 * containers is the one place where the picture departs from the document's shape on purpose: the array
 * stays a single row — `fruits : [3 items]` — and its elements fan out from that row, because a card
 * listing `0 : {4}`, `1 : {4}`, `2 : {4}` tells the reader nothing the fan does not.
 *
 * Two things the ported reference hardcoded are still decided from the content instead. It placed every
 * level at `depth * 190` and drew each connector from `parent.x + 160`, so a label wider than the slot ran
 * into its neighbour and every line started somewhere inside the box it claimed to leave — visible on its
 * own demo, where `structured editor` is wider than the gap. Column widths therefore come from the widest
 * card on each level, and a link runs from the parent's right edge to the child's left edge.
 *
 * The layout produces each row's two strings by taking the name from the document and asking the caller for
 * the value text, then hands the same row object to the caller's measure function — so the width a card is
 * given is the width of the text it will actually paint, handle, colour chip and all.
 */
import type { JsonNode, JsonPath } from './types';
import { pathKey } from './types';

/** One line inside a card. */
export interface MapRow {
    node: JsonNode
    /** The member's name as the document gives it: a key, or the index inside an array. */
    key: string
    /** A scalar's own text, or a container's summary. */
    value: string
    /** `key : value` — the text the card is measured by. A nameless row (the `+N` line) is just its value. */
    label: string
    /** A branch row is one the reader can fold: it has, or would have, cards hanging off it. */
    branch: boolean
    /**
     * The cards this row reaches: one for an object member, several for an array of containers, none for a
     * scalar or for a branch that is folded shut.
     */
    cards: MapSlot[]
    /** This member's own path, which is not any card's path when the row is folded or promoted. */
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
    /** The row the line leaves from, so a four-row card's branches do not share a start point. */
    row: MapRow
    to: MapSlot
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
     * `hidden` is how many of that member's own children the drawing left out, which the value text has to
     * name — a card showing three of nine rows has to say so, or the reader counts three.
     */
    valueFor: (node: JsonNode, hidden: number) => string
    /** Width in canvas units for one row's content, before the card's padding. */
    measure: (row: MapRow) => number
    /**
     * Which members the drawing shows at all.
     *
     * A filter is the same idea as a fold — the picture is a chosen subset of the document — so it belongs
     * here rather than in the painter, where it would have to re-derive paths the layout already knows.
     * Omit it and everything is kept.
     */
    keep?: (node: JsonNode, path: JsonPath) => boolean
    rowHeight?: number
    cardPadding?: number
    levelGap?: number
    siblingGap?: number
    padding?: number
    maxNodes?: number
    maxChildren?: number
    /**
     * Whether an array of containers is drawn as one row fanning out into a card per element.
     *
     * Off, such an array gets a card of its own listing one row per element, which is one level deeper and
     * reads as a table rather than as a list.
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
 * A folded card lists no rows and spawns no children, which is what keeps a 20 000-node document drawable:
 * the ceilings are applied to what is actually on screen, not to the tree.
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
    const keep = options.keep;
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

    const rowFor = (node: JsonNode, name: string, hidden: number, path: JsonPath, cards: MapSlot[]): MapRow => {
        const value = options.valueFor(node, hidden);
        return {
            node,
            key: name,
            value,
            label: name ? `${name}: ${value}` : value,
            branch: isContainer(node),
            cards,
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
        slot.rows.push({ node: slot.node, key: '', value: text, label: text, branch: false, cards: [], path: slot.path, y: 0, more: true });
    };

    const fill = (slot: MapSlot): void => {
        const node = slot.node;
        const children = node.children;
        if (node.collapsed || !children || children.length === 0)
            return;
        // One pass, indexed by position: filtering and then looking each survivor up again would cost a
        // million comparisons on a flat 1200-key object just to draw forty rows.
        const kept: number[] = [];
        children.forEach((child, index) => {
            if (!keep || keep(child, [...slot.path, node.kind === 'array' ? index : (child.key ?? '')]))
                kept.push(index);
        });
        let listed = 0;
        kept.forEach(index => {
            const child = children[index]!;
            const segment = node.kind === 'array' ? String(index) : (child.key ?? '');
            const at = [...slot.path, node.kind === 'array' ? index : segment];
            if (listed >= maxChildren)
                return;
            listed++;
            if (!isContainer(child)) {
                slot.rows.push(rowFor(child, segment, 0, at, []));
                return;
            }
            const elements = child.children ?? [];
            const overflow = Math.max(0, elements.length - maxChildren);
            if (child.collapsed) {
                // Folded: the row keeps its handle and its name, and nothing hangs off it.
                slot.rows.push(rowFor(child, segment, overflow, at, []));
                return;
            }
            if (promoteArrays && promotable(child)) {
                // One row for the array, one card per element, all fanning from that row. The array's own
                // name is what every connector says, which is how three cards read as one list.
                const cards: MapSlot[] = [];
                let shown = 0;
                elements.forEach((element, position) => {
                    if (keep && !keep(element, [...at, position]))
                        return;
                    if (shown >= maxChildren)
                        return;
                    shown++;
                    const card = element.collapsed ? null : open(element, [...at, position], slot.depth + 1, slot, segment);
                    if (card) {
                        cards.push(card);
                        fill(card);
                    }
                });
                slot.rows.push(rowFor(child, segment, Math.max(0, elements.length - shown), at, cards));
                return;
            }
            const card = open(child, at, slot.depth + 1, slot, segment);
            slot.rows.push(rowFor(child, segment, overflow, at, card ? [card] : []));
            if (card)
                fill(card);
        });
        pushMore(slot, Math.max(0, kept.length - maxChildren) + (children.length - kept.length));
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
        // A folded or empty card still has to hold its own line, so it is never zero tall.
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
        const cards = slot.rows.flatMap(row => row.cards);
        if (cards.length === 0) {
            slot.y = cursor + slot.h / 2;
            cursor = slot.y + slot.h / 2 + siblingGap;
            return { center: slot.y, bottom: cursor };
        }
        const placed = cards.map(card => place(card));
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
            for (const card of row.cards) {
                links.push({
                    from: slot,
                    row,
                    to: card,
                    label: card.edgeLabel,
                    x: (slot.x + slot.w + card.x) / 2,
                    y: (row.y + card.y) / 2,
                });
            }
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
 * The bezier a connector draws: out of the parent card's right edge at the row that names the member, into
 * the child card's left edge at its own center. Leaving from the *row* rather than the card center is what
 * lets a reader follow which line of a five-row card a card on the right came from.
 */
export function mapLinkPath(link: MapLink): string {
    const x1 = link.from.x + link.from.w;
    const y1 = link.row.y;
    const x2 = link.to.x;
    const y2 = link.to.y;
    const bend = Math.max(18, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}
