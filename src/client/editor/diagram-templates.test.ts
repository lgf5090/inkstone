import { describe, expect, it } from 'vitest'
import { CHART_TEMPLATES, KANBAN_TEMPLATES, MERMAID_TEMPLATES, MINDMAP_TEMPLATES } from './diagram-templates'
import { CHART_SLICE_KINDS, convertChartBody, detectChartMode, readChartTable } from '../lib/markdown/chart'
import { parseKanbanBody } from '../lib/markdown/kanban/body'
import { detectMindmapMode } from '../lib/markdown/mindmap/body'
import { renderMarkdown } from '../lib/markdown/renderer'
import { EN_US_MESSAGES } from '@shared/locales/en-US'

const FAMILIES = [
  ['mermaid', MERMAID_TEMPLATES],
  ['chart', CHART_TEMPLATES],
  ['mindmap', MINDMAP_TEMPLATES],
  ['kanban', KANBAN_TEMPLATES],
] as const

describe('every diagram template', () => {
  it.each(FAMILIES)('%s ids are unique and every body is filled in', (_family, templates) => {
    const ids = templates.map((template) => template.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const template of templates) {
      expect(template.body.trim().length).toBeGreaterThan(0)
      expect(EN_US_MESSAGES[template.labelKey]).toBeTruthy()
    }
  })
})

describe('the mermaid templates', () => {
  it.each(MERMAID_TEMPLATES)('$id becomes a mermaid block', (template) => {
    const html = renderMarkdown(`\`\`\`mermaid\n${template.body}\n\`\`\`\n`).html
    expect(html).toContain('data-mermaid')
  })
})

describe('the chart templates', () => {
  it.each(CHART_TEMPLATES)('$id is a table the chart reader turns into that chart', (template) => {
    expect(detectChartMode(template.body)).toBe('table')
    expect(() => readChartTable(template.body)).not.toThrow()
    const asJson = convertChartBody(template.body)
    expect(asJson.ok).toBe(true)
    if (!asJson.ok) return
    const config = JSON.parse(asJson.body)
    expect(config.type).toBe(template.id)
    expect(config.options).toBeUndefined()
    const back = convertChartBody(asJson.body)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.dropped).toBe(0)
    // A slice chart's value-column name has nowhere to live in its config, so the table → JSON → table
    // round trip cannot carry it back; every other kind comes home byte for byte.
    if (CHART_SLICE_KINDS.includes(template.id))
      expect(back.body.split('\n').slice(2)).toEqual(template.body.split('\n').slice(2))
    else
      expect(back.body).toBe(template.body)
  })
})

describe('the mind map templates', () => {
  it.each(MINDMAP_TEMPLATES)('$id reads as the $id mode', (template) => {
    expect(detectMindmapMode(template.body)).toBe(template.id)
    expect(renderMarkdown(`\`\`\`mindmap\n${template.body}\n\`\`\`\n`).html).toContain('data-mindmap')
  })
})

describe('the kanban templates', () => {
  it.each(KANBAN_TEMPLATES)('$id parses in its own mode', (template) => {
    const parsed = parseKanbanBody(template.body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.mode).toBe(template.id)
    expect(renderMarkdown(`\`\`\`kanban\n${template.body}\n\`\`\`\n`).html).toContain('data-kanban')
  })

  it('gives the outline board one status option per heading, and files each card under its own', () => {
    const parsed = parseKanbanBody(KANBAN_TEMPLATES[0]!.body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const status = parsed.data.columns.find((column) => column.id === 'status')
    expect(status?.options?.map((option) => option.label)).toEqual(['To Do', 'Doing', 'Done'])
    const labelOf = (id: unknown) => status?.options?.find((option) => option.id === id)?.label
    expect(parsed.data.items.map((item) => labelOf(item.properties.status))).toEqual(['To Do', 'To Do', 'Doing', 'Done'])
  })
})
