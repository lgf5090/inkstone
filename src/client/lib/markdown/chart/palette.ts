/**
 * Chart colours derived from the account's accent.
 *
 * A chart library's default palette is a rainbow chosen by nobody for the benefit of everybody, and it
 * sits badly against a page whose whole identity is one accent. So the series colours are built from
 * that accent instead: the accent itself, its own tint and shade, and then the two hues a designed
 * group is made of — the complement taken as a saturated spot, and a lean toward the neighbour of the
 * complement. That is the shape the reference groups have (a slate base, its lighter and darker
 * siblings, one gold spot, one mauve), and it keeps a multi-series chart reading as this page.
 *
 * oklch is where the arithmetic happens, because the tokens are written in it and its lightness axis
 * is perceptual (a ladder of equal steps *looks* like equal steps, which hsl does not give).
 *
 * The answer is sRGB hex, though, and that is not a style choice: the drawing engine parses the colours
 * it is handed — it lifts one for a hover state and mixes one for a translucent fill — and a colour it
 * cannot parse falls back to black or transparent rather than to the browser's own painter. Hex is what
 * every path reads the same way.
 */
export interface Oklch {
    l: number
    c: number
    h: number
}

/** `oklch(49% 0.15 30)` and `oklch(0.49 0.15 30 / 0.6)` both appear in the token layer. */
const OKLCH_RE = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+|%))?\s*\)$/i;

