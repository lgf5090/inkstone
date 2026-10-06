import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TOKENS_PATH, themeVars } from '../scripts/lib/theme-tokens.mjs'
import { CHART_TOKENS } from '../src/client/lib/markdown/kanban/chart-palette'

/**
 * The kanban chart used to keep a second, private palette: hex constants for the
 * axes, tooltips and slices, chosen by eye and never re-read when the theme or
 * accent changed. The board has one palette now, so nothing may paint a chart
 * colour that the token layer did not authorise — hence two checks: the chart
 * sources stay free of literal colours, and every token the chart asks the
 * document for actually exists in both themes (a missing one resolves to
 * nothing, and a canvas silently draws with whatever it last had).
 */
const CHART_SOURCES = [
  'src/client/lib/markdown/kanban/chart-helpers.ts',
  'src/client/lib/markdown/kanban/chart-palette.ts',
]
const TOKENS = fs.readFileSync(TOKENS_PATH, 'utf8')
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|color)\(/i

describe('kanban chart palette wiring', () => {
  it('keeps every colour in the token layer', () => {
    const offenders = CHART_SOURCES.filter((file) => LITERAL_COLOR.test(fs.readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('asks only for tokens the token layer declares, in both themes', () => {
    const roles = Object.entries(CHART_TOKENS) as Array<[string, string]>
    expect(roles.length).toBeGreaterThan(0)
    const undeclared: string[] = []
    for (const [role, token] of roles) {
      for (const theme of ['light', 'dark']) {
        if (!themeVars(theme, TOKENS).has(token)) undeclared.push(`${theme} ${role} → ${token}`)
      }
    }
    expect(undeclared).toEqual([])
  })
})
