import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RATIO,
    FLOAT_MARGIN,
    SNAP_DISTANCE,
    clampToBounds,
    passedThreshold,
    panelBounds,
    panelHeight,
    resolvePosition,
    snapToBounds,
    toRatio,
} from './outline-float';

const bounds = { minLeft: 8, minTop: 8, maxLeft: 500, maxTop: 300 };

describe('panelBounds', () => {
    it('leaves a margin on every side', () => {
        expect(panelBounds(800, 600, 200, 400)).toEqual({
            minLeft: FLOAT_MARGIN,
            minTop: FLOAT_MARGIN,
            maxLeft: 800 - 200 - FLOAT_MARGIN,
            maxTop: 600 - 400 - FLOAT_MARGIN,
        });
    });

    it('refuses to invert when the panel is wider than the pane', () => {
        const tight = panelBounds(120, 100, 400, 500);
        expect(tight.maxLeft).toBe(tight.minLeft);
        expect(tight.maxTop).toBe(tight.minTop);
    });
});

describe('panelHeight', () => {
    it('caps a tall pane at the maximum panel height', () => {
        expect(panelHeight(2000)).toBe(420);
    });

    it('shrinks with a short pane', () => {
        expect(panelHeight(200)).toBe(200 - FLOAT_MARGIN * 2);
    });

    it('never goes negative', () => {
        expect(panelHeight(4)).toBe(0);
    });
});

describe('resolvePosition and toRatio', () => {
    it('maps the corners of the ratio space onto the travel bounds', () => {
        expect(resolvePosition({ x: 0, y: 0 }, bounds)).toEqual({ left: 8, top: 8 });
        expect(resolvePosition({ x: 1, y: 1 }, bounds)).toEqual({ left: 500, top: 300 });
    });

    it('clamps a stored ratio pushed outside zero to one', () => {
        expect(resolvePosition({ x: -3, y: 9 }, bounds)).toEqual({ left: 8, top: 300 });
    });

    it('round-trips a position through a ratio', () => {
        const point = { left: 240, top: 120 };
        expect(resolvePosition(toRatio(point, bounds, DEFAULT_RATIO), bounds)).toEqual(point);
    });

    it('keeps the saved ratio on an axis the pane cannot travel', () => {
        const locked = { minLeft: 8, minTop: 8, maxLeft: 8, maxTop: 300 };
        const ratio = toRatio({ left: 400, top: 100 }, locked, { x: 0.75, y: 0 });
        expect(ratio.x).toBe(0.75);
        expect(ratio.y).not.toBe(0);
    });
});

describe('snapToBounds', () => {
    it('pulls an axis onto the near edge and names it', () => {
        expect(snapToBounds({ left: 8 + SNAP_DISTANCE, top: 150 }, bounds)).toEqual({
            position: { left: 8, top: 150 },
            edgeX: 'min',
            edgeY: null,
        });
        expect(snapToBounds({ left: 300, top: 300 - 3 }, bounds).edgeY).toBe('max');
    });

    it('leaves a panel floating in the middle alone', () => {
        const result = snapToBounds({ left: 250, top: 150 }, bounds);
        expect(result.position).toEqual({ left: 250, top: 150 });
        expect(result.edgeX).toBeNull();
        expect(result.edgeY).toBeNull();
    });

    it('snaps whichever of the two edges is closer', () => {
        expect(snapToBounds({ left: 495, top: 150 }, bounds).edgeX).toBe('max');
        expect(snapToBounds({ left: 12, top: 150 }, bounds).edgeX).toBe('min');
    });

    it('clamps a point beyond the bounds before snapping', () => {
        expect(snapToBounds({ left: 9000, top: -9000 }, bounds).position).toEqual({ left: 500, top: 8 });
    });
});

describe('clampToBounds', () => {
    it('keeps an in-range point untouched', () => {
        expect(clampToBounds({ left: 100, top: 100 }, bounds)).toEqual({ left: 100, top: 100 });
    });

    it('reins in a point dragged past an edge', () => {
        expect(clampToBounds({ left: -50, top: 9999 }, bounds)).toEqual({ left: 8, top: 300 });
    });
});

describe('passedThreshold', () => {
    it('treats a short press as a click', () => {
        expect(passedThreshold(2, 2)).toBe(false);
        expect(passedThreshold(0, 0)).toBe(false);
    });

    it('starts dragging once the pointer travels far enough', () => {
        expect(passedThreshold(6, 0)).toBe(true);
        expect(passedThreshold(0, -7)).toBe(true);
    });

    it('measures the diagonal, not each axis', () => {
        expect(passedThreshold(4, 4)).toBe(false);
        expect(passedThreshold(5, 5)).toBe(true);
    });
});
