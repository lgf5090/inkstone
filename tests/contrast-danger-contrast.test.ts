import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor } from '../scripts/lib/contrast.mjs'
import { TOKENS_PATH, themeVars } from '../scripts/lib/theme-tokens.mjs'

/**
 * The label on a danger fill.
 *
 * `--danger` is a *text* colour in both themes — that is what the semantic gate above it requires — and
 * it is also the fill of a count badge and of the destructive button. The two uses pull in opposite
 * directions: the darker the red, the better white reads on it and the worse it reads as a figure on
 * paper. White was hard-coded at both call sites and only survived the light theme; on the dark theme's
 * 68% red it measures about 2.9:1, which is a label a reader has to guess at.
 *
 * `--danger-contrast` is the foreground, so this gate is one question asked twice: does the token named
 * for the fill clear AA against the fill, in every theme. The positive control is the literal it
 * replaces, so a run that passes means the token was actually consulted rather than the measurement
 * being blind to which colour it was handed.
 */

const AA_NORMAL = 4.5
const TOKENS = fs.readFileSync(TOKENS_PATH, 'utf8')

describe('the label on a danger fill', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`clears AA in the ${theme} theme`, () => {
      const vars = themeVars(theme, TOKENS)
      const fill = parseColor(vars.get('--danger') ?? '')
      const label = parseColor(vars.get('--danger-contrast') ?? '')
      expect(fill, `${theme} declares no --danger`).not.toBeNull()
      expect(label, `${theme} declares no --danger-contrast`).not.toBeNull()
      expect(contrastRatio(label!.rgb, fill!.rgb)).toBeGreaterThanOrEqual(AA_NORMAL)
    })
  }

  it('would have failed the literal white this replaced', () => {
    // The dark theme is where the old spelling broke; measuring it here keeps the gate honest about
    // what it is protecting rather than merely asserting the token exists.
    const fill = parseColor(themeVars('dark', TOKENS).get('--danger') ?? '')
    expect(fill).not.toBeNull()
    expect(contrastRatio([255, 255, 255], fill!.rgb)).toBeLessThan(AA_NORMAL)
  })
})
