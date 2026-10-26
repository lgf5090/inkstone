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

  // 2. Triadic / Split-Complementary (对比色: 120°, 240° & 150°, 210°)
  const triadic1 = shiftHue(norm, 120)
  const triadic2 = shiftHue(norm, 240)

  // 3. Analogous (类似色: ±30°, ±15°)
  const anal1 = shiftHue(norm, -30)
  const anal2 = shiftHue(norm, 30)
  const anal3 = shiftHue(norm, -15)
  const anal4 = shiftHue(norm, 15)

  // 4. Tetradic / Intermediate (中差色: ±60°, ±90°)
  const tetra1 = shiftHue(norm, 90)
  const tetra2 = shiftHue(norm, 180)
  const tetra3 = shiftHue(norm, 270)

  const inter1 = shiftHue(norm, 60)
  const inter2 = shiftHue(norm, 120)
  const inter3 = shiftHue(norm, 180)

  return [
    {
      type: 'complementary',
      label: '互补色',
      description: '色轮上正相对 180° 的强烈对比色彩，带来鲜明冲击力',
      colors: [norm, comp],
    },
    {
      type: 'triadic',
      label: '对比色 (三和弦)',
      description: '色轮上呈等边三角形 (120° / 240°) 分布，兼具平衡与丰富表现力',
      colors: [norm, triadic1, triadic2],
    },
    {
      type: 'analogous',
      label: '类似色 (近邻和弦)',
      description: '色轮上相邻 ±30° 的相近色系，自然柔和、宁静统一',
      colors: [anal1, anal3, norm, anal4, anal2],
    },
    {
      type: 'tetradic',
      label: '中差色 (四元和弦)',
      description: '呈 90° 矩形分布的四元调和色阵，层次丰富多变',
      colors: [norm, tetra1, tetra2, tetra3],
    },
    {
      type: 'split_complementary',
      label: '分裂互补色',
      description: '主色搭配互补色两侧 ±30° 衍生色 (150° / 210°)，对比强烈且不失柔和',
      colors: [norm, shiftHue(norm, 150), shiftHue(norm, 210)],
    },
    {
      type: 'intermediate',
      label: '强调色阶',
      description: '以 60° 步进构建的节奏色阶',
      colors: [norm, inter1, inter2, inter3],
    },
  ]
}
