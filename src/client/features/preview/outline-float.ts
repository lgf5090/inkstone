export interface PanelBounds {
    minLeft: number;
    minTop: number;
    maxLeft: number;
    maxTop: number;
}

export interface PanelPoint {
    left: number;
    top: number;
}

export interface PanelRatio {
    x: number;
    y: number;
}

export const FLOAT_MARGIN = 8;
export const SNAP_DISTANCE = 12;
export const PANEL_MAX_HEIGHT = 420;
export const OUTLINE_FLOAT_WIDTH = 208;

export const DEFAULT_RATIO: PanelRatio = { x: 1, y: 0 };

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function panelHeight(containerHeight: number): number {
    return Math.max(0, Math.min(PANEL_MAX_HEIGHT, containerHeight - FLOAT_MARGIN * 2));
}

export function panelBounds(containerWidth: number, containerHeight: number, panelWidth: number, height: number): PanelBounds {
    const minLeft = FLOAT_MARGIN;
    const minTop = FLOAT_MARGIN;
    return {
        minLeft,
        minTop,
        maxLeft: Math.max(minLeft, containerWidth - panelWidth - FLOAT_MARGIN),
        maxTop: Math.max(minTop, containerHeight - height - FLOAT_MARGIN),
    };
}

export function clampToBounds(point: PanelPoint, bounds: PanelBounds): PanelPoint {
    return {
        left: clamp(point.left, bounds.minLeft, bounds.maxLeft),
        top: clamp(point.top, bounds.minTop, bounds.maxTop),
    };
}

/** A pane too narrow to move the panel keeps the saved ratio on that axis rather than discarding where it was parked. */
export function resolvePosition(ratio: PanelRatio, bounds: PanelBounds): PanelPoint {
    return {
        left: bounds.minLeft + clamp(ratio.x, 0, 1) * (bounds.maxLeft - bounds.minLeft),
        top: bounds.minTop + clamp(ratio.y, 0, 1) * (bounds.maxTop - bounds.minTop),
    };
}

export function toRatio(point: PanelPoint, bounds: PanelBounds, fallback: PanelRatio): PanelRatio {
    const constrained = clampToBounds(point, bounds);
    return {
        x: bounds.maxLeft === bounds.minLeft ? clamp(fallback.x, 0, 1) : (constrained.left - bounds.minLeft) / (bounds.maxLeft - bounds.minLeft),
        y: bounds.maxTop === bounds.minTop ? clamp(fallback.y, 0, 1) : (constrained.top - bounds.minTop) / (bounds.maxTop - bounds.minTop),
    };
}

export type SnappedEdge = 'min' | 'max' | null;

export function snapToBounds(point: PanelPoint, bounds: PanelBounds): { position: PanelPoint; edgeX: SnappedEdge; edgeY: SnappedEdge } {
    const constrained = clampToBounds(point, bounds);
    const axis = (value: number, minimum: number, maximum: number) => {
        if (value - minimum <= SNAP_DISTANCE) return { value: minimum, edge: 'min' as SnappedEdge };
        if (maximum - value <= SNAP_DISTANCE) return { value: maximum, edge: 'max' as SnappedEdge };
        return { value, edge: null as SnappedEdge };
    };
    const x = axis(constrained.left, bounds.minLeft, bounds.maxLeft);
    const y = axis(constrained.top, bounds.minTop, bounds.maxTop);
    return { position: { left: x.value, top: y.value }, edgeX: x.edge, edgeY: y.edge };
}

export const DRAG_THRESHOLD = 6;

/** The collapsed trigger's diameter, shared by its bounds and its own box. */
export const CIRCLE_SIZE = 36;

export interface AnchorRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Where a hover popover lands beside the row that called it.
 * A row against the window edge gets the other side; the vertical clamp keeps it on screen
 * even when the popover is taller than the space below.
 */
export function popoverPosition(anchor: AnchorRect, box: { width: number; height: number }, viewport: { width: number; height: number }, side: 'left' | 'right', gap = 8, margin = 8): { top: number; left: number } {
    const fitsLeft = anchor.left - gap - box.width >= margin;
    const fitsRight = anchor.left + anchor.width + gap + box.width <= viewport.width - margin;
    const preferRight = side === 'right';
    // Keep the reader's side whenever it has room; cross over only when it does not.
    const flipNeeded = preferRight ? !fitsRight : !fitsLeft;
    const useRight = preferRight !== flipNeeded;
    return {
        left: clamp(useRight ? anchor.left + anchor.width + gap : anchor.left - gap - box.width, margin, Math.max(margin, viewport.width - box.width - margin)),
        top: clamp(anchor.top, margin, Math.max(margin, viewport.height - box.height - margin)),
    };
}

export interface PanelCorner extends PanelRatio {
    id: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

/** The four parked positions the panel header offers, in the order a reader scans them. */
export const CORNERS: readonly PanelCorner[] = [
    { id: 'top-left', x: 0, y: 0 },
    { id: 'top-right', x: 1, y: 0 },
    { id: 'bottom-left', x: 0, y: 1 },
    { id: 'bottom-right', x: 1, y: 1 },
];

/** The corner a saved ratio sits on, or `null` for a position the reader dragged by hand. */
export function cornerFor(ratio: PanelRatio, tolerance = 0.02): PanelCorner | null {
    return CORNERS.find((corner) => Math.abs(corner.x - clamp(ratio.x, 0, 1)) <= tolerance
        && Math.abs(corner.y - clamp(ratio.y, 0, 1)) <= tolerance) ?? null;
}

export function passedThreshold(deltaX: number, deltaY: number, threshold = DRAG_THRESHOLD): boolean {
    return Math.hypot(deltaX, deltaY) >= threshold;
}
