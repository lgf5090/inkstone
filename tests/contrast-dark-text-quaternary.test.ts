import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor } from '../scripts/lib/contrast.mjs'
import { TOKENS_PATH, themeVars } from '../scripts/lib/theme-tokens.mjs'

/**
 * `--text-quaternary` is the app-wide de-emphasis step: counts, placeholders and
 * secondary metadata in every module read it, so nothing that paints it can be
 * used as the gate — the gate has to be the declaration itself.
 *
 * Dark theme is the hard case. Its lightest surface (`--bg-overlay` under
 * `[data-background='white']`) sits near #292a2d, and AA 4.5:1 normal text on
 * that is only reachable above ~67% L, so the whole de-emphasis ladder has to
 * live in the upper lightness band and keep its steps by spacing rather than by
 * distance from white. This gate holds both halves of that contract.
 */
const AA_NORMAL = 4.5
// A step that is less than one contrast-ratio point away from its neighbour is
// not a step the eye can find; the shipped ladder clears 1.17 at its narrowest.
const MIN_STEP_GAP = 1
const TEXT_STEPS = ['--text-primary', '--text-secondary', '--text-tertiary', '--text-quaternary'] as const
const SURFACE_TOKENS = ['--bg-sunken', '--bg-base', '--bg-editor', '--bg-surface', '--bg-raised', '--bg-overlay', '--bg-inset'] as const

const TOKENS = fs.readFileSync(TOKENS_PATH, 'utf8')

// `themeVars` returns the effective cascade, which already folds the
// `[data-background='white']` override in. Both background settings are shipped,
// so a surface is judged twice: once as the theme block declares it, once under
// the white-background override. Those two blocks are the only places the solid
// surfaces are declared, so they are read directly here.
const THEME_BLOCK: Record<'light' | 'dark', string> = {
  light: ":root[data-theme='light'], [data-code-theme='light'] {",
  dark: ":root[data-theme='dark'], [data-code-theme='dark'] {",
}
const WHITE_BLOCK: Record<'light' | 'dark', string> = {
  light: ":root[data-theme='light'][data-background='white'] {",
  dark: ":root[data-theme='dark'][data-background='white'] {",
}

function blockVars(selector: string): Map<string, string> {
  const start = TOKENS.indexOf(selector)
  if (start === -1) throw new Error(`missing ${selector}`)
  const block = TOKENS.slice(start + selector.length, TOKENS.indexOf('}', start))
  const vars = new Map<string, string>()
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(match[1]!, match[2]!.trim())
  return vars
}

function surfacesFor(theme: 'light' | 'dark') {
  const variants: Array<{ label: string; vars: Map<string, string> }> = [
    { label: `${theme}/background=default`, vars: blockVars(THEME_BLOCK[theme]) },
    { label: `${theme}/background=white`, vars: blockVars(WHITE_BLOCK[theme]) },
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

/** Worst surface a token has to survive, across both background settings. */
function worstSurface(theme: 'light' | 'dark', token: string) {
  const vars = themeVars(theme, TOKENS)
  let worst = { ratio: Infinity, at: '' }
  for (const surface of surfacesFor(theme)) {
    const ratio = ratioOf(vars, token, surface)
    if (ratio < worst.ratio) worst = { ratio, at: `${surface.label} ${surface.name}` }
  }
  return worst
}

describe('dark text ladder keeps WCAG AA at the de-emphasis floor', () => {
  const surfaces = surfacesFor('dark')

  it('judges a real surface set, not an empty loop', () => {
    // Seven solid surfaces across two background settings; a scan that silently
    // dropped a variant would make every assertion below pass for nothing.
    expect(surfaces.length).toBeGreaterThanOrEqual(14)
    expect(surfaces.filter((surface) => surface.name === '--bg-overlay').length).toBe(2)
    expect(surfaces.every((surface) => surface.rgb.every((channel) => Number.isFinite(channel)))).toBe(true)
  })

  it('measures --text-quaternary at 4.5:1 or better on every dark surface', () => {
    const vars = themeVars('dark', TOKENS)
    const failures = surfaces
      .map((surface) => ({ surface, ratio: ratioOf(vars, '--text-quaternary', surface) }))
      .filter(({ ratio }) => ratio < AA_NORMAL)
    expect(failures, `below AA: ${JSON.stringify(failures.map(({ surface, ratio }) => `${surface.label} ${surface.name} ${ratio.toFixed(2)}`))}`).toEqual([])
  })

  it('keeps every dark text step ordered and visibly separated on every surface', () => {
    const vars = themeVars('dark', TOKENS)
    for (const surface of surfaces) {
      const ratios = TEXT_STEPS.map((token) => ratioOf(vars, token, surface))
      for (let index = 1; index < ratios.length; index += 1) {
        const gap = ratios[index - 1]! - ratios[index]!
        expect(gap, `${TEXT_STEPS[index]} vs ${TEXT_STEPS[index - 1]} on ${surface.label} ${surface.name}`).toBeGreaterThanOrEqual(MIN_STEP_GAP)
      }
    }
  })

  it('does not alias --text-quaternary onto --text-tertiary', () => {
    const vars = themeVars('dark', TOKENS)
    const quaternary = vars.get('--text-quaternary')!
    const tertiary = vars.get('--text-tertiary')!
    expect(quaternary).not.toBe(tertiary)
    expect(parseColor(quaternary)!.rgb).not.toEqual(parseColor(tertiary)!.rgb)
  })

  it('catches an AA failure instead of reporting one vacuously', () => {
    // Positive control: the value this branch replaced, measured through the same
    // path. If this stopped failing, the gate above has lost its teeth.
    const oldDarkQuaternary = { rgb: parseColor('oklch(43% 0.008 265)').rgb }
    const worst = surfaces
      .map((surface) => contrastRatio(oldDarkQuaternary.rgb, surface.rgb))
      .reduce((acc, ratio) => Math.min(acc, ratio), Infinity)
    expect(worst).toBeLessThan(AA_NORMAL)
  })

  it('keeps the light floor of the shared token intact', () => {
    // Light theme needed no lifting, but it shares the token name, so a future
    // dark-only edit that broke light is caught here.
    expect(worstSurface('light', '--text-quaternary').ratio).toBeGreaterThanOrEqual(AA_NORMAL)
  })
})
