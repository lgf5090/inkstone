// @vitest-environment node
/**
 * A reader's own colour, still readable.
 *
 * `deriveCustomAccent` walks the accent it was handed until it carries text, and the floor it has to clear is
 * the one `AGENTS.md` rule 13 sets. This measures the derived tokens the same way
 * `tests/accent-on-soft-contrast.test.ts` measures the seven shipped accents — the on-soft colour against the
 * accent's own wash on every surface, the on-accent colour against the accent and its hover step — so the
 * custom accent and the named ones are held to one standard and not two.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hexToRgb, rgbToOklab } from '@shared/tools/color/spaces'
import { deriveCustomAccent } from '../src/client/lib/custom-accent'
import { accentVars } from '../scripts/lib/theme-tokens.mjs'
import { contrastRatio, over, parseColor } from '../scripts/lib/contrast.mjs'

const TOKENS = fs.readFileSync('src/client/styles/tokens.css', 'utf8')
const AA_NORMAL = 4.5
const TINTS = [0.14, 0.07]
const SURFACE_NAMES = ['--bg-surface', '--bg-inset', '--bg-base']
const SHIPPED_ACCENTS = ['cinnabar', 'indigo', 'celadon', 'amber', 'terracotta', 'wisteria', 'graphite']
/** How far outside that measured band a derived accent may sit before it counts as a different colour. */
const LIGHTNESS_SLACK = 0.05

const SEEDS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#c12a2a', '#2ca02c', '#627486', '#808080', '#101010', '#f0f0f0']

function rgbOf(value: string, what: string): number[] {
  const parsed = parseColor(value)
  if (!parsed) throw new Error(`${what} is not a colour this gate can read (${value})`)
  return parsed.rgb
}

/** The named theme whose surfaces the wash is seen against; the accent itself is the reader's own. */
function cascade(theme: 'light' | 'dark'): Map<string, string> {
  return accentVars(theme, 'cinnabar', TOKENS)
}

function surfaceList(theme: 'light' | 'dark'): string[] {
  const vars = cascade(theme)
  return SURFACE_NAMES.map((name) => {
    const value = vars.get(name)
    if (!value) throw new Error(`${theme} has no ${name} in the cascade`)
    return value
  })
}

/** Text against the accent's 14% and 7% wash, wherever that wash happens to sit. */
function worstWash(text: string, accent: string, theme: 'light' | 'dark'): number {
  const textRgb = rgbOf(text, 'text')
  const accentRgb = rgbOf(accent, 'accent')
  return Math.min(
    ...surfaceList(theme).flatMap((surface) =>
      TINTS.map((alpha) => contrastRatio(textRgb, over({ rgb: accentRgb, alpha }, rgbOf(surface, surface)))),
    ),
  )
}

function pair(text: string, background: string, label: string): number {
  return contrastRatio(rgbOf(text, `${label} text`), rgbOf(background, `${label} background`))
}

