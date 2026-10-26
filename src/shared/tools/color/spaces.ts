/**
 * High-precision mathematical conversions across modern color spaces:
 * HEX, RGB, HSV, HSL, CMYK, HSI, CIE-LAB, and OKLab.
 */

import type {
  CmykColor,
  ColorSpaceValues,
  HsiColor,
  HslColor,
  HsvColor,
  LabColor,
  OklabColor,
  RgbColor,
} from './types'

// Clamp helper
export function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val))
}

/**
 * Normalizes any hex string into standard 6-digit lowercase (e.g. "#7cec91" or "7cec91")
 */
export function normalizeHex(input: string, withHash = true): string {
  let clean = input.trim().replace(/^#+/, '').toLowerCase()
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('')
  } else if (clean.length === 4) {
    // 4-digit hex with alpha
    clean = clean
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('')
  } else if (clean.length === 8) {
    // 8-digit hex with alpha, keep RGB part
    clean = clean.slice(0, 6)
  }

  // Fallback to black if invalid
  if (!/^[0-9a-f]{6}$/.test(clean)) {
    clean = '000000'
  }

  return withHash ? `#${clean}` : clean
}

/**
 * Converts a 6-digit hex string into RGB
 */
export function hexToRgb(hex: string): RgbColor {
  const clean = normalizeHex(hex, false)
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return { r, g, b }
}

/**
 * Converts RGB to 6-digit hex
 */
export function rgbToHex(rgb: RgbColor, withHash = true): string {
  const r = clamp(Math.round(rgb.r), 0, 255).toString(16).padStart(2, '0')
  const g = clamp(Math.round(rgb.g), 0, 255).toString(16).padStart(2, '0')
  const b = clamp(Math.round(rgb.b), 0, 255).toString(16).padStart(2, '0')
  const res = `${r}${g}${b}`.toLowerCase()
  return withHash ? `#${res}` : res
}

/**
 * Converts RGB to HSV (0-360, 0-100%, 0-100%)
 */
export function rgbToHsv(rgb: RgbColor): HsvColor {
  const r = clamp(rgb.r, 0, 255) / 255
  const g = clamp(rgb.g, 0, 255) / 255
  const b = clamp(rgb.b, 0, 255) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min

  let h = 0
  const s = max === 0 ? 0 : d / max
  const v = max

  if (d !== 0) {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h /= 6
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    v: Math.round(v * 100),
    a: rgb.a,
  }
}

/**
 * Converts HSV (0-360, 0-100%, 0-100%) to RGB
 */
export function hsvToRgb(hsv: HsvColor): RgbColor {
  const h = ((hsv.h % 360) + 360) % 360 / 60
  const s = clamp(hsv.s, 0, 100) / 100
  const v = clamp(hsv.v, 0, 100) / 100

  const i = Math.floor(h)
  const f = h - i
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))

  let r = 0
  let g = 0
  let b = 0

  switch (i) {
    case 0:
      r = v
      g = t
      b = p
      break
    case 1:
      r = q
      g = v
      b = p
      break
    case 2:
      r = p
      g = v
      b = t
      break
    case 3:
      r = p
      g = q
      b = v
      break
    case 4:
      r = t
      g = p
      b = v
      break
    default:
      r = v
      g = p
      b = q
      break
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
    a: hsv.a,
  }
}

/**
 * Converts RGB to HSL (0-360, 0-100%, 0-100%)
 */
export function rgbToHsl(rgb: RgbColor): HslColor {
  const r = clamp(rgb.r, 0, 255) / 255
  const g = clamp(rgb.g, 0, 255) / 255
  const b = clamp(rgb.b, 0, 255) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  let h = 0
  let s = 0

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h /= 6
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
    a: rgb.a,
  }
}

/**
 * Converts HSL to RGB
 */
