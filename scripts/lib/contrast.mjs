// The colour maths behind the contrast gates. Every gate that reads this file
// judges colours from the declarations in `src/client/styles/tokens.css` rather
// than from a painted screen, because this repo drives no browser:
// tests/kanban-tag-contrast.test.ts and tests/kanban-contrast-tokens.test.ts for
// the board's palette, tests/contrast-dark-text-quaternary.test.ts and
// tests/contrast-light-text-ladder.test.ts for the text ladder. Those four ask
// the same WCAG question and therefore share one copy of what a contrast ratio
// is; the json, graph and e-ink gates still keep private colour maths of their
// own, so this file is not yet the whole of the repo's contrast verification.
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

// The way in, so a gate can ask what `color-mix(in oklab, A 40%, B)` paints without a browser. The
// matrices are Ottosson's, transposed and cube-rooted; `tests/contrast-mix.test.ts` round-trips every
// colour the token layer declares, which is what keeps this honest rather than plausible.
function srgbToLinear(channel) {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function rgbToOklab(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}

/**
 * `color-mix(in oklab, top percent%, bottom)` for two opaque colours: interpolate in oklab, then
 * convert back. This is the one that needs the maths — a tint mixed over a real surface is a new
 * colour, not the same colour at a lower alpha.
 */
export function mixInOklab(top, bottom, percent) {
  const [a, b] = [rgbToOklab(top), rgbToOklab(bottom)]
  const share = percent / 100
  return oklabToRgb(...a.map((channel, index) => channel * share + b[index] * (1 - share)))
}

/**
 * `color-mix(in oklab, colour percent%, transparent)` — what the activity calendar's month grid uses.
 * Mixing into `transparent` keeps the colour and lowers the alpha, so the honest answer is the colour
 * itself at `percent / 100`, left for `over()` to composite onto whatever is behind it.
 */
export function mixWithTransparent(rgb, percent) {
  return { rgb, alpha: percent / 100 }
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
