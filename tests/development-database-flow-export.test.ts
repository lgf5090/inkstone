// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildExportSvg, safeFileBase } from '../src/client/features/development/database/flow-export'

const PALETTE = {
  accent: '#8b5cf6',
  border: '#e4e4e7',
  surface: '#ffffff',
  text: '#18181b',
  muted: '#71717a',
  background: '#ffffff',
}

describe('flow export', () => {
  it('draws nodes, edges, labels and the arrow marker', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0, width: 200, height: 80 },
      { id: 'b', x: 320, y: 0, width: 200, height: 80 },
    ]
    const edges = [{ id: 'e', source: 'a', target: 'b', label: 'a_id' }]
    const { svg, width, height } = buildExportSvg(
      nodes,
      edges,
      (id) => (id === 'a'
        ? { title: 'a&b', lines: ['id INTEGER'], highlightLines: new Set([0]) }
        : { title: 'b', lines: ['id INTEGER'] }),
      PALETTE,
    )
    expect(width).toBeGreaterThan(320)
    expect(height).toBeGreaterThanOrEqual(200)
    expect(svg).toContain('a&amp;b')
    expect(svg).toContain('a_id')
    expect(svg).toContain('marker-end="url(#arrow)"')
    expect(svg.match(/<marker /g)).toHaveLength(1)
  })

  it('keeps exported file names safe', () => {
    expect(safeFileBase('my erd?.svg')).toBe('my-erd-.svg')
    expect(safeFileBase('///')).toBe('flow')
    expect(safeFileBase('inkstone-erd')).toBe('inkstone-erd')
  })
})