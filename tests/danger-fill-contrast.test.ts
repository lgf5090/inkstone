// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor } from '../scripts/lib/contrast.mjs'
import { TOKENS_PATH, themeVars } from '../scripts/lib/theme-tokens.mjs'

const AA_NORMAL = 4.5
const TOKENS = fs.readFileSync(TOKENS_PATH, 'utf8')
const DANGER_INK = '--danger-contrast'
/** The white the two themes used to paint on a danger fill, in the same triple the gate compares. */
const WHITE = [255, 255, 255]

/**
 * The ink a danger fill paints has to clear AA in both themes, judged from the declarations.
 *
 * Four surfaces paint a solid `--danger` and write a number or a label on top of it: the shared danger
 * `Button`, the mobile tab's count, the bell's unread count and the composer's stop control. White on the
 * light token measured 5.83, and the same white on the dark token measured 3.14 — below the 4.5 floor
 * `AGENTS.md` rule 13 sets for normal text — because the dark theme carries these colours as a light fill.
 * `--danger-contrast` is the answer, named for what it paints on, one step beside `--accent-contrast`,
 * which the same rule already holds for the accent fill. A screen cannot be measured here: jsdom paints
 * no pixels, so the gate reads the declarations, the way every other contrast gate in this directory does.
 */
function inkOf(token: string, theme: 'light' | 'dark'): number[] {
  const vars = themeVars(theme, TOKENS)
  const declared = vars.get(token)
  if (!declared) throw new Error(`${theme} declares no ${token}`)
  const parsed = parseColor(declared)
  if (!parsed) throw new Error(`${token} in ${theme} is not a colour this gate can read (${declared})`)
  return parsed.rgb
}

function dangerOf(theme: 'light' | 'dark'): number[] {
  return inkOf('--danger', theme)
}

describe('the ink painted on a danger fill (tokens.css declarations, since jsdom paints nothing)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`clears AA for normal text on the ${theme} danger fill`, () => {
      const ratio = contrastRatio(inkOf(DANGER_INK, theme), dangerOf(theme))
      expect(ratio, `${DANGER_INK} on ${theme} --danger`).toBeGreaterThanOrEqual(AA_NORMAL)
    })
  }

  it('keeps the two themes reading in the direction the fills demand', () => {
    // The light fill is dark enough to carry a near-white ink; the dark fill is a light red and carries a
    // near-black one. Both themes declaring the same value is the bug this replaced, so the pair has to
    // stay on opposite sides of the midline.
    const light = relativeLuminanceOf(DANGER_INK, 'light')
    const dark = relativeLuminanceOf(DANGER_INK, 'dark')
    expect(light).toBeGreaterThan(0.5)
    expect(dark).toBeLessThan(0.5)
  })

  it('would have failed the white it replaced', () => {
    // The positive control: a gate that cannot fail the way the theme used to be is measuring nothing.
    expect(contrastRatio(WHITE, dangerOf('dark')), 'white on the dark danger fill').toBeLessThan(AA_NORMAL)
    expect(contrastRatio(WHITE, dangerOf('light')), 'white on the light danger fill').toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('declares the ink in both themes rather than inheriting one value', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(themeVars(theme, TOKENS).get(DANGER_INK), `${theme} has no danger ink`).toBeTruthy()
    }
    expect(themeVars('dark', TOKENS).get(DANGER_INK))
      .not.toBe(themeVars('light', TOKENS).get(DANGER_INK))
  })
})

function relativeLuminanceOf(token: string, theme: 'light' | 'dark'): number {
  const rgb = inkOf(token, theme)
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('no surface paints white on a danger fill', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx$/.test(entry.name)) files.push(full)
    }
  }
  walk(path.join('src', 'client'))

  it('reads a real set of components', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('leaves every class string that fills with --danger to the contrast token', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        // A solid fill only: `--danger)/10` and `--danger)_15%` are washes, whose text is `--danger` itself.
        if (!/bg-\[var\(--danger\)\](?!\/)/.test(line)) return
        if (/text-white(?![\w-])/.test(line)) offenders.push(`${path.relative(process.cwd(), file).replaceAll('\\', '/')}:${index + 1}`)
      })
    }
    expect(offenders, `white painted on --danger at ${offenders.join(', ')}`).toEqual([])
  })

  it('keeps the four surfaces that started this painting the token', () => {
    const painted = ['--danger-contrast']
    for (const file of [
      'src/client/components/primitives.tsx',
      'src/client/features/todos/TodosApp.tsx',
      'src/client/features/chat/NotificationCenter.tsx',
      'src/client/lib/ai/components/AIChatInput.tsx',
    ]) {
      const text = fs.readFileSync(file, 'utf8')
      expect(text, `${file} no longer paints the danger ink`).toContain(`var(${painted[0]})`)
    }
  })
})