export function hslToRgb(hsl: HslColor): RgbColor {
  const h = ((hsl.h % 360) + 360) % 360 / 360
  const s = clamp(hsl.s, 0, 100) / 100
  const l = clamp(hsl.l, 0, 100) / 100

  if (s === 0) {
    const val = Math.round(l * 255)
    return { r: val, g: val, b: val, a: hsl.a }
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    let t_ = t
    if (t_ < 0) t_ += 1
    if (t_ > 1) t_ -= 1
    if (t_ < 1 / 6) return p + (q - p) * 6 * t_
    if (t_ < 1 / 2) return q
    if (t_ < 2 / 3) return p + (q - p) * (2 / 3 - t_) * 6
    return p
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q

  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255)
  const g = Math.round(hue2rgb(p, q, h) * 255)
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255)

  return { r, g, b, a: hsl.a }
}

/**
 * Converts RGB to CMYK (0-100%)
 */
export function rgbToCmyk(rgb: RgbColor): CmykColor {
  const r = clamp(rgb.r, 0, 255) / 255
  const g = clamp(rgb.g, 0, 255) / 255
  const b = clamp(rgb.b, 0, 255) / 255

  const k = 1 - Math.max(r, g, b)
  if (k >= 0.9999) {
    return { c: 0, m: 0, y: 0, k: 100 }
  }

  const c = (1 - r - k) / (1 - k)
  const m = (1 - g - k) / (1 - k)
  const y = (1 - b - k) / (1 - k)

  return {
    c: Math.round(c * 100),
    m: Math.round(m * 100),
    y: Math.round(y * 100),
    k: Math.round(k * 100),
  }
}

/**
 * Converts CMYK to RGB
 */
export function cmykToRgb(cmyk: CmykColor): RgbColor {
  const c = clamp(cmyk.c, 0, 100) / 100
  const m = clamp(cmyk.m, 0, 100) / 100
  const y = clamp(cmyk.y, 0, 100) / 100
  const k = clamp(cmyk.k, 0, 100) / 100

  const r = Math.round(255 * (1 - c) * (1 - k))
  const g = Math.round(255 * (1 - m) * (1 - k))
  const b = Math.round(255 * (1 - y) * (1 - k))

  return { r, g, b }
}

/**
 * Converts RGB to HSI (Hue: 0-360, Saturation: 0-100%, Intensity: 0-100%)
 */
export function rgbToHsi(rgb: RgbColor): HsiColor {
  const r = clamp(rgb.r, 0, 255) / 255
  const g = clamp(rgb.g, 0, 255) / 255
  const b = clamp(rgb.b, 0, 255) / 255

  const intensity = (r + g + b) / 3
  if (intensity === 0) {
    return { h: 0, s: 0, i: 0 }
  }

  const min = Math.min(r, g, b)
  const saturation = 1 - min / intensity

  if (saturation === 0) {
    return { h: 0, s: 0, i: Math.round(intensity * 100) }
  }

  const num = 0.5 * (r - g + (r - b))
  const den = Math.sqrt((r - g) * (r - g) + (r - b) * (g - b))

  let theta = den === 0 ? 0 : Math.acos(clamp(num / den, -1, 1)) * (180 / Math.PI)
  if (b > g) {
    theta = 360 - theta
  }

  return {
    h: Math.round(theta),
    s: Math.round(saturation * 100),
    i: Math.round(intensity * 100),
  }
}

/**
 * Standard CIE-XYZ / CIE-LAB with D65 illuminant
 */
