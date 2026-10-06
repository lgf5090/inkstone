import { describe, expect, it } from 'vitest'
import { KANBAN_COLOR_NAMES } from './colors'
import { CHART_TOKENS, buildKanbanChartPalette, readKanbanChartPalette } from './chart-palette'
import type { KanbanColorName } from './types'

describe('buildKanbanChartPalette', () => {
  it('resolves each chart role through its own token', () => {
    const palette = buildKanbanChartPalette((token) => token)
    expect(palette.text).toBe(CHART_TOKENS.text)
    expect(palette.grid).toBe(CHART_TOKENS.grid)
    expect(palette.tooltipBg).toBe(CHART_TOKENS.tooltipBg)
    expect(palette.tooltipTitle).toBe(CHART_TOKENS.tooltipTitle)
    expect(palette.tooltipBody).toBe(CHART_TOKENS.tooltipBody)
    expect(palette.tooltipBorder).toBe(CHART_TOKENS.tooltipBorder)
    expect(palette.lineBorder).toBe(CHART_TOKENS.lineBorder)
    expect(palette.lineFill).toBe(CHART_TOKENS.lineFill)
  })

  it('covers every label colour name, so no slice falls back to a made-up colour', () => {
    const palette = buildKanbanChartPalette((token) => token)
    expect(Object.keys(palette.tagColors).sort()).toEqual([...KANBAN_COLOR_NAMES].sort())
    for (const name of KANBAN_COLOR_NAMES) {
      expect(palette.tagColors[name as KanbanColorName]).toBe(`--kanban-tag-${name}-fg`)
    }
  })
})

describe('readKanbanChartPalette', () => {
  it('takes the colours from the document and leaves no probe behind', () => {
    const children = document.body.childNodes.length
    expect(() => readKanbanChartPalette()).not.toThrow()
    expect(document.body.childNodes).toHaveLength(children)
  })
})
