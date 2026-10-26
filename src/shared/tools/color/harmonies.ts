/**
 * Classical color harmony algorithms (Complementary, Triadic/Split-Complementary, Analogous, Tetradic/Intermediate)
 */

import { hexToRgb, rgbToHex, rgbToHsl, hslToRgb, normalizeHex } from './spaces'
import type { ColorHarmonyGroup } from './types'

function shiftHue(hex: string, deltaDeg: number): string {
  const rgb = hexToRgb(hex)
  const hsl = rgbToHsl(rgb)
  const nextH = (hsl.h + deltaDeg + 3600) % 360
  const nextRgb = hslToRgb({ ...hsl, h: nextH })
  return rgbToHex(nextRgb, true)
}

/**
 * Returns all color harmonies for a given base color
 */
export function getHarmonies(baseHex: string): ColorHarmonyGroup[] {
  const norm = normalizeHex(baseHex, true)

  // 1. Complementary (180°)
  const comp = shiftHue(norm, 180)

  // 2. Triadic / Split-Complementary (120°, 240° & 150°, 210°)
  const triadic1 = shiftHue(norm, 120)
  const triadic2 = shiftHue(norm, 240)

  // 3. Analogous (±30°, ±15°)
  const anal1 = shiftHue(norm, -30)
  const anal2 = shiftHue(norm, 30)
  const anal3 = shiftHue(norm, -15)
  const anal4 = shiftHue(norm, 15)

  // 4. Tetradic / Intermediate (±60°, ±90°)
  const tetra1 = shiftHue(norm, 90)
  const tetra2 = shiftHue(norm, 180)
  const tetra3 = shiftHue(norm, 270)

  const inter1 = shiftHue(norm, 60)
  const inter2 = shiftHue(norm, 120)
  const inter3 = shiftHue(norm, 180)

  return [
    {
      type: 'complementary',
      label: 'Complementary',
      description: 'Opposite 180° colors on the wheel, creating maximum visual energy and contrast',
      colors: [norm, comp],
    },
    {
      type: 'triadic',
      label: 'Triadic',
      description: 'Equilateral triangle (120° / 240°) spacing balancing vibrant diversity and harmony',
      colors: [norm, triadic1, triadic2],
    },
    {
      type: 'analogous',
      label: 'Analogous',
      description: 'Adjacent ±30° neighboring colors creating calm, serene and unified transitions',
      colors: [anal1, anal3, norm, anal4, anal2],
    },
    {
      type: 'tetradic',
      label: 'Tetradic',
      description: '90° rectangle scheme offering rich variety and layered hierarchy',
      colors: [norm, tetra1, tetra2, tetra3],
    },
    {
      type: 'split_complementary',
      label: 'Split-Complementary',
      description: 'Base color combined with ±30° flanks of its complement (150° / 210°)',
      colors: [norm, shiftHue(norm, 150), shiftHue(norm, 210)],
    },
    {
      type: 'intermediate',
      label: 'Accent Interval',
      description: '60° step intervals for rhythmic accents and stepped progressions',
      colors: [norm, inter1, inter2, inter3],
    },
  ]
}