const D65 = {
  Xn: 0.95047,
  Yn: 1.0,
  Zn: 1.08883,
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/**
 * Converts RGB to CIE-LAB
 */
export function rgbToLab(rgb: RgbColor): LabColor {
  const r = srgbToLinear(clamp(rgb.r, 0, 255) / 255)
  const g = srgbToLinear(clamp(rgb.g, 0, 255) / 255)
  const b = srgbToLinear(clamp(rgb.b, 0, 255) / 255)

  // sRGB to XYZ matrix
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65.Xn
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / D65.Yn
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / D65.Zn

  const f = (t: number) =>
    t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116

  const fx = f(x)
  const fy = f(y)
  const fz = f(z)

  const l = Math.round(116 * fy - 16)
  const a = Math.round(500 * (fx - fy))
  const bVal = Math.round(200 * (fy - fz))

  return { l, a, b: bVal }
}

/**
 * Converts CIE-LAB to RGB
 */
export function labToRgb(lab: LabColor): RgbColor {
  const yVal = (lab.l + 16) / 116
  const xVal = lab.a / 500 + yVal
  const zVal = yVal - lab.b / 200

  const fInv = (t: number) => {
    const t3 = t * t * t
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787
  }

  const x = D65.Xn * fInv(xVal)
  const y = D65.Yn * fInv(yVal)
  const z = D65.Zn * fInv(zVal)

  // XYZ to sRGB matrix
  const rLin = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z
  const gLin = -0.969266 * x + 1.8760108 * y + 0.041556 * z
  const bLin = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z

  const r = clamp(Math.round(linearToSrgb(rLin) * 255), 0, 255)
  const g = clamp(Math.round(linearToSrgb(gLin) * 255), 0, 255)
  const b = clamp(Math.round(linearToSrgb(bLin) * 255), 0, 255)

  return { r, g, b }
}

/**
 * Converts RGB to OKLab (Perceptually uniform space)
 */
export function rgbToOklab(rgb: RgbColor): OklabColor {
  const r = srgbToLinear(clamp(rgb.r, 0, 255) / 255)
  const g = srgbToLinear(clamp(rgb.g, 0, 255) / 255)
  const b = srgbToLinear(clamp(rgb.b, 0, 255) / 255)

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  return {
    l: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  }
}

/**
 * Converts OKLab to RGB
 */
export function oklabToRgb(oklab: OklabColor): RgbColor {
  const l_ = oklab.l + 0.3963377774 * oklab.a + 0.2158037573 * oklab.b
  const m_ = oklab.l - 0.1055613458 * oklab.a - 0.0638541728 * oklab.b
  const s_ = oklab.l - 0.0894841775 * oklab.a - 1.291485548 * oklab.b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  const r = clamp(Math.round(linearToSrgb(rLin) * 255), 0, 255)
  const g = clamp(Math.round(linearToSrgb(gLin) * 255), 0, 255)
  const b = clamp(Math.round(linearToSrgb(bLin) * 255), 0, 255)

  return { r, g, b }
}

/**
 * Calculates Delta E 76 color difference in CIE-LAB space
 */
export function deltaE76(c1: RgbColor, c2: RgbColor): number {
  const l1 = rgbToLab(c1)
  const l2 = rgbToLab(c2)
  const dl = l1.l - l2.l
  const da = l1.a - l2.a
  const db = l1.b - l2.b
  return Math.sqrt(dl * dl + da * da + db * db)
}

/**
 * Aggregates all color space representations for a given hex color
 */
export function getColorSpaceValues(inputHex: string): ColorSpaceValues {
  const hex = normalizeHex(inputHex, true)
  const hexClean = normalizeHex(inputHex, false)
  const rgb = hexToRgb(hex)
  const hsv = rgbToHsv(rgb)
  const hsl = rgbToHsl(rgb)
  const cmyk = rgbToCmyk(rgb)
  const hsi = rgbToHsi(rgb)
  const lab = rgbToLab(rgb)

  return {
    hex,
    hexClean,
    rgb,
    rgbString: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
    hsv,
    hsvString: `hsv(${hsv.h}°, ${hsv.s}%, ${hsv.v}%)`,
    hsl,
    hslString: `hsl(${hsl.h}°, ${hsl.s}%, ${hsl.l}%)`,
    cmyk,
    cmykString: `cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)`,
    hsi,
    hsiString: `hsi(${hsi.h}°, ${hsi.s}%, ${hsi.i}%)`,
    lab,
    labString: `lab(${lab.l}, ${lab.a}, ${lab.b})`,
  }
}
