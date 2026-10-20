import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor } from '../scripts/lib/contrast.mjs'
import { TOKENS_PATH, themeVars } from '../scripts/lib/theme-tokens.mjs'

/**
 * The three semantic colours have to survive being small text.
 *
 * `--success`, `--warning` and `--danger` are carried as text — a count in the rail, an over-budget
 * figure, the reason under a failed delivery — at 10.5 to 12.5 px, and they are also painted as a tinted
 * chip whose foreground is the same token. Nothing in the component layer can be the gate for that, so the
 * gate is the declaration itself, measured against every solid surface each shipped background setting
 * offers.
 *
 * The light theme used to fail all three: on the warm surface `--bg-sunken` they measured 2.19, 1.90 and
 * 3.21, which is why the old values are kept below as the positive control — a gate that cannot fail the
 * way the theme used to be is not measuring anything.
 */

const AA_NORMAL = 4.5
const TOKENS = fs.readFileSync(TOKENS_PATH, 'utf8')
const TOKEN_NAMES = ['--success', '--warning', '--danger'] as const
const SURFACE_TOKENS = ['--bg-sunken', '--bg-base', '--bg-editor', '--bg-surface', '--bg-raised', '--bg-overlay', '--bg-inset'] as const

const BLOCKS = {
  'light/default': ":root[data-theme='light'], [data-code-theme='light'] {",
  'light/white': ":root[data-theme='light'][data-background='white'] {",
  'dark/default': ":root[data-theme='dark'], [data-code-theme='dark'] {",
  'dark/white': ":root[data-theme='dark'][data-background='white'] {",
}

// What the light theme declared before this gate existed.
const OLD_LIGHT = { '--success': 'oklch(70% 0.14 155)', '--warning': 'oklch(76% 0.145 80)', '--danger': 'oklch(64% 0.19 22)' }

function blockVars(selector: string): Map<string, string> {
  const start = TOKENS.indexOf(selector)
  if (start === -1) throw new Error(`missing ${selector}`)
  const block = TOKENS.slice(start + selector.length, TOKENS.indexOf('}', start))
  const vars = new Map<string, string>()
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(match[1]!, match[2]!.trim())
  return vars
}

/** Every solid surface a theme can paint text onto, tagged with the setting that produced it. */
function surfacesOf(theme: 'light' | 'dark') {
  const out: Array<{ label: string, name: string, rgb: number[] }> = []
  const keys: Array<keyof typeof BLOCKS> = theme === 'light' ? ['light/default', 'light/white'] : ['dark/default', 'dark/white']
  for (const key of keys) {
    const vars = blockVars(BLOCKS[key])
    for (const name of SURFACE_TOKENS) {
      const raw = vars.get(name)
      if (raw === undefined) throw new Error(`${key} does not declare ${name}`)
      const color = parseColor(raw)
      // A translucent entry is a tint over something else, not a surface to measure against.
      if (!color || color.alpha !== 1) continue
      out.push({ label: key, name, rgb: color.rgb })
    }
  }
  return out
}

function rgbOf(token: string, source: Map<string, string>): number[] {
  const color = parseColor(source.get(token) ?? '')
  if (!color) throw new Error(`this gate cannot read ${token} (${source.get(token)}) as a colour`)
  return color.rgb
}

describe('the semantic colours as small text', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`clears AA on every ${theme} surface`, () => {
      const vars = themeVars(theme, TOKENS)
      const surfaces = surfacesOf(theme)
      expect(surfaces.length, `${theme} declares surfaces to measure against`).toBeGreaterThan(3)
      for (const token of TOKEN_NAMES) {
        const rgb = rgbOf(token, vars)
        for (const surface of surfaces) {
          const ratio = contrastRatio(rgb, surface.rgb)
          expect(ratio, `${token} on ${surface.label} ${surface.name}`).toBeGreaterThanOrEqual(AA_NORMAL)
        }
      }
    })
  }

  it('would have failed the values this replaced', () => {
    // The positive control: the gate bites on the old light declarations, so a passing run means the
    // tokens were actually darkened rather than the measurement being blind.
    const surfaces = surfacesOf('light')
    for (const token of TOKEN_NAMES) {
      const rgb = rgbOf(token, new Map(Object.entries(OLD_LIGHT)))
      const worst = Math.min(...surfaces.map((surface) => contrastRatio(rgb, surface.rgb)))
      expect(worst, `${token} at its old light value`).toBeLessThan(AA_NORMAL)
    }
  })

  it('keeps the two themes distinguishable in the same direction they were', () => {
    // Dark carries these colours as light-on-dark, so its steps sit higher, not lower; a future edit that
    // pushed both themes to the same value would have erased the difference the chip states.
    const light = themeVars('light', TOKENS)
    const dark = themeVars('dark', TOKENS)
    for (const token of TOKEN_NAMES) {
      const lightness = (source: Map<string, string>) => Number(source.get(token)!.match(/oklch\(([\d.]+)%/)?.[1])
      expect(lightness(dark), `${token} in dark is not darker than light`).toBeGreaterThan(lightness(light))
    }
  })
})