export function parseOklch(color: string): Oklch | null {
    const match = OKLCH_RE.exec(color.trim());
    if (!match)
        return null;
    const rawL = Number(match[1]);
    const l = match[2] === '%' ? rawL / 100 : rawL;
    return { l, c: Number(match[3]), h: Number(match[4]) };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function toEncoded(channel: number): number {
    return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** The sRGB channels of an oklch colour, unrounded and possibly outside 0..1. */
function channels({ l, c, h }: Oklch): number[] {
    const radians = (h * Math.PI) / 180;
    const a = c * Math.cos(radians);
    const b = c * Math.sin(radians);
    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
    const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
    return [
        toEncoded(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
        toEncoded(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
        toEncoded(-0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S),
    ];
}

function inGamut(rgb: number[]): boolean {
    return rgb.every((channel) => channel >= -0.001 && channel <= 1.001);
}

function toHex(rgb: number[]): string {
    const part = (channel: number) => Math.round(clamp(channel, 0, 1) * 255).toString(16).padStart(2, '0');
    return `#${rgb.map(part).join('')}`;
}

/**
 * The colour as CSS can paint it and as the chart library can read it.
 *
 * A colour this side of the accent's chroma is out of sRGB for some hues — a saturated amber at the
 * lightness a chart needs is one of them — and the honest mapping is the *same colour with less chroma*,
 * not the same chroma clipped to the channel edges, which shifts the hue. So chroma is walked down
 * until the result fits, and only the last step is clamped to the edges.
 */
export function toRgb(color: Oklch): string {
    const l = clamp(color.l, 0, 1);
    const h = ((color.h % 360) + 360) % 360;
    const full = channels({ l, c: Math.max(0, color.c), h });
    if (inGamut(full))
        return toHex(full);
    let low = 0;
    let high = Math.max(0, color.c);
    for (let step = 0; step < 12; step++) {
        const middle = (low + high) / 2;
        if (inGamut(channels({ l, c: middle, h })))
            low = middle;
        else
            high = middle;
    }
    return toHex(channels({ l, c: low, h }));
}

/**
 * One stop of the group: where in the usable lightness band it sits, how far off the accent's hue it
 * leans, and what it does to the accent's chroma. `spot` is the complement at a chroma of its own — a
 * designed group keeps one saturated contrast even when the accent is a grey, which is what the
 * reference palettes do with a slate base and a gold spot.
 */
interface Stop {
    position: number
    hue: number
    chroma: number
    /** The spot's floor, so a grey accent still gets a colour rather than a second grey. */
    floor?: number
}

const STOPS: Stop[] = [
    { position: 0, hue: 0, chroma: 1 },
    { position: 0.92, hue: 0, chroma: 0.95 },
    { position: 0.62, hue: 174, chroma: 1, floor: 0.13 },
    { position: 0.18, hue: 0, chroma: 1.05 },
    { position: 0.44, hue: 103, chroma: 1.15 },
    { position: 0.30, hue: 168, chroma: 0.62, floor: 0.07 },
    { position: 0.86, hue: 222, chroma: 0.8 },
    { position: 0.10, hue: 40, chroma: 0.9 },
    { position: 0.78, hue: 103, chroma: 0.85 },
    { position: 0.98, hue: 182, chroma: 0.42, floor: 0.055 },
];

/** The band a series colour may occupy, so nothing goes invisible against the page. */
const BAND = { light: [0.36, 0.80], dark: [0.55, 0.90] } as const;

/** Where a stop may be re-placed when its own slot would land on a sibling of the same hue. */
const LADDER = [0.02, 0.14, 0.26, 0.38, 0.5, 0.62, 0.74, 0.86, 0.98];

/** Two stops this far apart in hue are different colours however light they are; further apart, they are not. */
const SAME_HUE_DEGREES = 30;

/** Stops of one hue need this much lightness between them to be told apart in a legend. */
const MIN_LIGHTNESS_GAP = 0.08;

function hueDistance(a: number, b: number): number {
    const apart = Math.abs(((a - b) % 360) + 360) % 360;
    return Math.min(apart, 360 - apart);
}

/**
 * Where this stop sits in the band: its own slot when nothing of the same hue is already standing near
 * it, and otherwise the free slot furthest from those. Series one is the accent at its own lightness, so
 * a pale accent and a deep one both move the whole group around them rather than colliding with it.
 */
function placeStop(stop: Stop, placed: { l: number, h: number }[], floor: number, ceiling: number): number {
    const own = floor + (ceiling - floor) * stop.position;
    const kin = placed.filter((entry) => hueDistance(entry.h, stop.hue) <= SAME_HUE_DEGREES);
    if (kin.length === 0)
        return own;
    let best = own;
    let bestGap = -1;
    for (const position of [stop.position, ...LADDER]) {
        const candidate = floor + (ceiling - floor) * position;
        const gap = Math.min(...kin.map((entry) => Math.abs(entry.l - candidate)));
        if (gap > bestGap + 1e-9 && gap >= MIN_LIGHTNESS_GAP) {
            bestGap = gap;
            best = candidate;
        }
    }
    return best;
}

/**
 * A categorical palette anchored on `accent`: the first entry is the accent exactly, and the rest are
 * the group it belongs to — its own tint and shade, a saturated spot at the complement, a lean toward
 * the complement's neighbour, and pale siblings of each.
 *
 * `dark` picks the band, because a colour that separates cleanly on paper can sit inside the background
 * on a dark canvas.
 */
export function accentPalette(accent: Oklch, count: number, dark: boolean): string[] {
    const [floor, ceiling] = dark ? BAND.dark : BAND.light;
    const anchor = clamp(accent.l, floor, ceiling);
    const placed: { l: number, h: number }[] = [];
    return Array.from({ length: count }, (_, index) => {
        const stop = STOPS[index % STOPS.length]!;
        const cycle = Math.floor(index / STOPS.length);
        const hue = accent.h + stop.hue + cycle * 180;
        const l = index === 0 ? anchor : placeStop(stop, placed, floor, ceiling);
        // A dark canvas washes colour out, so the chroma is held up a little rather than copied flat.
        const c = Math.max(stop.floor ?? 0, accent.c * stop.chroma * (dark ? 1.06 : 1));
        placed.push({ l, h: stop.hue });
        return toRgb({ l, c, h: hue });
    });
}

/** How many series a palette is generated for. The engine cycles past the end; ten covers a real chart. */
export const PALETTE_SIZE = 10;
