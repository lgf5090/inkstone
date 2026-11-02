import type { GraphAnalysisResult, GraphFeatureValue, TrigMode } from '../types'
import type { GraphNode } from './parser'
import { containsVariable } from './plot'
import type { GraphViewport } from './plot'
import { evaluateNode } from './evaluate'

export function formatGraphNumber(value: number, significant = 8): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) < 1e-12) return '0'
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  if (magnitude >= significant || magnitude <= -6) return value.toExponential(Math.max(0, significant - 1))
  return Number(value.toPrecision(significant)).toString()
}

interface Sample {
  x: number
  y: number
}

function sampleFunction(node: GraphNode, viewport: GraphViewport, variables: Record<string, number>, trigMode: TrigMode, count = 2000): Sample[] {
  const samples: Sample[] = []
  for (let index = 0; index <= count; index++) {
    const x = viewport.xMin + ((viewport.xMax - viewport.xMin) * index) / count
    const y = evaluateNode(node, { x, vars: variables, trigMode })
    samples.push({ x, y })
  }
  return samples
}

function bisect(node: GraphNode, left: number, right: number, variables: Record<string, number>, trigMode: TrigMode): number {
  let a = left
  let b = right
  let fa = evaluateNode(node, { x: a, vars: variables, trigMode })
  for (let index = 0; index < 60; index++) {
    const middle = (a + b) / 2
    const fm = evaluateNode(node, { x: middle, vars: variables, trigMode })
    if (!Number.isFinite(fm)) break
    if (Math.abs(fm) < 1e-12 || Math.abs(b - a) < 1e-12) return middle
    if (Math.sign(fa) === Math.sign(fm)) {
      a = middle
      fa = fm
    } else {
      b = middle
    }
  }
  return (a + b) / 2
}

function refineExtremum(node: GraphNode, left: number, right: number, variables: Record<string, number>, trigMode: TrigMode, maximize: boolean): Sample {
  let a = left
  let b = right
  for (let index = 0; index < 80; index++) {
    const m1 = a + (b - a) / 3
    const m2 = b - (b - a) / 3
    const f1 = evaluateNode(node, { x: m1, vars: variables, trigMode })
    const f2 = evaluateNode(node, { x: m2, vars: variables, trigMode })
    if (!Number.isFinite(f1) || !Number.isFinite(f2)) break
    if (maximize ? f1 < f2 : f1 > f2) a = m1
    else b = m2
  }
  let x = (a + b) / 2
  if (Math.abs(x) < 1e-6) x = 0
  return { x, y: evaluateNode(node, { x, vars: variables, trigMode }) }
}

function intervals(values: number[], formatter: (value: number) => string): string[] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a - b)
  const unique: number[] = []
  for (const value of sorted) {
    if (unique.length === 0 || Math.abs(unique[unique.length - 1] - value) > 1e-8) unique.push(value)
  }
  return unique.map(formatter)
}

function analyzePeriodicity(node: GraphNode, viewport: GraphViewport, variables: Record<string, number>, trigMode: TrigMode): number | null {
  const candidates = trigMode === 'deg'
    ? [90, 180, 360, 1, 2, 5, 10]
    : trigMode === 'grad'
      ? [100, 200, 400, 1, 2, 5, 10]
      : [Math.PI / 2, Math.PI, 2 * Math.PI, 1, 2, 3, 4, 5, 10]
  for (const period of candidates) {
    let matches = true
    for (let index = 0; index <= 24; index++) {
      const x = viewport.xMin + ((viewport.xMax - viewport.xMin) * index) / 24
      const left = evaluateNode(node, { x, vars: variables, trigMode })
      const right = evaluateNode(node, { x: x + period, vars: variables, trigMode })
      if (!Number.isFinite(left) || !Number.isFinite(right) || Math.abs(left - right) > 1e-6 * Math.max(1, Math.abs(left))) {
        matches = false
        break
      }
    }
    if (matches) return period
  }
  return null
}

