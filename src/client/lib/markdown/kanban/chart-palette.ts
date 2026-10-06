import { KANBAN_COLOR_NAMES } from './colors'
import type { KanbanColorName } from './types'

export const CHART_TOKENS = {
  text: '--text-tertiary',
  grid: '--border-subtle',
  tooltipBg: '--bg-overlay',
  tooltipTitle: '--text-primary',
  tooltipBody: '--text-secondary',
  tooltipBorder: '--border-default',
  lineBorder: '--accent',
  lineFill: '--accent-soft',
} as const

export interface KanbanChartPalette {
  text: string
  grid: string
  tooltipBg: string
  tooltipTitle: string
  tooltipBody: string
  tooltipBorder: string
  lineBorder: string
  lineFill: string
  tagColors: Record<KanbanColorName, string>
}

export function buildKanbanChartPalette(readColor: (token: string) => string): KanbanChartPalette {
  const tagColors = Object.fromEntries(
    KANBAN_COLOR_NAMES.map((name) => [name, readColor(`--kanban-tag-${name}-fg`)]),
  ) as Record<KanbanColorName, string>
  return {
    text: readColor(CHART_TOKENS.text),
    grid: readColor(CHART_TOKENS.grid),
    tooltipBg: readColor(CHART_TOKENS.tooltipBg),
    tooltipTitle: readColor(CHART_TOKENS.tooltipTitle),
    tooltipBody: readColor(CHART_TOKENS.tooltipBody),
    tooltipBorder: readColor(CHART_TOKENS.tooltipBorder),
    lineBorder: readColor(CHART_TOKENS.lineBorder),
    lineFill: readColor(CHART_TOKENS.lineFill),
    tagColors,
  }
}

// A probe that is in the document but not painted: `:root` custom properties
// only reach an attached element, and `color` is where the browser hands back
// what the token chain resolves to.
export function readKanbanChartPalette(): KanbanChartPalette {
  const probe = document.createElement('span')
  probe.hidden = true
  document.body.append(probe)
  try {
    return buildKanbanChartPalette((token) => {
      probe.style.color = `var(${token})`
      return getComputedStyle(probe).color
    })
  } finally {
    probe.remove()
  }
}
