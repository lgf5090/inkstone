/**
 * UI Token Scale Generator (50 - 950, 11-step palette for Tailwind CSS / Design Systems)
 */

import { getContrastRatio } from './a11y'
import { clamp, hexToRgb, hslToRgb, normalizeHex, rgbToHex, rgbToHsl } from './spaces'
import type { TokenScaleItem, TokenScaleStep } from './types'

export const TOKEN_STEPS: readonly TokenScaleStep[] = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
]

// Target lightness and saturation modulation curves for steps 50 - 950
const STEP_CURVES: Record<TokenScaleStep, { l: number; sFactor: number }> = {
  50: { l: 96, sFactor: 0.28 },
  100: { l: 91, sFactor: 0.42 },
  200: { l: 82, sFactor: 0.65 },
  300: { l: 70, sFactor: 0.8 },
  400: { l: 58, sFactor: 0.95 },
  500: { l: 47, sFactor: 1.0 },
  600: { l: 38, sFactor: 1.05 },
  700: { l: 29, sFactor: 1.05 },
  800: { l: 20, sFactor: 1.0 },
  900: { l: 14, sFactor: 0.95 },
  950: { l: 9, sFactor: 0.9 },
}

/**
 * Generates an 11-step token scale from any seed color
 */
export function generateTokenScale(seedHex: string): TokenScaleItem[] {
  const norm = normalizeHex(seedHex, true)
  const baseRgb = hexToRgb(norm)
  const baseHsl = rgbToHsl(baseRgb)

  return TOKEN_STEPS.map((step) => {
    const curve = STEP_CURVES[step]

    // Preserve hue, adjust lightness toward curve and scale saturation
    const adjustedS = clamp(Math.round(baseHsl.s * curve.sFactor), 4, 100)
    // Blend base lightness slightly around 500
    let targetL = curve.l
    if (step === 500) {
      targetL = Math.round(baseHsl.l * 0.7 + curve.l * 0.3)
    }

    const rgb = hslToRgb({
      h: baseHsl.h,
      s: adjustedS,
      l: targetL,
    })
    const hex = rgbToHex(rgb, true)

    const contrastWhite = getContrastRatio(hex, '#ffffff')
    const contrastBlack = getContrastRatio(hex, '#000000')

    const textRecommended = contrastWhite >= contrastBlack ? '#ffffff' : '#000000'

    return {
      step,
      hex,
      rgb,
      contrastWhite,
      contrastBlack,
      textRecommended,
    }
  })
}

/**
 * Formats a token scale as Tailwind CSS JavaScript / TypeScript config
 */
export function formatAsTailwindConfig(paletteName: string, items: TokenScaleItem[]): string {
  const cleanName = paletteName.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'brand'
  const entries = items.map((item) => `      '${item.step}': '${item.hex}',`).join('\n')
  return `// Tailwind CSS theme extension\nmodule.exports = {\n  theme: {\n    extend: {\n      colors: {\n        '${cleanName}': {\n${entries}\n        },\n      },\n    },\n  },\n}`
}

/**
 * Formats a token scale as CSS variables
 */
export function formatAsCssVariables(paletteName: string, items: TokenScaleItem[]): string {
  const cleanName = paletteName.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'brand'
  const lines = items.map((item) => `  --color-${cleanName}-${item.step}: ${item.hex};`).join('\n')
  return `:root {\n${lines}\n}`
}