function analyzeParity(node: GraphNode, viewport: GraphViewport, variables: Record<string, number>, trigMode: TrigMode): string {
  let even = true
  let odd = true
  for (let index = 1; index <= 40; index++) {
    const x = viewport.xMin + ((viewport.xMax - viewport.xMin) * index) / 41
    const fx = evaluateNode(node, { x, vars: variables, trigMode })
    const minus = evaluateNode(node, { x: -x, vars: variables, trigMode })
    if (!Number.isFinite(fx) || !Number.isFinite(minus)) continue
    const tolerance = 1e-6 * Math.max(1, Math.abs(fx))
    if (Math.abs(fx - minus) > tolerance) even = false
    if (Math.abs(fx + minus) > tolerance) odd = false
    if (!even && !odd) break
  }
  return even ? 'even' : odd ? 'odd' : 'neither'
}

function detectAsymptotes(samples: Sample[], viewport: GraphViewport): number[] {
  const result: number[] = []
  for (let index = 1; index < samples.length - 1; index++) {
    const previous = samples[index - 1]
    const current = samples[index]
    const next = samples[index + 1]
    if (!Number.isFinite(current.y)) {
      const left = previous
      const right = next
      if (Number.isFinite(left.y) && Number.isFinite(right.y) && Math.abs(left.y) > 1e6 && Math.abs(right.y) > 1e6) {
        result.push(current.x)
      } else if (Number.isFinite(left.y) || Number.isFinite(right.y)) {
        result.push(current.x)
      }
      continue
    }
    const span = Math.abs(viewport.yMax - viewport.yMin)
    if (Math.abs(current.y - previous.y) > span * 20 || Math.abs(next.y - current.y) > span * 20) {
      result.push(current.x)
    }
  }
  return result
}

