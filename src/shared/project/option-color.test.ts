import { describe, expect, it } from 'vitest'
import { PROJECT_OPTION_COLORS, projectOptionColorName, projectOptionCssColor } from './option-color'

describe('the option colour vocabulary', () => {
  it('offers the reference tokens in the reference order', () => {
    expect(PROJECT_OPTION_COLORS).toEqual([
      'propColorGray', 'propColorBrown', 'propColorOrange', 'propColorYellow', 'propColorGreen',
      'propColorBlue', 'propColorPurple', 'propColorPink', 'propColorRed',
    ])
  })

  it('maps every offered token onto a palette name and a calibrated CSS colour', () => {
    for (const token of PROJECT_OPTION_COLORS) {
      const name = projectOptionColorName(token)
      expect(name).not.toBe('')
      expect(projectOptionCssColor(token)).toBe(`var(--kanban-tag-${name}-fg)`)
    }
  })

  it('reads the reference no-colour token, an empty string and an unknown token as no colour', () => {
    for (const raw of ['', 'propColorDefault', 'propColorChartreuse', '#ff0000', 'red']) {
      expect(projectOptionColorName(raw)).toBe('')
      expect(projectOptionCssColor(raw)).toBeNull()
    }
  })

  it('round trips a token through the name back to the same token', () => {
    for (const token of PROJECT_OPTION_COLORS) {
      const name = projectOptionColorName(token)
      const rebuilt = `propColor${name[0]!.toUpperCase()}${name.slice(1)}`
      expect(rebuilt).toBe(token)
    }
  })
})