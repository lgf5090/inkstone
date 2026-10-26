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
 * 1. Generic Gradient (经典通用渐变阶梯 - 6 色平滑过渡)
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
 * 2. Matching Gradient (和弦平滑过渡色板 - 5 色)
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
 * 3. Spot Palette (聚光灯高对比焦点色板 - 1 主色 + 3 焦点色)
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
 * 4. Classy Palette (高雅莫兰迪低饱和色板 - 4 色)
 */
function makeClassyPalette(baseHex: string): string[] {
  const c1 = adjustHsl(baseHex, 0, -35, 15)
  const c2 = adjustHsl(baseHex, 35, -40, 5)
  const c3 = adjustHsl(baseHex, -40, -45, -10)
  const c4 = adjustHsl(baseHex, 160, -50, 12)
  return [baseHex, c1, c2, c3, c4]
}

/**
 * 5. Cube Palette (CIELAB 色彩三维立方体截面色板 - 4 色)
 */
function makeCubePalette(baseHex: string): string[] {
  const c1 = baseHex
  const c2 = adjustLab(baseHex, 15, -25, 20)
  const c3 = adjustLab(baseHex, -15, 20, -30)
  const c4 = adjustLab(baseHex, 8, 30, 25)
  return [c1, c2, c3, c4]
}

/**
 * 6. Shade Palette (单色恒色相明度阶梯 - 6 色)
 */
function makeShadePalette(baseHex: string): string[] {
  const rgb = hexToRgb(baseHex)
  const hsl = rgbToHsl(rgb)
  const levels = [88, 72, 56, 42, 28, 16]
  return levels.map((l) => rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l }), true))
}

/**
 * 7. Highlight Palette (UI 高光强调色板 - 4 色)
 */
function makeHighlightPalette(baseHex: string): string[] {
  const c1 = baseHex
  const c2 = adjustHsl(baseHex, 45, 30, 18)
  const c3 = adjustHsl(baseHex, -50, 25, 14)
  const c4 = adjustHsl(baseHex, 180, 35, 10)
  return [c1, c2, c3, c4]
}

/**
 * 8. Dust Palette (复古风化灰度调色板 - 5 色)
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
      name: 'Generic Gradient (通用平滑阶梯)',
      description: 'OKLab 感知均匀无灰阶平滑过渡色板，适合背景、插画与渐变设计',
      colors: makeGenericGradient(norm),
    },
    {
      id: 'matching_gradient',
      name: 'Matching Gradient (和谐近邻微调)',
      description: '色相微调的自然过渡，极适合按钮、卡片微渐变与柔和视觉背景',
      colors: makeMatchingGradient(norm),
    },
    {
      id: 'spot',
      name: 'Spot Palette (聚光灯焦点色)',
      description: '1 基础主色 + 3 组鲜明醒目的高反差焦点色，非常适合 UI 按钮与强调元素',
      colors: makeSpotPalette(norm),
    },
    {
      id: 'classy',
      name: 'Classy Palette (莫兰迪高雅灰调)',
      description: '自然降低饱和度、富于质感的莫兰迪优雅色彩组，耐看且极具高级感',
      colors: makeClassyPalette(norm),
    },
    {
      id: 'cube',
      name: 'Cube Palette (CIELAB 立方体均衡)',
      description: '基于 CIELAB 色彩空间 3D 立方体多维截面衍生，空间距离感均衡',
      colors: makeCubePalette(norm),
    },
    {
      id: 'shade',
      name: 'Shade Palette (纯粹单色明度阶梯)',
      description: '严格锁定色相与色度，仅按感官递进明暗层次，适合单色系统与文字层级',
      colors: makeShadePalette(norm),
    },
    {
      id: 'highlight',
      name: 'Highlight Palette (高光高反差)',
      description: '明快亮丽的高对比搭配，专为重点指标、标签和引导界面打造',
      colors: makeHighlightPalette(norm),
    },
    {
      id: 'dust',
      name: 'Dust Palette (复古风化灰度)',
      description: '带有岁月沉淀质感的大地灰调与微粉彩，适合复古印刷与淡雅排版',
      colors: makeDustPalette(norm),
    },
  ]
}
