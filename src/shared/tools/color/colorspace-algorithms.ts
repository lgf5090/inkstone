/**
 * Algorithmic Palette Generation Engine (inspired by MyColorSpace - mycolor.space)
 * Generates 8-10 high-utility palettes purely through CIELAB, OKLab and HSL mathematics.
 */

import {
  clamp,
  hexToRgb,
  hslToRgb,
  normalizeHex,
  rgbToHex,
  rgbToHsl,
  rgbToLab,
  labToRgb,
  rgbToOklab,
  oklabToRgb,
} from './spaces'
import type { AlgorithmicPalette } from './types'

function adjustHsl(
  hex: string,
  dHue: number,
  dSat: number,
  dLum: number,
): string {
  const rgb = hexToRgb(hex)
  const hsl = rgbToHsl(rgb)
  const h = (hsl.h + dHue + 3600) % 360
  const s = clamp(hsl.s + dSat, 0, 100)
  const l = clamp(hsl.l + dLum, 0, 100)
  return rgbToHex(hslToRgb({ h, s, l }), true)
}

function adjustLab(
  hex: string,
  dL: number,
  da: number,
  db: number,
): string {
  const rgb = hexToRgb(hex)
  const lab = rgbToLab(rgb)
  const nextLab = {
    l: clamp(lab.l + dL, 5, 95),
    a: clamp(lab.a + da, -120, 120),
    b: clamp(lab.b + db, -120, 120),
  }
  return rgbToHex(labToRgb(nextLab), true)
}

function adjustOklab(
  hex: string,
  dL: number,
  da: number,
  db: number,
): string {
  const rgb = hexToRgb(hex)
  const oklab = rgbToOklab(rgb)
  const nextOklab = {
    l: clamp(oklab.l + dL, 0.05, 0.98),
    a: clamp(oklab.a + da, -0.4, 0.4),
    b: clamp(oklab.b + db, -0.4, 0.4),
  }
  return rgbToHex(oklabToRgb(nextOklab), true)
}

/**
 * 1. Generic Gradient (Smooth gradient steps - 6 colors)
 */
function makeGenericGradient(baseHex: string): string[] {
  const steps = 6
  const colors: string[] = []
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    // Blend from lighter warm/cool tint to base, then deep shade
    const dL = (0.5 - t) * 0.45
    const da = Math.sin(t * Math.PI) * 0.04
    const db = Math.cos(t * Math.PI) * 0.04
    colors.push(adjustOklab(baseHex, dL, da, db))
  }
  return colors
}

/**
 * 2. Matching Gradient (Harmonic gradient steps - 5 colors)
 */
function makeMatchingGradient(baseHex: string): string[] {
  const colors: string[] = []
  const offsets = [-20, -10, 0, 10, 20]
  for (let i = 0; i < offsets.length; i++) {
    const dH = offsets[i]
    const dL = (offsets[i] / 20) * 12
    colors.push(adjustHsl(baseHex, dH, 0, dL))
  }
  return colors
}

/**
 * 3. Spot Palette (Spotlight high contrast palette - 1 primary + 3 accents)
 */
function makeSpotPalette(baseHex: string): string[] {
  const rgb = hexToRgb(baseHex)
  const hsl = rgbToHsl(rgb)
  const c1 = baseHex
  // Complementary high-saturation spot
  const c2 = adjustHsl(baseHex, 180, 25, 10)
  // Accent golden/warm or neon spot
  const c3 = adjustHsl(baseHex, hsl.h > 180 ? -120 : 120, 20, 15)
  // Crisp dark/light companion
  const c4 = adjustHsl(baseHex, 60, -10, hsl.l > 50 ? -30 : 30)
  return [c1, c2, c3, c4]
}

/**
 * 4. Classy Palette (Muted classy Morandi low-saturation palette - 4 colors)
 */
