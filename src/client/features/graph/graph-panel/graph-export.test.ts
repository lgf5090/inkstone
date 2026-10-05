import { describe, expect, it } from 'vitest'
import type { GraphPreferences } from '../../../lib/graph-settings'
import { DEFAULT_PREFERENCES } from '../../../lib/graph-settings'
import {
  graphExportBounds,
  graphExportFilename,
  graphExportGeometry,
  graphExportSvg,
} from './graph-export'
import { GRAPH_EXPORT_SCALE } from './constants'
import { FALLBACK_PALETTE } from './scene'
import type { CanvasNode, CanvasState } from './types'

function node(id: string, x: number, y: number, over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    title: id,
    kind: 'note',
    degree: 1,
    inDegree: 1,
    outDegree: 1,
    folderId: null,
    folderName: null,
    folderColor: null,
    tags: [],
    x,
    y,
    vx: 0,
    vy: 0,
    r: 6,
    colorGroup: null,
    ...over,
  }
}

function state(nodes: CanvasNode[]): CanvasState {
  const byId = new Map(nodes.map((item) => [item.id, item]))
  const edges = nodes.slice(1).map((item, index) => ({ a: nodes[index]!, b: item }))
    .filter((edge) => byId.has(edge.a.id) && byId.has(edge.b.id))
  return {
    nodes, edges, scale: 1, offsetX: 0, offsetY: 0,
    dragging: null, pointers: new Map(), pinch: null,
    frame: 0, raf: 0, needsFit: false, initialized: true, palette: FALLBACK_PALETTE,
    emphasis: { id: null, neighbours: new Set<string>() }, searchHits: null, schedule: null,
  }
}

const prefs = (over: Partial<GraphPreferences> = {}): GraphPreferences => ({ ...DEFAULT_PREFERENCES, ...over })

describe('graph export geometry', () => {
  it('frames an empty graph as a padding-sized picture', () => {
    const bounds = graphExportBounds([], true)
    expect(bounds).toEqual({ minX: 0, minY: 0, width: 48, height: 48 })
  })

  it('adds the label height to the bottom edge only when titles are drawn', () => {
    const withTitles = graphExportBounds([node('a', 0, 0)], true)
    const without = graphExportBounds([node('a', 0, 0)], false)
    expect(withTitles.height - without.height).toBe(23)
    expect(withTitles.width).toBe(without.width)
  })

  it('keeps two device pixels per world unit for a graph that fits', () => {
    const geometry = graphExportGeometry({ minX: 0, minY: 0, width: 400, height: 300 })
    expect(geometry).toEqual({ scale: GRAPH_EXPORT_SCALE, width: 800, height: 600 })
  })

  it('shrinks the scale rather than ask for a canvas the browser refuses', () => {
    const geometry = graphExportGeometry({ minX: 0, minY: 0, width: 9000, height: 9000 })
    expect(geometry.scale).toBeLessThan(GRAPH_EXPORT_SCALE)
    expect(Math.max(geometry.width, geometry.height)).toBeLessThanOrEqual(4000)
  })

  it('names the file by the scope it was built for', () => {
    expect(graphExportFilename('global', 'png')).toBe('graph-global.png')
    expect(graphExportFilename('local', 'svg')).toBe('graph-local.svg')
  })
})

describe('graph export svg', () => {
  it('draws one circle per node and one line per edge', () => {
    const svg = graphExportSvg(state([node('a', 0, 0), node('b', 40, 0)]), FALLBACK_PALETTE, prefs())
    expect(svg.match(/<circle/g)).toHaveLength(2)
    expect(svg.match(/<line/g)).toHaveLength(1)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.endsWith('</svg>\n')).toBe(true)
  })

  it('leaves the ground out when a transparent picture was asked for', () => {
    const scene = state([node('a', 0, 0)])
    expect(graphExportSvg(scene, FALLBACK_PALETTE, prefs())).toContain('<rect')
    expect(graphExportSvg(scene, FALLBACK_PALETTE, prefs({ exportTransparentBackground: true }))).not.toContain('<rect')
  })

  it('honours the title and arrow toggles', () => {
    const scene = state([node('a', 0, 0), node('b', 40, 0)])
    expect(graphExportSvg(scene, FALLBACK_PALETTE, prefs())).toContain('<text')
    expect(graphExportSvg(scene, FALLBACK_PALETTE, prefs({ exportWithoutTitles: true }))).not.toContain('<text')
    expect(graphExportSvg(scene, FALLBACK_PALETTE, prefs({ arrows: false }))).not.toContain('<polygon')
  })

  it('hollows an unresolved node and rings a pinned one', () => {
    const svg = graphExportSvg(state([node('ghost', 0, 0, { kind: 'unresolved' })]), FALLBACK_PALETTE, prefs())
    expect(svg).toContain('fill="none" stroke="#777777"')
    const pinned = graphExportSvg(state([node('a', 0, 0, { pinned: true })]), FALLBACK_PALETTE, prefs())
    expect(pinned.match(/<circle/g)).toHaveLength(2)
    expect(pinned).toContain(`r="8.5"`)
  })

  it('escapes a colour or a title that carries markup', () => {
    const hostile = { ...FALLBACK_PALETTE, label: '"><script>alert(1)</script>' }
    const svg = graphExportSvg(state([node('"><script>alert(1)</script>', 0, 0)]), hostile, prefs())
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&quot;&gt;')
  })

  it('rounds coordinates to two decimals so the file stays readable', () => {
    const svg = graphExportSvg(state([node('a', 1.23456, 2.0009)]), FALLBACK_PALETTE, prefs())
    expect(svg).toContain('cx="1.23"')
    expect(svg).toContain('cy="2"')
  })
})
