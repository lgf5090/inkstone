// @vitest-environment node
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, mixInOklab, mixWithTransparent, oklabToRgb, over, parseColor, relativeLuminance, rgbToOklab } from '../scripts/lib/contrast.mjs'

/**
 * The maths that lets a gate read `color-mix(in oklab, …)` without a browser.
 *
 * The activity calendar tints its day tiles by mixing the accent into a surface, and whether the day
 * number on top of that tint clears WCAG AA is now a checked claim rather than a calibration someone
 * wrote down. A check built on a hand-written colour space is only as good as its round trip, so this
 * file pins the conversion against the token layer's own colours before anything else is allowed to
 * trust a ratio computed from them.
 */
const TOKENS = fs.readFileSync('src/client/styles/tokens.css', 'utf8')

/** A colour the maths cannot read has to stop the gate rather than be compared as `undefined`. */
function rgb(value: string): number[] {
  const parsed = parseColor(value)
  if (!parsed) throw new Error(`this gate cannot read ${value} as a colour`)
  return parsed.rgb
}

const declaredColours = [...TOKENS.matchAll(/--[\w-]+:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|color\([^)]*\))/g)]
  .map((match) => ({ text: match[1]!, rgb: rgb(match[1]!) }))
  .filter((colour) => colour.rgb.every((channel) => Number.isFinite(channel)))

describe('the oklab maths a contrast gate rests on', () => {
  it('reads a useful number of colours out of the token layer', () => {
    // Not vacuous: the palette this project declares is large, and a conversion tested against three
    // colours would prove nothing about the ones that fail.
    expect(declaredColours.length).toBeGreaterThan(80)
  })

  it('round-trips every declared colour within two of a 255th', () => {
    const drift = declaredColours
      .map(({ text, rgb }) => {
        const back = oklabToRgb(...rgbToOklab(rgb))
        const worst = Math.max(...rgb.map((channel, index) => Math.abs(channel - back[index])))
        return { text, worst }
      })
      .filter((entry) => entry.worst > 2)
    expect(drift, `${drift.length} colour(s) do not survive oklab there and back: ${drift.slice(0, 5).map((d) => `${d.text} ±${d.worst.toFixed(1)}`).join(', ')}`).toEqual([])
  })

  it('mixes a colour with itself unchanged, and each end at the endpoints', () => {
    const accent = rgb('oklch(66.5% 0.15 32)')
    const surface = rgb('oklch(22% 0.015 265)')
    expect(mixInOklab(accent, accent, 40).map(Math.round)).toEqual(accent.map(Math.round))
    expect(mixInOklab(accent, surface, 100).map(Math.round)).toEqual(accent.map(Math.round))
    expect(mixInOklab(accent, surface, 0).map(Math.round)).toEqual(surface.map(Math.round))
  })

  it('keeps a grey mixed with a grey on the grey axis', () => {
    // A colour-space bug shows up first as chroma leaking into neutrals, and the app mixes greys for
    // surfaces constantly, so this is the cheapest tripwire.
    for (const percent of [10, 25, 40, 55, 70]) {
      const mixed = rgbToOklab(mixInOklab([128, 128, 128], [210, 210, 210], percent))
      expect(Math.abs(mixed[1]), `a leaked at ${percent}%`).toBeLessThan(0.005)
      expect(Math.abs(mixed[2]), `b leaked at ${percent}%`).toBeLessThan(0.005)
    }
  })

  it('darkens a tint monotonically as more of it is mixed into a dark surface', () => {
    // The property the day-number contrast depends on: if the ramp were not monotonic, a cap settled
    // by testing the top level would not protect the levels under it.
    const accent = rgb('oklch(80% 0.14 95)')
    const surface = rgb('oklch(22% 0.015 265)')
    const luminances = [0, 12, 24, 36, 50].map((percent) => relativeLuminance(mixInOklab(accent, surface, percent)))
    for (let index = 1; index < luminances.length; index += 1) {
      expect(luminances[index], `level ${index} did not get lighter`).toBeGreaterThan(luminances[index - 1])
    }
  })

  it('answers a transparent mix as the same colour carrying the percentage as alpha', () => {
    const accent = rgb('#c8553d')
    const tint = mixWithTransparent(accent, 50)
    expect(tint.rgb).toEqual(accent)
    expect(tint.alpha).toBe(0.5)
    // …and composites onto a surface the way the page does, so a gate can compare text against it.
    const composited = over(tint, [255, 255, 255])
    expect(composited.every((channel) => Number.isFinite(channel))).toBe(true)
    expect(contrastRatio(composited, [255, 255, 255])).toBeGreaterThan(1)
  })
})
