import type { GraphNode } from './parser'
import type { TrigMode } from '../types'
import { evaluateNode, relationVisible } from './evaluate'

export interface GraphViewport {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

export interface WorldPoint {
  x: number
  y: number
}

export interface PlotSegment {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface PlotCell {
  x: number
  y: number
  width: number
  height: number
}

export interface PlotGeometry {
  curves: WorldPoint[][]
  segments: PlotSegment[]
  cells: PlotCell[]
}

export interface PlotOptions {
  width: number
  height: number
  variables: Record<string, number>
  trigMode: TrigMode
}

export function containsVariable(node: GraphNode, name: string): boolean {
  switch (node.kind) {
    case 'variable':
      return node.name === name
    case 'unary':
      return containsVariable(node.value, name)
    case 'binary':
      return containsVariable(node.left, name) || containsVariable(node.right, name)
    case 'call':
      return node.args.some((arg) => containsVariable(arg, name))
    case 'relation':
      return containsVariable(node.left, name) || containsVariable(node.right, name)
    case 'number':
      return false
  }
}

export function plotEquation(node: GraphNode, viewport: GraphViewport, options: PlotOptions): PlotGeometry {
  const geometry: PlotGeometry = { curves: [], segments: [], cells: [] }
  if (node.kind === 'relation') {
    if (node.op === '=') {
      if (node.left.kind === 'variable' && node.left.name === 'y' && !containsVariable(node.right, 'y')) {
        geometry.curves = sampleExplicitY(node.right, viewport, options)
        return geometry
      }
      if (node.left.kind === 'variable' && node.left.name === 'x' && !containsVariable(node.right, 'x')) {
        geometry.curves = sampleExplicitX(node.right, viewport, options)
        return geometry
      }
      geometry.segments = sampleImplicit(node, viewport, options)
      return geometry
    }
    if (node.left.kind === 'variable' && node.left.name === 'y' && !containsVariable(node.right, 'y')) {
      geometry.cells = sampleInequality((x, y) => relationVisible({ ...node, left: { kind: 'number', value: y } }, { x, y, vars: options.variables, trigMode: options.trigMode }), viewport)
      return geometry
    }
    if (node.left.kind === 'variable' && node.left.name === 'x' && !containsVariable(node.right, 'x')) {
      geometry.cells = sampleInequality((x, y) => relationVisible({ ...node, left: { kind: 'number', value: x } }, { x, y, vars: options.variables, trigMode: options.trigMode }), viewport)
      return geometry
    }
    geometry.cells = sampleInequality((x, y) => relationVisible(node, { x, y, vars: options.variables, trigMode: options.trigMode }), viewport)
    return geometry
  }
  geometry.curves = sampleExplicitY(node, viewport, options)
  return geometry
}

function sampleExplicitY(node: GraphNode, viewport: GraphViewport, options: PlotOptions): WorldPoint[][] {
  const samples = Math.max(80, Math.min(2400, options.width * 2))
  const curves: WorldPoint[][] = []
  let current: WorldPoint[] = []
  let lastY: number | null = null
  const verticalSpan = Math.abs(viewport.yMax - viewport.yMin) || 1
  for (let index = 0; index <= samples; index++) {
    const x = viewport.xMin + ((viewport.xMax - viewport.xMin) * index) / samples
    const y = evaluateNode(node, { x, vars: options.variables, trigMode: options.trigMode })
    const usable = Number.isFinite(y) && Math.abs(y) < 1e12
    if (!usable) {
      if (current.length > 1) curves.push(current)
      current = []
      lastY = null
      continue
    }
    if (lastY !== null && Math.abs(y - lastY) > verticalSpan * 4) {
      if (current.length > 1) curves.push(current)
      current = []
    }
    current.push({ x, y })
    lastY = y
  }
  if (current.length > 1) curves.push(current)
  return curves
}

function sampleExplicitX(node: GraphNode, viewport: GraphViewport, options: PlotOptions): WorldPoint[][] {
  const samples = Math.max(80, Math.min(2400, options.height * 2))
  const curves: WorldPoint[][] = []
  let current: WorldPoint[] = []
  let lastX: number | null = null
  const horizontalSpan = Math.abs(viewport.xMax - viewport.xMin) || 1
  for (let index = 0; index <= samples; index++) {
    const y = viewport.yMax - ((viewport.yMax - viewport.yMin) * index) / samples
    const x = evaluateNode(node, { y, vars: options.variables, trigMode: options.trigMode })
    const usable = Number.isFinite(x) && Math.abs(x) < 1e12
    if (!usable) {
      if (current.length > 1) curves.push(current)
      current = []
      lastX = null
      continue
    }
    if (lastX !== null && Math.abs(x - lastX) > horizontalSpan * 4) {
      if (current.length > 1) curves.push(current)
      current = []
    }
    current.push({ x, y })
    lastX = x
  }
  if (current.length > 1) curves.push(current)
  return curves
}

function sampleImplicit(node: GraphNode, viewport: GraphViewport, options: PlotOptions): PlotSegment[] {
  const columns = 90
  const rows = 90
  const segments: PlotSegment[] = []
  const values: number[][] = []
  for (let row = 0; row <= rows; row++) {
    const y = viewport.yMin + ((viewport.yMax - viewport.yMin) * row) / rows
    const line: number[] = []
    for (let column = 0; column <= columns; column++) {
      const x = viewport.xMin + ((viewport.xMax - viewport.xMin) * column) / columns
      const value = node.kind === 'relation' ? evaluateNode(node.left, { x, y, vars: options.variables, trigMode: options.trigMode }) - evaluateNode(node.right, { x, y, vars: options.variables, trigMode: options.trigMode }) : evaluateNode(node, { x, y, vars: options.variables, trigMode: options.trigMode })
      line.push(Number.isFinite(value) ? value : NaN)
    }
    values.push(line)
  }
  const point = (column: number, row: number): WorldPoint => ({
    x: viewport.xMin + ((viewport.xMax - viewport.xMin) * column) / columns,
    y: viewport.yMin + ((viewport.yMax - viewport.yMin) * row) / rows,
  })
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const corners = [values[row][column], values[row][column + 1], values[row + 1][column + 1], values[row + 1][column]]
      if (corners.some((value) => !Number.isFinite(value))) continue
      const edges: { a: number; b: number; pa: WorldPoint; pb: WorldPoint; va: number; vb: number }[] = [
        { a: corners[0], b: corners[1], pa: point(column, row), pb: point(column + 1, row), va: corners[0], vb: corners[1] },
        { a: corners[1], b: corners[2], pa: point(column + 1, row), pb: point(column + 1, row + 1), va: corners[1], vb: corners[2] },
        { a: corners[2], b: corners[3], pa: point(column + 1, row + 1), pb: point(column, row + 1), va: corners[2], vb: corners[3] },
        { a: corners[3], b: corners[0], pa: point(column, row + 1), pb: point(column, row), va: corners[3], vb: corners[0] },
      ]
      const crossings = edges.filter((edge) => (edge.a <= 0 && edge.b > 0) || (edge.a >= 0 && edge.b < 0))
      if (crossings.length === 2) {
        const [first, second] = crossings
        const interpolate = (edge: (typeof crossings)[number]): WorldPoint => {
          const t = Math.abs(edge.va) / (Math.abs(edge.va) + Math.abs(edge.vb) || 1)
          return { x: edge.pa.x + (edge.pb.x - edge.pa.x) * t, y: edge.pa.y + (edge.pb.y - edge.pa.y) * t }
        }
        const start = interpolate(first)
        const end = interpolate(second)
        segments.push({ x1: start.x, y1: start.y, x2: end.x, y2: end.y })
      }
    }
  }
  return segments
}

function sampleInequality(
  visible: (x: number, y: number) => boolean,
  viewport: GraphViewport,
): PlotCell[] {
  const columns = 60
  const rows = 60
  const width = (viewport.xMax - viewport.xMin) / columns
  const height = (viewport.yMax - viewport.yMin) / rows
  const cells: PlotCell[] = []
  for (let row = 0; row < rows; row++) {
    const y = viewport.yMin + row * height
    for (let column = 0; column < columns; column++) {
      const x = viewport.xMin + column * width
      if (visible(x + width / 2, y + height / 2)) cells.push({ x, y, width, height })
    }
  }
  return cells
}