describe('the derived accent', () => {
  it.each(SEEDS)('keeps its own tint readable: %s', (seed) => {
    for (const theme of ['light', 'dark'] as const) {
      const vars = deriveCustomAccent(seed, theme, surfaceList(theme))
      const worst = worstWash(vars['--accent-on-soft'], vars['--accent'], theme)
      expect(worst, `${seed}/${theme} paints ${worst.toFixed(2)}:1 as text on its own tint`).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  it.each(SEEDS)('keeps buttons legible: %s', (seed) => {
    for (const theme of ['light', 'dark'] as const) {
      const vars = deriveCustomAccent(seed, theme, surfaceList(theme))
      const onAccent = pair(vars['--accent-contrast'], vars['--accent'], `${seed}/${theme} accent`)
      expect(onAccent, `${seed}/${theme} paints ${onAccent.toFixed(2)}:1 on the accent`).toBeGreaterThanOrEqual(AA_NORMAL)
      const onHover = pair(vars['--accent-contrast'], vars['--accent-hover'], `${seed}/${theme} hover`)
      expect(onHover, `${seed}/${theme} paints ${onHover.toFixed(2)}:1 on the hover step`).toBeGreaterThanOrEqual(AA_NORMAL)
    }
  })

  it('keeps the hue the reader picked', () => {
    const seed = '#c12a2a'
    const seedLab = rgbToOklab(hexToRgb(seed))
    const seedHue = Math.atan2(seedLab.b, seedLab.a)
    for (const theme of ['light', 'dark'] as const) {
      const accent = rgbToOklab(hexToRgb(deriveCustomAccent(seed, theme, surfaceList(theme))['--accent']))
      const hue = Math.atan2(accent.b, accent.a)
      expect(Math.abs(hue - seedHue), `${theme} drifted off hue`).toBeLessThan(0.35)
    }
  })

  it('leaves the accent alone where it already carries its own tint', () => {
    // Measured, not assumed: light/blue puts its accent at 4.60:1 on every wash, so the walk has nothing to
    // correct. The shipped cascade says the same thing with `--accent-on-soft: var(--accent)`.
    const vars = deriveCustomAccent('#0000ff', 'light', surfaceList('light'))
    expect(worstWash(vars['--accent'], vars['--accent'], 'light')).toBeGreaterThanOrEqual(AA_NORMAL)
    expect(vars['--accent-on-soft']).toBe(vars['--accent'])
  })

  it('falls back to the accent when there is no surface to measure against', () => {
    // `readSoftSurfaces` drops values the cascade reports in a form this cannot read; with nothing left the
    // walk must not invent a colour, it must leave the token as the theme declares it.
    for (const theme of ['light', 'dark'] as const) {
      const vars = deriveCustomAccent('#c12a2a', theme, [])
      expect(vars['--accent-on-soft']).toBe(vars['--accent'])
    }
  })

  it('stays inside the lightness the shipped accents use', () => {
    // Measured from tokens.css rather than written down: the seven named accents sit between oklch 38% and 56%
    // on paper, 66.5% and 80% on ink. A derived accent outside that band is no longer the colour that was
    // picked, whatever it does to the contrast figures — this is the bound that stops a bad hover step from
    // being "fixed" by walking the brand colour into near-black.
    const band = (theme: 'light' | 'dark') => {
      const lightness = SHIPPED_ACCENTS.map((name) => {
        const raw = accentVars(theme, name, TOKENS).get('--accent')
        const m = /^oklch\(\s*([\d.]+)%/.exec(raw ?? '')
        if (!m) throw new Error(`${theme}/${name} declares --accent in a form this gate cannot read (${raw})`)
        return Number(m[1]) / 100
      })
      return [Math.min(...lightness) - LIGHTNESS_SLACK, Math.max(...lightness) + LIGHTNESS_SLACK]
    }
    for (const theme of ['light', 'dark'] as const) {
      const [low, high] = band(theme)
      for (const seed of SEEDS) {
        const vars = deriveCustomAccent(seed, theme, surfaceList(theme))
        const accentL = rgbToOklab(hexToRgb(vars['--accent'])).l
        expect(accentL, `${theme}/${seed} accent sat below the shipped band`).toBeGreaterThanOrEqual(low)
        expect(accentL, `${theme}/${seed} accent sat above the shipped band`).toBeLessThan(high)
        // The hover step goes the way the ink needs: darker under near-white text, lighter under near-ink.
        const hover = rgbToOklab(hexToRgb(vars['--accent-hover'])).l
        if (theme === 'light') expect(hover, `${seed} hovered lighter than its resting accent`).toBeLessThan(accentL)
        else expect(hover, `${seed} hovered darker than its resting accent`).toBeGreaterThan(accentL)
      }
    }
  })

  it('keeps the saturation the reader picked where the gamut allows it', () => {
    // A vivid yellow has to give some of it up when it darkens (oklab chroma is not a cylinder in sRGB), but
    // a washed-out grey is a different colour from the one that was picked. Measured floor: 0.56 of the seed's
    // chroma, on the worst case in this list; seeds with no chroma to lose are not judged.
    for (const theme of ['light', 'dark'] as const) {
      for (const seed of SEEDS) {
        const s = rgbToOklab(hexToRgb(seed))
        const seedChroma = Math.hypot(s.a, s.b)
        if (seedChroma < 0.02) continue
        const a = rgbToOklab(hexToRgb(deriveCustomAccent(seed, theme, surfaceList(theme))['--accent']))
        expect(Math.hypot(a.a, a.b) / seedChroma, `${theme}/${seed} lost its colour`).toBeGreaterThanOrEqual(0.5)
      }
    }
  })

  it('is not a gate that would pass without the walk', () => {
    // Positive control: the accent as picked really does fail as text on its own tint, or the walk that
    // produces `--accent-on-soft` is decoration and the plain accent would have been enough.
    const failing = (['light', 'dark'] as const).flatMap((theme) =>
      SEEDS.map((seed) => {
        const vars = deriveCustomAccent(seed, theme, surfaceList(theme))
        return { label: `${theme}/${seed}`, worst: worstWash(vars['--accent'], vars['--accent'], theme) }
      }).filter((entry) => entry.worst < AA_NORMAL),
    )
    expect(failing.length, 'no accent fails as text on its own tint — re-measure before keeping the walk').toBeGreaterThan(0)
  })
})
