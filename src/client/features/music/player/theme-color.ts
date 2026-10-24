/**
 * A cover's own tint, published as three CSS variables on the music surface.
 *
 * The colour is read from pixels the browser already has: a 32 px canvas copy of the same-origin
 * cover route. CSS colour functions are never parsed back out of computed styles, because the design
 * tokens use oklch and the canvas path is both cheaper and exact.
 *
 * Everything here is best-effort. A tainted canvas, an unreadable image or a cross-origin URL leaves
 * the variables unset, and the stylesheet's fallback (the app accent) stays in charge.
 */
import tinycolor from 'tinycolor2'

export interface MusicThemeRgb {
  r: number
  g: number
  b: number
}

export interface MusicThemeColors {
  accent: string
  accentSoft: string
  onAccent: string
}

/** The pixels are sampled small: a cover's average is a mood, not a poster. */
const SAMPLE_SIZE = 32

/** Accents are kept in a band that can carry white or near-black text without falling apart. */
const ACCENT_SATURATION = { min: 0.42, max: 0.88 } as const
const ACCENT_LIGHTNESS = { min: 0.34, max: 0.6 } as const

/** Bounded so browsing hundreds of covers cannot grow a per-tab map without limit. */
const MAX_CACHED_COVERS = 48
const colorCache = new Map<string, MusicThemeColors | null>()
const pendingLoads = new Map<string, Promise<MusicThemeColors | null>>()

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** The cover route is same-origin by design; anything else cannot be sampled and is refused early. */
export function isSameOriginCover(url: string): boolean {
  if (!url || typeof window === 'undefined') return false
  try {
    return new URL(url, window.location.href).origin === window.location.origin
  } catch {
    // An unparseable address has no origin to compare; the caller keeps the fallback accent.
    return false
  }
}

/** The average of the opaque pixels, or null when the sample holds none. */
export function averageColorOfPixels(pixels: ArrayLike<number>): MusicThemeRgb | null {
  let red = 0
  let green = 0
  let blue = 0
  let count = 0
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3]!
    if (alpha < 32) continue
    red += pixels[index]!
    green += pixels[index + 1]!
    blue += pixels[index + 2]!
    count++
  }
  if (count === 0) return null
  return {
    r: Math.round(red / count),
    g: Math.round(green / count),
    b: Math.round(blue / count),
  }
}

/**
 * Turn an average cover colour into the accent trio.
 *
 * The raw average is usually too grey or too bright to read as an accent, so saturation and
 * lightness are pulled into a deliberate band. `onAccent` is then the readable candidate for that
 * accent, which is the one contrast pair this module can decide without knowing the page theme.
 */
export function themeColorsFromRgb(rgb: MusicThemeRgb): MusicThemeColors | null {
  const base = tinycolor(rgb)
  if (!base.isValid()) return null
  const hsl = base.toHsl()
  const accent = tinycolor({
    h: hsl.h,
    s: clamp(hsl.s, ACCENT_SATURATION.min, ACCENT_SATURATION.max),
    l: clamp(hsl.l, ACCENT_LIGHTNESS.min, ACCENT_LIGHTNESS.max),
  })
  if (!accent.isValid()) return null
  const onAccent = tinycolor.mostReadable(accent, ['#101014', '#ffffff'], {
    level: 'AA',
    size: 'small',
  })
  return {
    accent: accent.toHexString(),
    // An alpha tint composes over paper and ink alike; an opaque mix would have to know the theme.
    accentSoft: tinycolor(accent.toHexString()).setAlpha(0.16).toRgbString(),
    onAccent: onAccent.isValid() ? onAccent.toHexString() : '#ffffff',
  }
}

function colorsFromImage(image: HTMLImageElement): MusicThemeColors | null {
  if (!image.naturalWidth || !image.naturalHeight) return null
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_SIZE
  canvas.height = SAMPLE_SIZE
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  try {
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
    const pixels = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
    const average = averageColorOfPixels(pixels)
    return average ? themeColorsFromRgb(average) : null
  } catch {
    // A canvas becomes unreadable when the image is not actually same-origin (a redirect to a CDN,
    // for instance). There is no colour to recover, so the caller keeps the fallback accent.
    return null
  }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
}

/**
 * Sample one cover and cache the answer. Returns null for anything the canvas cannot read; failures
 * are cached too, so a broken cover does not trigger a new decode on every render.
 */
export function loadCoverThemeColors(url: string): Promise<MusicThemeColors | null> {
  if (!url || !isSameOriginCover(url) || typeof document === 'undefined') return Promise.resolve(null)
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url) ?? null)
  const pending = pendingLoads.get(url)
  if (pending) return pending

  const load = loadImage(url)
    .then((image) => (image ? colorsFromImage(image) : null))
    .then((colors) => {
      if (colorCache.size >= MAX_CACHED_COVERS) {
        const oldest = colorCache.keys().next().value
        if (oldest !== undefined) colorCache.delete(oldest)
      }
      colorCache.set(url, colors)
      return colors
    })
    .catch((error: unknown) => {
      // The promise chain only fails on an unexpected engine fault; the fallback accent is still a
      // complete answer, and the reason is worth a low-level note rather than a user-facing error.
      console.warn('[inkstone] Music cover colour could not be read:', error)
      colorCache.set(url, null)
      return null
    })
    .finally(() => {
      pendingLoads.delete(url)
    })

  pendingLoads.set(url, load)
  return load
}

/** Write the trio onto a music surface. A null answer removes the overrides, restoring the tokens. */
export function applyMusicThemeColors(element: HTMLElement, colors: MusicThemeColors | null): void {
  if (!colors) {
    element.style.removeProperty('--music-accent')
    element.style.removeProperty('--music-accent-soft')
    element.style.removeProperty('--music-on-accent')
    return
  }
  element.style.setProperty('--music-accent', colors.accent)
  element.style.setProperty('--music-accent-soft', colors.accentSoft)
  element.style.setProperty('--music-on-accent', colors.onAccent)
}
