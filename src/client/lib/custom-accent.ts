import { getRelativeLuminance } from '@shared/tools/color/a11y'
import { hexToRgb, oklabToRgb, rgbToHex, rgbToOklab } from '@shared/tools/color/spaces'
import type { RgbColor } from '@shared/tools/color/types'

/**
 * A reader's own colour, made into a working accent.
 *
 * The interface paints text and icons on `--accent`, on a 14% and a 7% wash of it, and on surfaces under that
 * wash. A colour picked for how it *looks* is not automatically readable in any of those places — the seven
 * shipped accents each needed a hand-tuned `--accent-on-soft` for exactly that reason — so the custom one is
 * walked until it clears AA instead of being written in as picked.
 */

/** The floor `AGENTS.md` rule 13 sets for body text. */
const AA_NORMAL = 4.5

/**
 * The surfaces an accent wash can land on, as `tests/accent-on-soft-contrast.test.ts` enumerates them.
 *
 * The sunken and raised plates are here because the navigation sidebar paints its selected row on
 * `--bg-sunken`: a guarantee that walked only the three lighter surfaces let a shipped accent sit at 4.47:1
 * on the one surface a real reader looks at.
 */
const SOFT_SURFACES = ['--bg-surface', '--bg-inset', '--bg-base', '--bg-sunken', '--bg-raised'] as const

/** `--accent-soft` and `--accent-softer`, from tokens.css. */
const SOFT_TINTS = [0.14, 0.07]

/** Where the shipped accents sit: mid-dark on paper, mid-light on ink. */
const ACCENT_LIGHTNESS = { light: 0.55, dark: 0.72 }

/** The hover step, in the same direction each shipped accent moves. */
const ACCENT_HOVER_SHIFT = { light: -0.055, dark: 0.05 }

/**
 * The two inks the shipped cascade pairs with an accent: near-white on paper, near-ink on ink. Written in the
 * same form tokens.css uses, so a picked accent and a named one paint the same text colour.
 */
const INK_ON_ACCENT = { light: 'oklch(99% 0 0)', dark: 'oklch(16% 0.008 265)' } as const

const LIGHTNESS_STEP = 0.02
const MAX_WALK_STEPS = 50

export interface CustomAccentVars {
  '--accent': string
  '--accent-hover': string
  '--accent-contrast': string
  '--accent-on-soft': string
}

