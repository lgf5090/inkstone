/**
 * Types and interfaces for the Color Assistant module (`tools/color`).
 */

import type { AiFallbackReason, ColorHistorySource } from './contract'

export interface RgbColor {
  r: number // 0 - 255
  g: number // 0 - 255
  b: number // 0 - 255
  a?: number // 0 - 1
}

export interface HsvColor {
  h: number // 0 - 360
  s: number // 0 - 100 (%)
  v: number // 0 - 100 (%)
  a?: number
}

export interface HslColor {
  h: number // 0 - 360
  s: number // 0 - 100 (%)
  l: number // 0 - 100 (%)
  a?: number
}

export interface CmykColor {
  c: number // 0 - 100 (%)
  m: number // 0 - 100 (%)
  y: number // 0 - 100 (%)
  k: number // 0 - 100 (%)
}


export interface LabColor {
  l: number // 0 - 100 (Lightness)
  a: number // -128 - 127 (Green to Red)
  b: number // -128 - 127 (Blue to Yellow)
}

export interface OklabColor {
  l: number // 0 - 1
  a: number // -0.4 - 0.4
  b: number // -0.4 - 0.4
}

export interface OklchColor {
  l: number // 0 - 1 (Lightness, same axis as OKLab)
  c: number // 0 - 0.4 (Chroma)
  h: number // 0 - 360 (Hue angle)
}

export type SupportedColorFormat = 'hex' | 'rgb' | 'hsv' | 'hsl' | 'cmyk' | 'hsi' | 'lab'

/**
 * The color spaces a hex resolves to.
 *
 * Only the values the interface reads. This used to carry eight pre-formatted CSS strings plus an HSI
 * triple that nothing consumed, while the panel that shows the spaces built the same strings again — in a
 * slightly different format, so the copied value and the computed one disagreed.
 */
export interface ColorSpaceValues {
  hex: string // with leading #
  rgb: RgbColor
  hsv: HsvColor
  hsl: HslColor
  /** Unrounded HSL: what the studio's sliders rotate on, so a hue change cannot move the other channels. */
  hslExact: HslColor
  cmyk: CmykColor
  lab: LabColor
  oklab: OklabColor
}

export type ColorHarmonyType =
  | 'complementary'
  | 'split_complementary'
  | 'triadic'
  | 'analogous'
  | 'tetradic'
  | 'intermediate'

export interface ColorHarmonyGroup {
  /** Names the message family the panel reads its display name and explanation from. */
  type: ColorHarmonyType
  colors: string[] // hex values
}

export type ColorSpaceAlgorithmType =
  | 'generic_gradient'
  | 'matching_gradient'
  | 'spot'
  | 'classy'
  | 'cube'
  | 'shade'
  | 'highlight'
  | 'dust'

export interface AlgorithmicPalette {
  /** Names the message family the row reads its display name and explanation from. */
  id: ColorSpaceAlgorithmType
  colors: string[] // hex values
}

export interface PaletteColorItem {
  hex: string
  name?: string
  ratio?: number
}

export interface ColorHuntPalette {
  id: string
  title: string
  colors: string[]
  tags: string[]
  likes: number
  createdAt?: number
}

export interface UserColorFavorite {
  id: string
  name: string
  hex: string
  rgb: RgbColor
  cmyk?: CmykColor
  lab?: LabColor
  tags: string[]
  note: string
  sort: number
  createdAt: number
  updatedAt: number
}

export interface UserColorPalette {
  id: string
  title: string
  colors: PaletteColorItem[]
  sourceType: 'custom' | 'colorhunt' | 'mycolorspace' | 'ai' | 'image' | 'harmony'
  description: string
  tags: string[]
  likesCount: number
  previewSvg: string
  isFavorite: boolean
  sort: number
  createdAt: number
  updatedAt: number
}

export interface ColorHistoryItem {
  id: string
  hex: string
  source: ColorHistorySource
  createdAt: number
}

export interface ColorSettings {
  stripHash: boolean
  defaultFormat: 'hex' | 'rgb' | 'hsl' | 'cmyk' | 'lab'
  defaultUiTab: string
  autoSaveHistory: boolean
  updatedAt: number
}

export interface AiPaletteRequest {
  seedHex?: string
  style?: string
  tone?: 'warm' | 'cool' | 'neutral' | 'all'
  count?: number
  prompt?: string
}

export interface AiPaletteResult {
  title: string
  description: string
  colors: Array<{
    hex: string
    name: string
    description?: string
  }>
  tags: string[]
  /**
   * True when no model answered and the palette was computed instead.
   *
   * The engine has always had an algorithmic fallback, and a reader who was never told could not tell a
   * designed scheme from a hue rotation — so the flag travels with the result rather than living only in
   * a server log.
   */
  degraded: boolean
  reason?: AiFallbackReason
}

export interface PoeticColorInterpretation {
  hex: string
  name: string
  story: string
}

/**
 * A poetic naming pass, with the honesty flag the bare array could not carry.
 *
 * Returned as an object rather than a per-item marker because the answer is one verdict for the whole
 * batch: either the model named these colors or the fallback table did.
 */
export interface PoeticInterpretResult {
  items: PoeticColorInterpretation[]
  degraded: boolean
  reason?: AiFallbackReason
}

export type ColorBlindnessType =
  | 'normal'
  | 'protanopia' // Red-blind
  | 'deuteranopia' // Green-blind
  | 'tritanopia' // Blue-blind
  | 'achromatopsia' // Monochromacy / Total color blindness

export interface WcagContrastResult {
  ratio: number
  normalAa: boolean
  normalAaa: boolean
  largeAa: boolean
  largeAaa: boolean
  uiComponents: boolean
  score: 'AAA' | 'AA' | 'Fail'
}

export type TokenScaleStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950

export interface TokenScaleItem {
  step: TokenScaleStep
  hex: string
  rgb: RgbColor
  contrastWhite: number
  contrastBlack: number
  textRecommended: '#ffffff' | '#000000'
}

export interface TraditionalColorItem {
  name: string
  pinyin?: string
  romaji?: string
  kana?: string
  hex: string
  cmyk: [number, number, number, number] // [C, M, Y, K] in %
  series?: string
  solarTerm?: string
}

export interface GradientColorStop {
  id: string
  color: string // hex or rgba
  offset: number // 0 - 100 %
}

export type GradientType = 'linear' | 'radial' | 'conic'

export interface GradientConfig {
  type: GradientType
  angle: number // 0 - 360
  stops: GradientColorStop[]
  useOklabInterpolation?: boolean
}