function makeClassyPalette(baseHex: string): string[] {
  const c1 = adjustHsl(baseHex, 0, -35, 15)
  const c2 = adjustHsl(baseHex, 35, -40, 5)
  const c3 = adjustHsl(baseHex, -40, -45, -10)
  const c4 = adjustHsl(baseHex, 160, -50, 12)
  return [baseHex, c1, c2, c3, c4]
}

/**
 * 5. Cube Palette (CIELAB color space 3D cube cut palette - 4 colors)
 */
function makeCubePalette(baseHex: string): string[] {
  const c1 = baseHex
  const c2 = adjustLab(baseHex, 15, -25, 20)
  const c3 = adjustLab(baseHex, -15, 20, -30)
  const c4 = adjustLab(baseHex, 8, 30, 25)
  return [c1, c2, c3, c4]
}

/**
 * 6. Shade Palette (Monochromatic lightness scale - 6 colors)
 */
function makeShadePalette(baseHex: string): string[] {
  const rgb = hexToRgb(baseHex)
  const hsl = rgbToHsl(rgb)
  const levels = [88, 72, 56, 42, 28, 16]
  return levels.map((l) => rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l }), true))
}

/**
 * 7. Highlight Palette (UI highlight accents - 4 colors)
 */
function makeHighlightPalette(baseHex: string): string[] {
  const c1 = baseHex
  const c2 = adjustHsl(baseHex, 45, 30, 18)
  const c3 = adjustHsl(baseHex, -50, 25, 14)
  const c4 = adjustHsl(baseHex, 180, 35, 10)
  return [c1, c2, c3, c4]
}

/**
 * 8. Dust Palette (Vintage weathered dust palette - 5 colors)
 */
function makeDustPalette(baseHex: string): string[] {
  const c1 = baseHex
  const c2 = adjustHsl(baseHex, 20, -50, 8)
  const c3 = adjustHsl(baseHex, -25, -55, 18)
  const c4 = adjustHsl(baseHex, 140, -60, -8)
  const c5 = adjustHsl(baseHex, 200, -65, 22)
  return [c1, c2, c3, c4, c5]
}

/**
 * Generates all MyColorSpace algorithmic palettes for a given base color
 */
export function generateAlgorithmicPalettes(baseHex: string): AlgorithmicPalette[] {
  const norm = normalizeHex(baseHex, true)

  return [
    {
      id: 'generic_gradient',
      name: 'Generic Gradient',
      description: 'Perceptually uniform OKLab transition, ideal for backgrounds, illustrations and smooth gradients',
      colors: makeGenericGradient(norm),
    },
    {
      id: 'matching_gradient',
      name: 'Matching Gradient',
      description: 'Neighboring hue micro-adjustments for subtle cards, buttons and background accents',
      colors: makeMatchingGradient(norm),
    },
    {
      id: 'spot',
      name: 'Spot Palette',
      description: '1 primary base + 3 striking high-contrast spotlight accents for buttons and callouts',
      colors: makeSpotPalette(norm),
    },
    {
      id: 'classy',
      name: 'Classy Palette',
      description: 'Elegant desaturated Morandi tones with understated sophistication',
      colors: makeClassyPalette(norm),
    },
    {
      id: 'cube',
      name: 'Cube Palette',
      description: 'Derived from CIELAB color space 3D cube cuts for balanced spatial color harmony',
      colors: makeCubePalette(norm),
    },
    {
      id: 'shade',
      name: 'Shade Palette',
      description: 'Pure hue-locked lightness step progression for typography and monochromatic systems',
      colors: makeShadePalette(norm),
    },
    {
      id: 'highlight',
      name: 'Highlight Palette',
      description: 'High-energy, crisp contrast pairings tailored for metrics, tags and badges',
      colors: makeHighlightPalette(norm),
    },
    {
      id: 'dust',
      name: 'Dust Palette',
      description: 'Vintage earthy grays and weathered pastels suited for muted typography and retro prints',
      colors: makeDustPalette(norm),
    },
  ]
}
