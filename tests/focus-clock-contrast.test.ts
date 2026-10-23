// @vitest-environment node
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor } from '../scripts/lib/contrast.mjs'
import { accentNames, themeVars } from '../scripts/lib/theme-tokens.mjs'

/**
 * The focus clock's colours, measured rather than assumed.
 *
 * The card this gate belongs to asked for the dark clock text to be *tested*, and the way to test a colour
 * in this repository is not `getComputedStyle`: a browser hands back the `oklab()` and `oklch()` text the
 * stylesheet wrote, so a check that parsed numbers out of it would compare a luminance of "0" for every
 * token and call the ladder brighter than it is. The gate therefore reads the declarations themselves,
 * through the same oklab maths the four other contrast gates use, and judges the surface the panel actually
 * paints behind the text.
 *
 * Which token the panel paints is pinned here too, before the measuring: a gate that only knew that
 * `--text-primary` clears AA would still be green after someone moved the clock onto a de-emphasis step. The
 * floor for the readout is the 4.5:1 of normal text (`AGENTS.md` rule 13); the floor for the ring's arc is
 * the 3:1 a *graphic* that carries state needs, checked against both the panel behind it and the track it is
 * drawn over, because a reader who can only see the arc is the reader this number is for.
 */
const AA_TEXT = 4.5
const AA_GRAPHIC = 3
const TOKENS = fs.readFileSync('src/client/styles/tokens.css', 'utf8')
const OVERLAY = fs.readFileSync('src/client/features/todos/FocusOverlay.tsx', 'utf8')

/** Both background settings a theme ships: the one the theme block declares, and the white override. */
const BACKGROUNDS: Record<'light' | 'dark', string[]> = {
  light: [':root', ":root[data-theme='light']", ":root[data-theme='light'][data-background='white']"],
  dark: [':root', ":root[data-theme='dark']", ":root[data-theme='dark'][data-background='white']"],
}

function rgbOf(value: string | undefined, what: string): number[] {
  const parsed = value === undefined ? null : parseColor(value)
  if (!parsed) throw new Error(`${what} is not a colour this gate can read (${value})`)
  return parsed.rgb
}

/** The declarations a cascade answers with, one surface at a time, in source order. */
function blocks(theme: 'light' | 'dark'): Map<string, string>[] {
  return BACKGROUNDS[theme].map((selector) => {
    const at = TOKENS.indexOf(selector)
    if (at < 0) throw new Error(`missing ${selector}`)
    const body = TOKENS.slice(at, TOKENS.indexOf('}', at))
    const found = new Map<string, string>()
    for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found.set(match[1]!, match[2]!.trim())
    return found
  })
}

/**
 * The ratio a pairing answers with, worst of the two background settings.
 *
 * `background` is a choice the reader makes, so a surface that only holds at AA under one of them does not
 * hold: the pair is measured twice and the lower number is the one that is kept.
 */
function worstPair(theme: 'light' | 'dark', token: string, behindToken: string): number {
  let worst = Number.POSITIVE_INFINITY
  for (const partial of blocks(theme)) {
    const merged = new Map([...themeVars(theme, TOKENS), ...partial])
    const ratio = contrastRatio(rgbOf(merged.get(token), token), rgbOf(merged.get(behindToken), behindToken))
    worst = Math.min(worst, ratio)
  }
  return worst
}

/** The accent of one picker choice, against the panel and against the ring's own track. */
function worstArc(theme: 'light' | 'dark', accent: string): number {
  const base = themeVars(theme, TOKENS)
  const selectors = [`:root[data-accent='${accent}'][data-theme='${theme}']`, ...BACKGROUNDS[theme].slice(1)]
  const vars = new Map<string, string>(base)
  for (const selector of selectors) {
    const at = TOKENS.indexOf(selector)
    if (at < 0) throw new Error(`missing ${selector}`)
    const body = TOKENS.slice(at, TOKENS.indexOf('}', at))
    for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(match[1]!, match[2]!.trim())
  }
  const arc = rgbOf(vars.get('--accent'), `${theme}/${accent} --accent`)
  return Math.min(
    contrastRatio(arc, rgbOf(vars.get('--bg-overlay'), 'panel')),
    contrastRatio(arc, rgbOf(vars.get('--bg-inset'), 'track')),
  )
}

describe('the focus clock paints colours that hold in both themes', () => {
  it('draws its readout in the primary text step and its ring in the accent', () => {
    // Pinned before it is measured: the numbers below only mean anything while they are the tokens the
    // surface actually paints.
    expect(OVERLAY).toMatch(/data-focus-clock-text=""[\s\S]{0,200}?\{formatRunningDuration/)
    expect(OVERLAY).toContain('text-[var(--text-primary)]')
    expect(OVERLAY).toContain('stroke="var(--accent)"')
    expect(OVERLAY).toContain('stroke="var(--bg-inset)"')
  })

  it('clears AA as text on the panel it is drawn on', () => {
    for (const theme of ['light', 'dark'] as const) {
      const ratio = worstPair(theme, '--text-primary', '--bg-overlay')
      expect(ratio, `${theme}: the clock reads at ${ratio.toFixed(2)}:1 on the panel`).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('clears the graphic floor as an arc, over the panel and over its own track', () => {
    // Every picker colour, not the default one: the accent is the reader's choice and the ring is the only
    // place some of them learn how much of the block is left.
    for (const theme of ['light', 'dark'] as const) {
      for (const accent of accentNames(TOKENS)) {
        const ratio = worstArc(theme, accent)
        expect(ratio, `${theme}/${accent}: the ring reads at ${ratio.toFixed(2)}:1 against the panel`).toBeGreaterThanOrEqual(AA_GRAPHIC)
      }
    }
  })

  it('is not a gate that would pass without the tokens being the ones it picked', () => {
    // Two positive controls, both measured rather than asserted, because a floor nobody ever fails is
    // decoration. The accent would *not* have cleared AA as the clock's number — dark cinnabar on the panel
    // is below the text floor — which is exactly why the readout is a text step and the accent is left to
    // the arc, where 3:1 is the ask. And the track is deliberately not a state-bearing graphic: it sits far
    // under the 3:1 floor on purpose, so anyone who later paints progress with *it* has to pass a different
    // test than this one.
    const accents = (['light', 'dark'] as const).flatMap((theme) => accentNames(TOKENS).map((accent) => ({ theme, accent })))
    const asText = accents.map(({ theme, accent }) => worstPair(theme, '--accent', '--bg-overlay'))
    expect(Math.min(...asText), 'no accent fails as text on the panel any more — the readout could use one').toBeLessThan(AA_TEXT)

    const track = (['light', 'dark'] as const).map((theme) => worstPair(theme, '--bg-inset', '--bg-overlay'))
    expect(Math.max(...track), 'the ring track now clears the graphic floor on its own').toBeLessThan(AA_GRAPHIC)
  })
})
