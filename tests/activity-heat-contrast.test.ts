// The percentages come from the calendar's own module, so this file runs under the browser
// environment like the components it reads — the chain reaches `lib/i18n` on the way.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HEAT_PERCENTS } from '../src/client/components/activity-calendar/strip'
import { accentNames, accentVars } from '../scripts/lib/theme-tokens.mjs'
import { contrastRatio, mixInOklab, over, parseColor } from '../scripts/lib/contrast.mjs'

/**
 * A heated day tile must stay readable under every accent.
 *
 * The activity calendar tints a tile by mixing the accent toward the surface it sits on
 * (`heatCell.ts`) or by carrying the accent as alpha over whatever is behind it
 * (`month-view.tsx`), and a day's number — plus its lunar line once the tile is heated — is ordinary
 * small text, so `AGENTS.md` rule 13's AA floor of 4.5:1 applies to both paths. The user picks the
 * accent and the theme, so the claim has to hold for all seven of them in both themes, on every
 * surface a tile can land on; a cap tuned against one pairing is a cap that fails on another.
 *
 * The percentages are the app's own `HEAT_PERCENTS`, and the maths is the shared
 * `scripts/lib/contrast.mjs` whose oklab round trip `tests/contrast-mix.test.ts` pins.
 */
const AA_NORMAL = 4.5
const TOKENS = fs.readFileSync('src/client/styles/tokens.css', 'utf8')
const SURFACES = ['--bg-surface', '--bg-inset', '--bg-base']

function rgbOf(value: string | undefined, what: string): number[] {
  const parsed = parseColor(value ?? '')
  if (!parsed) throw new Error(`${what} is not a colour this gate can read (${value})`)
  return parsed.rgb
}

/** Every (theme, accent, surface, level) pairing the calendar can actually paint, with its ratio. */
function heatedPairs(): Array<{ label: string; ratio: number }> {
  const pairs: Array<{ label: string; ratio: number }> = []
  for (const theme of ['light', 'dark'] as const) {
    for (const accent of accentNames(TOKENS)) {
      const vars = accentVars(theme, accent, TOKENS)
      const colour = rgbOf(vars.get('--accent'), `${theme} ${accent} --accent`)
      const text = rgbOf(vars.get('--text-primary'), `${theme} --text-primary`)
      for (const surfaceName of SURFACES) {
        if (vars.get(surfaceName) === undefined) continue
        const surface = rgbOf(vars.get(surfaceName), `${theme} ${surfaceName}`)
        for (const percent of HEAT_PERCENTS.slice(1)) {
          pairs.push({ label: `${theme} ${accent} mixed ${percent}% into ${surfaceName}`, ratio: contrastRatio(text, mixInOklab(colour, surface, percent)) })
          pairs.push({ label: `${theme} ${accent} at ${percent}% alpha over ${surfaceName}`, ratio: contrastRatio(text, over({ rgb: colour, alpha: percent / 100 }, surface)) })
        }
      }
    }
  }
  return pairs
}

describe('the activity heat ramp stays AA on every accent', () => {
  const PAIRS = heatedPairs()

  it('measures a useful number of pairings', () => {
    // Seven accents × two themes × three surfaces × four levels × two paths. A gate that quietly
    // enumerated one theme, or one surface, would pass while the failing pairing sat outside it.
    expect(PAIRS.length).toBe(7 * 2 * SURFACES.length * (HEAT_PERCENTS.length - 1) * 2)
  })

  it('keeps a day number readable on a heated tile everywhere', () => {
    const failing = PAIRS.filter((pair) => pair.ratio < AA_NORMAL)
      .map((pair) => `${pair.label}: ${pair.ratio.toFixed(2)}:1`)
    expect(failing, `${failing.length} heated tile(s) below AA 4.5:\n${failing.slice(0, 8).join('\n')}`).toEqual([])
  })

  it('keeps the ramp ordered and capped where the measurement says it must be', () => {
    // The monotonicity is what lets the top level stand in for the whole ramp, and the cap is the
    // invariant the assertion above actually rests on.
    expect(HEAT_PERCENTS[0]).toBe(0)
    for (let index = 1; index < HEAT_PERCENTS.length; index += 1) {
      expect(HEAT_PERCENTS[index]).toBeGreaterThan(HEAT_PERCENTS[index - 1])
    }
    expect(HEAT_PERCENTS.at(-1)).toBeLessThanOrEqual(44)
  })
})
