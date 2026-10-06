/**
 * The account's accent, read for the things that draw outside CSS.
 *
 * The pure oklch math lives in ./palette; this is the half that touches the document, kept apart so the
 * math stays testable without a DOM. Every call re-reads: a chart's colours must follow the accent the
 * account has now, not the one that happened to be set when the module was first loaded.
 */
import { PALETTE_SIZE, accentPalette, parseOklch, type Oklch } from './palette';

/** cinnabar, the accent the token layer ships with. Only reached with no stylesheet in reach. */
const FALLBACK_ACCENT: Oklch = { l: 0.49, c: 0.15, h: 30 };

function token(name: string, fallback: string): string {
    if (typeof document === 'undefined')
        return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function chartAccent(): Oklch {
    return parseOklch(token('--accent', '')) ?? FALLBACK_ACCENT;
}

export function chartPalette(dark: boolean): string[] {
    return accentPalette(chartAccent(), PALETTE_SIZE, dark);
}

/**
 * What the colours a chart would draw with currently depend on, in a string short enough to live in a
 * cache key. The accent is switchable per account and the palette leans on the light mode, so a key that
 * carried only the light mode would let a chart keep colours it read before the accent moved.
 *
 * The attribute is what the key reads rather than the resolved property: `--accent` is written by no rule
 * but `:root[data-accent][data-theme]`, and the key is taken once per block on every preview pass, where
 * resolving a style would force a recalculation the page otherwise would not have done.
 */
export function chartPaletteKey(dark: boolean): string {
    if (typeof document === 'undefined')
        return `${dark ? 'd' : 'l'}:`;
    return `${dark ? 'd' : 'l'}:${document.documentElement.dataset.accent ?? ''}`;
}
