import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, near, parseColor } from '../scripts/lib/contrast.mjs'
import { TOKENS_PATH, themeVars } from '../scripts/lib/theme-tokens.mjs'

/**
 * The light theme's de-emphasis ladder: `--text-tertiary` and `--text-quaternary`
 * carry counts, placeholders and secondary metadata across every module, so no
 * component can be used as the gate — the gate has to be the declaration itself.
 *
 * Light is the mirror image of the dark ladder and fails in the opposite
 * direction. Text is dark on light, so climbing towards white *costs* contrast,
 * and the surface that binds is the darkest light one (`--bg-sunken` #f1efe9),
 * not the white-background override: #ffffff is the highest-contrast light
 * surface, so it is where every step measures best. The shipped ladder used to
 * fail twice over — tertiary sat under AA 4.5:1 on every surface, and it was
 * lighter than quaternary, so the token meant to read as more prominent read as
 * less. This gate holds the floor, the order, the spacing and the direction.
 */
const AA_NORMAL = 4.5
// Same contract the dark ladder ships: a step under one contrast-ratio point from
// its neighbour is not a step the eye can find. The shipped ladder clears 1.41.
const MIN_STEP_GAP = 1
// Ratio spacing alone can be bought by two colours that are nearly the same grey,
// so the perceptual step is checked in the declared lightness as well. The ladder
// ships 5 and 6 points between the de-emphasis ranks; 3 is where a step stops
// being a rank and becomes a rounding difference.
const MIN_LIGHTNESS_STEP = 3
const TEXT_STEPS = ['--text-primary', '--text-secondary', '--text-tertiary', '--text-quaternary'] as const
const SURFACE_TOKENS = ['--bg-sunken', '--bg-base', '--bg-editor', '--bg-surface', '--bg-raised', '--bg-overlay', '--bg-inset'] as const

// The values this branch replaced, kept here as the positive control below.
const OLD_SECONDARY = 'oklch(44% 0.01 265)'
const OLD_TERTIARY = 'oklch(58% 0.009 265)'
const OLD_QUATERNARY = 'oklch(51% 0.008 265)'

const TOKENS = fs.readFileSync(TOKENS_PATH, 'utf8')

/**
 * A colour this gate cannot read has to stop the gate.
 *
 * Comparing `undefined` against `undefined` passes, and a step that stopped being declared — or
 * stopped being a colour the maths understands — is precisely what this file exists to catch.
 */
function rgbOf(vars: Map<string, string>, token: string): number[] {
  const declared = vars.get(token)
  if (declared === undefined) throw new Error(`the light ladder no longer declares ${token}`)
  const parsed = parseColor(declared)
  if (!parsed) throw new Error(`this gate cannot read ${token} (${declared}) as a colour`)
  return parsed.rgb
}

// `themeVars` returns the effective cascade, which already folds the
// `[data-background='white']` override in. Both background settings are shipped,
// so a step is judged twice: once against the surfaces the theme block declares,
// once against the white override. Those two blocks are the only places the solid
// light surfaces are declared, so they are read directly here.
const THEME_BLOCK = ":root[data-theme='light'], [data-code-theme='light'] {"
const WHITE_BLOCK = ":root[data-theme='light'][data-background='white'] {"

function blockVars(selector: string): Map<string, string> {
  const start = TOKENS.indexOf(selector)
  if (start === -1) throw new Error(`missing ${selector}`)
  const block = TOKENS.slice(start + selector.length, TOKENS.indexOf('}', start))
  const vars = new Map<string, string>()
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(match[1]!, match[2]!.trim())
  return vars
}

function surfacesForLight() {
  const variants: Array<{ label: string; vars: Map<string, string> }> = [
    { label: 'light/background=default', vars: blockVars(THEME_BLOCK) },
    { label: 'light/background=white', vars: blockVars(WHITE_BLOCK) },
  ]
  const out: Array<{ label: string; name: string; rgb: number[] }> = []
  for (const variant of variants) {
    for (const name of SURFACE_TOKENS) {
      const raw = variant.vars.get(name)
      if (raw === undefined) throw new Error(`${variant.label} does not declare ${name}`)
      const color = parseColor(raw)
      // Translucent entries are tints, not backgrounds to measure against.
      if (!color || color.alpha !== 1) continue
      out.push({ label: variant.label, name, rgb: color.rgb })
    }
  }
  return out
}

function ratioOf(vars: Map<string, string>, token: string, surface: { rgb: number[] }) {
  const color = parseColor(vars.get(token) ?? '')
  if (!color) throw new Error(`unparsed colour for ${token}`)
  return contrastRatio(color.rgb, surface.rgb)
}

function ratioOfRaw(raw: string, surface: { rgb: number[] }) {
  const color = parseColor(raw)
  if (!color) throw new Error(`unparsed colour ${raw}`)
  return contrastRatio(color.rgb, surface.rgb)
}