export function analyzeFunction(
  node: GraphNode,
  viewport: GraphViewport,
  variables: Record<string, number>,
  trigMode: TrigMode,
): GraphAnalysisResult {
  if (containsVariable(node, 'y')) {
    return { error: 'variable_not_x', features: [] }
  }
  for (const name of Object.keys(variables)) {
    if (name !== 'x' && containsVariable(node, name)) {
      // Parameters are allowed to be sliders, but a graph analysis is only defined for f(x).
    }
  }
  const samples = sampleFunction(node, viewport, variables, trigMode)
  const finite = samples.filter((sample) => Number.isFinite(sample.y))
  if (finite.length === 0) return { error: 'could_not_analyze', features: [] }

  const xValues = finite.map((sample) => sample.x)
  const yValues = finite.map((sample) => sample.y)
  const xMin = xValues[0] ?? viewport.xMin
  const xMax = xValues[xValues.length - 1] ?? viewport.xMax
  const yMin = Math.min(...yValues)
  const yMax = Math.max(...yValues)

  const zeros: number[] = []
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]
    const current = samples[index]
    if (!Number.isFinite(previous.y) || !Number.isFinite(current.y)) continue
    if (previous.y === 0) zeros.push(previous.x)
    else if (previous.y * current.y < 0) zeros.push(bisect(node, previous.x, current.x, variables, trigMode))
  }

  const minima: Sample[] = []
  const maxima: Sample[] = []
  for (let index = 1; index < samples.length - 1; index++) {
    const previous = samples[index - 1]
    const current = samples[index]
    const next = samples[index + 1]
    if (![previous.y, current.y, next.y].every(Number.isFinite)) continue
    if (current.y < previous.y && current.y < next.y) minima.push(refineExtremum(node, previous.x, next.x, variables, trigMode, false))
    if (current.y > previous.y && current.y > next.y) maxima.push(refineExtremum(node, previous.x, next.x, variables, trigMode, true))
  }

  const inflections: number[] = []
  for (let index = 1; index < samples.length - 1; index++) {
    const a = samples[index - 1]
    const b = samples[index]
    const c = samples[index + 1]
    if (![a.y, b.y, c.y].every(Number.isFinite)) continue
    const leftSecond = a.y - 2 * b.y + c.y
    if (index > 1) {
      const p = samples[index - 2]
      if (Number.isFinite(p.y)) {
        const rightSecond = p.y - 2 * a.y + b.y
        if (leftSecond === 0 || Math.sign(leftSecond) !== Math.sign(rightSecond)) inflections.push(b.x)
      }
    }
  }

  const monotone: string[] = []
  const critical = [...minima.map((point) => point.x), ...maxima.map((point) => point.x)].sort((a, b) => a - b)
  const boundaries = [xMin, ...critical, xMax]
  for (let index = 0; index < boundaries.length - 1; index++) {
    const left = boundaries[index]
    const right = boundaries[index + 1]
    if (right - left < 1e-9) continue
    const middle = (left + right) / 2
    const value = evaluateNode(node, { x: middle, vars: variables, trigMode })
    if (!Number.isFinite(value)) continue
    const delta = evaluateNode(node, { x: middle + (right - left) / 100, vars: variables, trigMode }) - value
    monotone.push(`${formatGraphNumber(left)} – ${formatGraphNumber(right)} ${delta >= 0 ? 'increasing' : 'decreasing'}`)
  }

  const vertical = detectAsymptotes(samples, viewport)
  const farLeft = xMin - 1e6
  const farthestLeft = xMin - 1e12
  const farRight = xMax + 1e6
  const farthestRight = xMax + 1e12
  const leftNear = evaluateNode(node, { x: farLeft, vars: variables, trigMode })
  const leftFar = evaluateNode(node, { x: farthestLeft, vars: variables, trigMode })
  const rightNear = evaluateNode(node, { x: farRight, vars: variables, trigMode })
  const rightFar = evaluateNode(node, { x: farthestRight, vars: variables, trigMode })
  const stable = (near: number, far: number): boolean =>
    Number.isFinite(near) && Number.isFinite(far) && Math.abs(near - far) <= 1e-3 * Math.max(1, Math.abs(near), Math.abs(far))
  const horizontal: number[] = []
  if (stable(leftNear, leftFar) && Math.abs(leftNear) < 1e9) horizontal.push(leftNear)
  if (stable(rightNear, rightFar) && Math.abs(rightNear) < 1e9) horizontal.push(rightNear)
  const oblique: string[] = []
  const leftSlope = leftNear / farLeft
  const leftSlopeFar = leftFar / farthestLeft
  const rightSlope = rightNear / farRight
  const rightSlopeFar = rightFar / farthestRight
  const leftIntercept = leftNear - leftSlope * farLeft
  const leftInterceptFar = leftFar - leftSlopeFar * farthestLeft
  const rightIntercept = rightNear - rightSlope * farRight
  const rightInterceptFar = rightFar - rightSlopeFar * farthestRight
  if (Math.abs(leftSlope) > 1e-9 && stable(leftSlope, leftSlopeFar) && stable(leftIntercept, leftInterceptFar)) {
    oblique.push(`y = ${formatGraphNumber(leftSlope)}x + ${formatGraphNumber(leftIntercept)}`)
  }
  if (Math.abs(rightSlope) > 1e-9 && stable(rightSlope, rightSlopeFar) && stable(rightIntercept, rightInterceptFar)) {
    oblique.push(`y = ${formatGraphNumber(rightSlope)}x + ${formatGraphNumber(rightIntercept)}`)
  }

  const feature = (titleKey: string, values: string[], isText = false): GraphFeatureValue => ({ titleKey, values, isText })
  return {
    error: 'none',
    features: [
      feature('domain', [`${formatGraphNumber(xMin)} – ${formatGraphNumber(xMax)}`], true),
      feature('range', [`${formatGraphNumber(yMin)} – ${formatGraphNumber(yMax)}`], true),
      feature('zeros', intervals(zeros, (value) => formatGraphNumber(value)), true),
      feature('y_intercept', Number.isFinite(evaluateNode(node, { x: 0, vars: variables, trigMode })) ? [formatGraphNumber(evaluateNode(node, { x: 0, vars: variables, trigMode }))] : [], true),
      feature('minima', minima.map((point) => `(${formatGraphNumber(point.x)}, ${formatGraphNumber(point.y)})`), true),
      feature('maxima', maxima.map((point) => `(${formatGraphNumber(point.x)}, ${formatGraphNumber(point.y)})`), true),
      feature('inflection', intervals(inflections, (value) => formatGraphNumber(value)), true),
      feature('vertical_asymptote', intervals(vertical, (value) => `x = ${formatGraphNumber(value)}`), true),
      feature('horizontal_asymptote', intervals(horizontal, (value) => `y = ${formatGraphNumber(value)}`), true),
      feature('oblique_asymptote', oblique, true),
      feature('parity', [analyzeParity(node, viewport, variables, trigMode)], true),
      feature('periodicity', (() => {
        const period = analyzePeriodicity(node, viewport, variables, trigMode)
        return period === null ? [] : [formatGraphNumber(period)]
      })(), true),
      feature('monotone', monotone, true),
    ],
  }
}
