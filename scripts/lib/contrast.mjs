// The colour maths behind the contrast gates, shared by the browser gate
// (scripts/check-contrast.mjs, which measures the painted pairs) and the token
// gate (tests/kanban-tag-contrast.test.ts, which has to judge a palette before
// anything paints it). Both ask the same WCAG question, so neither may keep its
// own copy of what a contrast ratio is.
// Colours travel as {rgb:[r,g,b], alpha} so a translucent tint can be composited
// over the surface underneath it (`over`) before it is compared (`contrastRatio`).

export const parseColor = (value) => {
  const text = (value ?? '').trim().toLowerCase()
  const hex = text.match(/^#([0-9a-f]{3,8})$/)
  if (hex) {
    const raw = hex[1].length <= 4 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    const channel = (index) => Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16)
    return { rgb: [channel(0), channel(1), channel(2)], alpha: raw.length === 8 ? channel(3) / 255 : 1 }
  }
  const functional = text.match(/^(rgba?|oklch|oklab|color)\((.*)\)$/)
  if (!functional) return null
  const body = functional[2]
  const [head, alphaPart] = body.split('/')
  const numbers = head.trim().split(/\s+/)
  const alpha = alphaPart === undefined ? 1 : alphaPart.trim().endsWith('%') ? Number.parseFloat(alphaPart) / 100 : Number.parseFloat(alphaPart)
  if (functional[1] === 'rgb' || functional[1] === 'rgba') {
    // Legacy rgba() carries its alpha as a fourth channel, not after a slash.
    const legacy = numbers.length > 3 ? Number.parseFloat(numbers[3]) : null
    return { rgb: numbers.slice(0, 3).map((part) => Number.parseFloat(part)), alpha: legacy === null ? alpha : legacy }
  }
  if (functional[1] === 'oklch') {
    const lightness = Number.parseFloat(numbers[0]) > 1 ? Number.parseFloat(numbers[0]) / 100 : Number.parseFloat(numbers[0])
    return { rgb: oklabToRgb(lightness, Number.parseFloat(numbers[1]) * Math.cos(radians(numbers[2] ?? '0')), Number.parseFloat(numbers[1]) * Math.sin(radians(numbers[2] ?? '0'))), alpha }
  }
  if (functional[1] === 'oklab') {
    return { rgb: oklabToRgb(Number.parseFloat(numbers[0]), Number.parseFloat(numbers[1]), Number.parseFloat(numbers[2])), alpha }
  }
  // color(srgb r g b) — what Chrome computes a color-mix() into.
  const channels = numbers.filter((part) => part !== 'srgb').slice(0, 3).map((part) => Number.parseFloat(part) * 255)
  return { rgb: channels, alpha }
}

export const radians = (degrees) => (Number.parseFloat(degrees) * Math.PI) / 180

export function oklabToRgb(l, a, b) {
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ]
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ]
  return linear.map((channel) => Math.min(255, Math.max(0, linearToSrgb(channel) * 255)))
}

export const linearToSrgb = (value) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)

export const relativeLuminance = (rgb) => {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const contrastRatio = (foreground, background) => {
  const [high, low] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

export const over = (top, bottom) => top.rgb.map((channel, index) => channel * top.alpha + bottom[index] * (1 - top.alpha))

export const near = (rgb, other) => rgb.every((channel, index) => Math.abs(channel - other[index]) <= 3)

export const toHex = (rgb) => `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