/** Declared OKLCH lightness, so a ladder can be judged perceptually too. */
function lightnessOf(raw: string) {
  const match = /^oklch\(\s*([\d.]+)%/.exec(raw.trim())
  if (!match) throw new Error(`${raw} is not an oklch() colour; the lightness step cannot be judged`)
  return Number.parseFloat(match[1]!)
}

function describeSurface(surface: { label: string; name: string }) {
  return `${surface.label} ${surface.name}`
}

describe('light text ladder keeps WCAG AA and its rank order', () => {
  const surfaces = surfacesForLight()
  const vars = themeVars('light', TOKENS)

  it('judges a real surface set, not an empty loop', () => {
    // Seven solid surfaces across two background settings; a scan that silently
    // dropped a variant would make every assertion below pass for nothing.
    expect(surfaces.length).toBeGreaterThanOrEqual(14)
    expect(surfaces.filter((surface) => surface.name === '--bg-sunken').length).toBe(2)
    expect(surfaces.filter((surface) => surface.label.endsWith('white')).length).toBeGreaterThanOrEqual(7)
    expect(surfaces.every((surface) => surface.rgb.every((channel) => Number.isFinite(channel)))).toBe(true)
  })

  it('measures every light text step at 4.5:1 or better on every light surface', () => {
    const failures = TEXT_STEPS.flatMap((token) =>
      surfaces
        .map((surface) => ({ token, surface, ratio: ratioOf(vars, token, surface) }))
        .filter(({ ratio }) => ratio < AA_NORMAL),
    )
    expect(failures, `below AA: ${JSON.stringify(failures.map(({ token, surface, ratio }) => `${token} ${describeSurface(surface)} ${ratio.toFixed(2)}`))}`).toEqual([])
  })

  it('keeps every light text step ordered and visibly separated on every surface', () => {
    for (const surface of surfaces) {
      const ratios = TEXT_STEPS.map((token) => ratioOf(vars, token, surface))
      for (let index = 1; index < ratios.length; index += 1) {
        const gap = ratios[index - 1]! - ratios[index]!
        expect(gap, `${TEXT_STEPS[index]} vs ${TEXT_STEPS[index - 1]} on ${describeSurface(surface)}`).toBeGreaterThanOrEqual(MIN_STEP_GAP)
      }
    }
  })

  it('keeps the declared lightness steps apart, not just the ratios', () => {
    const lightnesses = TEXT_STEPS.map((token) => lightnessOf(vars.get(token)!))
    // Dark-on-light, so the rank order is a descending lightness order and the
    // two halves of the ladder cannot be traded off against each other.
    for (let index = 1; index < lightnesses.length; index += 1) {
      const step = lightnesses[index]! - lightnesses[index - 1]!
      expect(step, `${TEXT_STEPS[index]} vs ${TEXT_STEPS[index - 1]} in declared lightness`).toBeGreaterThanOrEqual(MIN_LIGHTNESS_STEP)
    }
    const rgbs = TEXT_STEPS.map((token) => rgbOf(vars, token))
    for (let index = 1; index < rgbs.length; index += 1) {
      expect(rgbs[index], `${TEXT_STEPS[index]} aliases ${TEXT_STEPS[index - 1]}`).not.toEqual(rgbs[index - 1])
    }
  })

  it('binds on the darkest light surface, with the white override as the loose end', () => {
    // Which surface carries the risk is part of the contract: a future edit that
    // makes a light surface darker moves the binding point and this tells the
    // author, instead of letting the ladder pass on a shrunken set.
    const measured = surfaces.map((surface) => ({ surface, ratio: ratioOf(vars, '--text-quaternary', surface) }))
    const worst = measured.reduce((acc, entry) => (entry.ratio < acc.ratio ? entry : acc))
    const best = measured.reduce((acc, entry) => (entry.ratio > acc.ratio ? entry : acc))
    expect(worst.surface.name, `worst surface is ${describeSurface(worst.surface)}`).toBe('--bg-sunken')
    expect(worst.surface.label).toContain('default')
    // The loose end is a white surface: `--bg-surface` in the theme block is
    // oklch(100% 0 0) and the override spells the same colour as #ffffff, so the
    // comparison is by channel value, not by string.
    expect(near(best.surface.rgb, [255, 255, 255]), `loosest surface is ${describeSurface(best.surface)}`).toBe(true)
  })

  it('catches the old inverted, sub-AA tertiary instead of reporting it vacuously', () => {
    // Positive control: the three values this branch replaced, measured through
    // the same path. If either half stopped failing, the gates above lost teeth.
    const oldTertiaryWorst = surfaces
      .map((surface) => ratioOfRaw(OLD_TERTIARY, surface))
      .reduce((acc, ratio) => Math.min(acc, ratio), Infinity)
    expect(oldTertiaryWorst).toBeLessThan(AA_NORMAL)

    // ...and it sat under quaternary on every surface, which is the inversion.
    for (const surface of surfaces) {
      expect(ratioOfRaw(OLD_TERTIARY, surface), `old tertiary vs old quaternary on ${describeSurface(surface)}`).toBeLessThan(ratioOfRaw(OLD_QUATERNARY, surface))
    }
    // The old secondary had no AA problem; the ladder was spaced, not deep.
    expect(Math.min(...surfaces.map((surface) => ratioOfRaw(OLD_SECONDARY, surface)))).toBeGreaterThanOrEqual(AA_NORMAL)
  })
})