/** The surfaces arrive as whatever the cascade says — hex, `rgb()` or `oklch()`, all of which mean sRGB here. */
function parseRgbish(value: string): RgbColor | null {
  const trimmed = value.trim().toLowerCase()
  if (/^#([0-9a-f]{3,8})$/.test(trimmed)) return hexToRgb(trimmed)
  const oklch = /^oklch\(\s*([\d.]+)%?\s+([\d.-]+)\s+([\d.-]+)/.exec(trimmed)
  if (oklch) {
    const [, l, c, h] = oklch
    const rad = (Number(h) * Math.PI) / 180
    // `oklch(99% 0 0)` and `oklch(0.99 0 0)` are the same colour; `hexToRgb` would read the first as black.
    const lightness = Number(l) > 1 ? Number(l) / 100 : Number(l)
    return oklabToRgb({ l: lightness, a: Number(c) * Math.cos(rad), b: Number(c) * Math.sin(rad) })
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(trimmed)
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  return null
}

/**
 * WCAG contrast between two CSS colours, unrounded.
 *
 * `getContrastRatio` rounds to two decimals because it feeds a label, and a walk that stops on a rounded
 * figure lets 4.4949 through as 4.5 — which is what let a sub-AA `--accent-on-soft` out of the old version.
 */
function wcagRatio(foreground: string, background: string): number {
  const fg = parseRgbish(foreground)
  const bg = parseRgbish(background)
  if (!fg || !bg) throw new Error(`Cannot measure ${fg ? background : foreground} as a colour`)
  const [high, low] = [getRelativeLuminance(fg), getRelativeLuminance(bg)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

/** The three page colours an accent wash is seen against, read from the live cascade. */
export function readSoftSurfaces(root: HTMLElement = document.documentElement): string[] {
  const style = getComputedStyle(root)
  return SOFT_SURFACES.map((token) => style.getPropertyValue(token).trim()).filter((value) => parseRgbish(value) !== null)
}

function withLightness(hex: string, lightness: number): string {
  const oklab = rgbToOklab(hexToRgb(hex))
  const hue = (Math.atan2(oklab.b, oklab.a) * 180) / Math.PI
  const chroma = Math.sqrt(oklab.a * oklab.a + oklab.b * oklab.b)
  // Rebuild through sRGB rather than emitting `oklch()`: the channels clamp, so the colour returned here is
  // the colour that paints, which is what the contrast below has to be measured on.
  const l = Math.min(1, Math.max(0, lightness))
  return rgbToHex(
    oklabToRgb({
      l,
      a: chroma * Math.cos((hue * Math.PI) / 180),
      b: chroma * Math.sin((hue * Math.PI) / 180),
    }),
    true,
  )
}

/** The accent composited over a surface at the wash's alpha, as `color-mix(in oklab, ... transparent)` paints it. */
function washOver(accent: RgbColor, surface: RgbColor, alpha: number): string {
  const mix = (top: number, bottom: number) => Math.round(top * alpha + bottom * (1 - alpha))
  return rgbToHex({ r: mix(accent.r, surface.r), g: mix(accent.g, surface.g), b: mix(accent.b, surface.b) }, true)
}

/**
 * The lowest contrast the on-soft colour has anywhere it is used: the accent composited at 14% and 7% over
 * each surface the theme paints. Text sitting directly on `--accent` is `--accent-contrast`'s job, so it is
 * not part of this figure — folding it in made the walk chase a pairing the token never paints.
 */
function worstWashRatio(text: string, accent: string, surfaces: string[]): number {
  const top = parseRgbish(accent)
  const bottoms = surfaces.map(parseRgbish).filter((s): s is RgbColor => s !== null)
  if (!top || bottoms.length === 0) return Infinity
  const pairs = bottoms.flatMap((surface) => SOFT_TINTS.map((alpha) => washOver(top, surface, alpha)))
  return Math.min(...pairs.map((washed) => wcagRatio(text, washed)))
}

/**
 * The same hue and chroma as the accent, darkened (on paper) or lifted (on ink) until it carries body text
 * over every wash of the accent. The accent itself is the answer when it already clears the floor, which is
 * how the shipped `--accent-on-soft: var(--accent)` default behaves.
 */
function readableOnWash(accent: string, theme: 'light' | 'dark', surfaces: string[]): string {
  const start = rgbToOklab(hexToRgb(accent)).l
  const step = theme === 'dark' ? LIGHTNESS_STEP : -LIGHTNESS_STEP
  let best = accent
  let bestRatio = worstWashRatio(accent, accent, surfaces)
  if (bestRatio >= AA_NORMAL) return best
  for (let i = 1; i <= MAX_WALK_STEPS; i++) {
    const next = start + step * i
    if (next < 0 || next > 1) break
    const candidate = withLightness(accent, next)
    const ratio = worstWashRatio(candidate, accent, surfaces)
    if (ratio >= AA_NORMAL) return candidate
    if (ratio > bestRatio) {
      bestRatio = ratio
      best = candidate
    }
  }
  return best
}

/**
 * The accent, walked in the direction its theme reads (down on paper, up on ink) until a button label in the
 * theme's ink clears AA on it.
 *
 * `--accent-hover` is not part of the test: it always moves the *same* way the ink needs (darker under
 * near-white text, lighter under near-ink text), so an accent that carries its label already carries the
 * hovered button. That is a property of `ACCENT_HOVER_SHIFT`, and `tests/custom-accent-contrast.test.ts`
 * pins which side the hover step lands on rather than trusting it.
 */
function readableAccent(seedHex: string, theme: 'light' | 'dark'): { accent: string; hover: string; contrast: string } {
  const ink = INK_ON_ACCENT[theme]
  const step = theme === 'dark' ? LIGHTNESS_STEP : -LIGHTNESS_STEP
  const rest = ACCENT_LIGHTNESS[theme]
  let best = { l: rest, score: -1 }
  for (let i = 0; i <= MAX_WALK_STEPS; i++) {
    const l = rest + step * i
    if (l < 0 || l > 1) break
    const accent = withLightness(seedHex, l)
    const score = wcagRatio(ink, accent)
    if (score >= AA_NORMAL) return { accent, hover: withLightness(seedHex, l + ACCENT_HOVER_SHIFT[theme]), contrast: ink }
    if (score > best.score) best = { l, score }
  }
  const accent = withLightness(seedHex, best.l)
  return { accent, hover: withLightness(seedHex, best.l + ACCENT_HOVER_SHIFT[theme]), contrast: ink }
}

export function deriveCustomAccent(seedHex: string, theme: 'light' | 'dark', surfaces: string[]): CustomAccentVars {
  const { accent, hover, contrast } = readableAccent(seedHex, theme)
  return {
    '--accent': accent,
    '--accent-hover': hover,
    '--accent-contrast': contrast,
    '--accent-on-soft': readableOnWash(accent, theme, surfaces),
  }
}

const CUSTOM_VARS = ['--accent', '--accent-hover', '--accent-contrast', '--accent-on-soft'] as const

/** Paint the reader's accent, or hand the cascade back to the named themes. */
export function applyCustomAccent(root: HTMLElement, seedHex: string, theme: 'light' | 'dark'): void {
  if (!seedHex) return
  const vars = deriveCustomAccent(seedHex, theme, readSoftSurfaces(root))
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
}

export function clearCustomAccent(root: HTMLElement = document.documentElement): void {
  for (const name of CUSTOM_VARS) root.style.removeProperty(name)
}
