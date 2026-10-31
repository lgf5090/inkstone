/**
 * Accessibility & Color Vision Deficiencies (WCAG 2.1 Contrast & Color Blindness Simulation)
 */

import { clamp, hexToRgb, normalizeHex, rgbToHex } from './spaces'
import type { ColorBlindnessType, RgbColor, WcagContrastResult } from './types'

/**
 * Calculates WCAG 2.1 relative luminance for an RGB color
 */
export function getRelativeLuminance(rgb: RgbColor): number {
  const normalize = (v: number) => {
    const s = clamp(v, 0, 255) / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }

  const r = normalize(rgb.r)
  const g = normalize(rgb.g)
  const b = normalize(rgb.b)

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Computes the contrast ratio between two colors according to WCAG 2.1.
 * Ratio is always in the range [1, 21].
 */
export function getContrastRatio(colorA: string, colorB: string): number {
  const rgbA = hexToRgb(colorA)
  const rgbB = hexToRgb(colorB)

  const lumA = getRelativeLuminance(rgbA)
  const lumB = getRelativeLuminance(rgbB)

  const l1 = Math.max(lumA, lumB)
  const l2 = Math.min(lumA, lumB)

  const ratio = (l1 + 0.05) / (l2 + 0.05)
  return Math.round(ratio * 100) / 100
}

/**
 * Evaluates WCAG 2.1 compliance for foreground and background colors
 */
export function evaluateWcagContrast(fgHex: string, bgHex: string): WcagContrastResult {
  const ratio = getContrastRatio(fgHex, bgHex)

  const normalAa = ratio >= 4.5
  const normalAaa = ratio >= 7.0
  const largeAa = ratio >= 3.0
  const largeAaa = ratio >= 4.5
  const uiComponents = ratio >= 3.0

  let score: 'AAA' | 'AA' | 'Fail' = 'Fail'
  if (normalAaa) {
    score = 'AAA'
  } else if (normalAa) {
    score = 'AA'
  }

  return {
    ratio,
    normalAa,
    normalAaa,
    largeAa,
    largeAaa,
    uiComponents,
    score,
  }
}

/**
 * The two inks a label drawn on top of an arbitrary color may use.
 *
 * Named because the module used to pick between `text-white` and `text-zinc-900` per component, and four of
 * the six swatch surfaces picked one of them unconditionally — which put white on a near-white swatch.
 * Pure black rather than a soft near-black is what keeps the worst case above AA: the two curves cross at
 * a 4.58:1 mid-tone with black, and at 4.25:1 with anything lighter.
 */
export const TEXT_ON_LIGHT_SWATCH = '#000000' as const
export const TEXT_ON_DARK_SWATCH = '#ffffff' as const

/** One of the two swatch inks; named so a token scale can hold the same union. */
export type SwatchTextColor = typeof TEXT_ON_LIGHT_SWATCH | typeof TEXT_ON_DARK_SWATCH

/**
 * The ink with the better contrast against `hex`.
 *
 * The choice is made by ratio rather than by a luminance cutoff so the same answer comes out of the token
 * scale, the swatch labels and the color-blindness preview, which each used to carry their own rule.
 */
export function recommendedTextColor(hex: string): SwatchTextColor {
  return getContrastRatio(TEXT_ON_LIGHT_SWATCH, hex) >= getContrastRatio(TEXT_ON_DARK_SWATCH, hex)
    ? TEXT_ON_LIGHT_SWATCH
    : TEXT_ON_DARK_SWATCH
}

/**
 * 3x3 Simulation matrices for Color Vision Deficiencies (Brettel/Viénot models)
 */
const CVD_MATRICES: Record<Exclude<ColorBlindnessType, 'normal'>, number[][]> = {
  // Protanopia (Red-blind: missing L-cone)
  protanopia: [
    [0.56667, 0.43333, 0.0],
    [0.55833, 0.44167, 0.0],
    [0.0, 0.24167, 0.75833],
  ],
  // Deuteranopia (Green-blind: missing M-cone)
  deuteranopia: [
    [0.625, 0.375, 0.0],
    [0.7, 0.3, 0.0],
    [0.0, 0.3, 0.7],
  ],
  // Tritanopia (Blue-blind: missing S-cone)
  tritanopia: [
    [0.95, 0.05, 0.0],
    [0.0, 0.43333, 0.56667],
    [0.0, 0.475, 0.525],
  ],
  // Achromatopsia (Total color blindness / Monochromacy)
  achromatopsia: [
    [0.299, 0.587, 0.114],
    [0.299, 0.587, 0.114],
    [0.299, 0.587, 0.114],
  ],
}

/**
 * Simulates how a hex color appears to someone with a specific color vision deficiency
 */
export function simulateColorBlindness(hex: string, type: ColorBlindnessType): string {
  if (type === 'normal') {
    return normalizeHex(hex, true)
  }

  const rgb = hexToRgb(hex)
  const matrix = CVD_MATRICES[type]

  const r = rgb.r
  const g = rgb.g
  const b = rgb.b

  const simR = clamp(Math.round(matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b), 0, 255)
  const simG = clamp(Math.round(matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b), 0, 255)
  const simB = clamp(Math.round(matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b), 0, 255)

  return rgbToHex({ r: simR, g: simG, b: simB }, true)
}

/**
 * SVG Color Matrix values for HTML SVG filter injection
 */
export function getSvgColorMatrix(type: ColorBlindnessType): string {
  if (type === 'normal') {
    return '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0'
  }
  const m = CVD_MATRICES[type]
  return `${m[0][0]} ${m[0][1]} ${m[0][2]} 0 0  ${m[1][0]} ${m[1][1]} ${m[1][2]} 0 0  ${m[2][0]} ${m[2][1]} ${m[2][2]} 0 0  0 0 0 1 0`
}
