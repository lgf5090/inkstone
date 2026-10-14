// @vitest-environment node
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { accentNames, accentVars } from '../scripts/lib/theme-tokens.mjs'
import { contrastRatio, over, parseColor } from '../scripts/lib/contrast.mjs'

/**
 * Text drawn on the accent's own tint has to be readable for every accent.
 *
 * `--accent-soft` is the accent at 14% (and `--accent-softer` at 7%), so tinted chips, the selected
 * view tab and the calendar's today card all paint a colour derived from the very colour a lot of
 * them use as their text. Measured that way, the accent on its own wash sat at 3.60:1 for light amber
 * and 4.10:1 for cinnabar in both themes, which is below the AA floor `AGENTS.md` rule 13 sets.
 * `--accent-on-soft` is the token that answers it: the accent itself where the accent already clears
 * the floor, a darkened or lifted variant of it (same oklab chroma and hue) where it does not.
 *
 * The surfaces are enumerated because the wash lands on different backgrounds — a chip on the sunken
 * rail is not a chip on a card — and a gate that checked only one of them would pass while another
 * one failed.
 */
const AA_NORMAL = 4.5
const TOKENS = fs.readFileSync('src/client/styles/tokens.css', 'utf8')
const SURFACES = ['--bg-surface', '--bg-inset', '--bg-base']
const TINTS = [0.14, 0.07]

function rgbOf(value: string | undefined, what: string): number[] {
  const parsed = parseColor(value ?? '')
  if (!parsed) throw new Error(`${what} is not a colour this gate can read (${value})`)
  return parsed.rgb
}

/** The text colour a pairing paints, following the `var(--accent)` indirection the base token uses. */
function onSoft(vars: Map<string, string>, theme: string, accent: string): number[] {
  const declared = vars.get('--accent-on-soft')
  if (declared === undefined) throw new Error(`${theme}/${accent} has no --accent-on-soft in the cascade`)
  const direct = parseColor(declared)
  return direct ? direct.rgb : rgbOf(vars.get('--accent'), `${theme}/${accent} --accent`)
}

function ratios(text: number[], accent: number[], vars: Map<string, string>): number[] {
  return SURFACES.filter((name) => vars.get(name) !== undefined)
    .flatMap((name) => TINTS.map((alpha) => contrastRatio(text, over({ rgb: accent, alpha }, rgbOf(vars.get(name), name)))))
}

describe('accent text on an accent tint stays AA', () => {
  const cases = (['light', 'dark'] as const).flatMap((theme) => accentNames(TOKENS).map((accent) => ({ theme, accent })))

  it('declares the token in the base block, not only where it is overridden', () => {
    // `--text-20` was referenced by components for months without ever being declared, and nothing
    // noticed because the class simply painted nothing. A token that resolves to nothing is silent.
    expect(TOKENS).toMatch(/:root\s*\{[\s\S]*?--accent-on-soft:\s*var\(--accent\);/)
  })

  it.each(cases)('$theme $accent: text clears AA on its own wash on every surface', ({ theme, accent }) => {
    const vars = accentVars(theme, accent, TOKENS)
    const worst = Math.min(...ratios(onSoft(vars, theme, accent), rgbOf(vars.get('--accent'), `${theme}/${accent} --accent`), vars))
    expect(worst, `${theme}/${accent} paints ${worst.toFixed(2)}:1 as text on its own tint`).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('is not a gate that would pass without the override', () => {
    // Positive control: the plain accent really does fail somewhere, or the token above is decoration.
    const plain = (['light', 'dark'] as const).flatMap((theme) => accentNames(TOKENS).map((accent) => {
      const vars = accentVars(theme, accent, TOKENS)
      const colour = rgbOf(vars.get('--accent'), `${theme}/${accent}`)
      return { label: `${theme}/${accent}`, worst: Math.min(...ratios(colour, colour, vars)) }
    }))
    const failing = plain.filter((entry) => entry.worst < AA_NORMAL)
    expect(failing.length, 'no accent fails as text on its own tint any more — re-measure before keeping the override').toBeGreaterThan(0)
  })
})
