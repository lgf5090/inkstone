import type { ProjectProperty, ProjectRollupAggregation } from './model'

function format(value: number): string {
  return String(Math.round(value * 1e6) / 1e6)
}

export function evaluateProjectRollup(targetValues: readonly string[], aggregation: ProjectRollupAggregation): string {
  if (aggregation === 'count') return String(targetValues.length)
  const numbers = targetValues
    .filter((value) => value.trim() !== '')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
  if (!numbers.length) return ''
  if (aggregation === 'sum') return format(numbers.reduce((sum, value) => sum + value, 0))
  if (aggregation === 'avg') return format(numbers.reduce((sum, value) => sum + value, 0) / numbers.length)
  if (aggregation === 'min') return format(Math.min(...numbers))
  return format(Math.max(...numbers))
}

export function projectRollupDependencies(properties: readonly ProjectProperty[]): Map<string, string> {
  const rollupIds = new Set(
    properties.filter((property) => property.type === 'rollup' && property.config?.rollup).map((property) => property.id),
  )
  const dependencies = new Map<string, string>()
  for (const property of properties) {
    if (!rollupIds.has(property.id) || !property.config?.rollup) continue
    const target = property.config.rollup.targetPropertyId
    if (rollupIds.has(target)) dependencies.set(property.id, target)
  }
  return dependencies
}

export function projectRollupCycleIds(properties: readonly ProjectProperty[]): Set<string> {
  const dependencies = projectRollupDependencies(properties)
  const cycles = new Set<string>()
  const state = new Map<string, number>()
  const path: string[] = []
  const visit = (id: string): void => {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) {
      const start = path.indexOf(id)
      for (const entry of path.slice(start < 0 ? 0 : start)) cycles.add(entry)
      return
    }
    state.set(id, 1)
    path.push(id)
    const next = dependencies.get(id)
    if (next) visit(next)
    path.pop()
    state.set(id, 2)
  }
  for (const id of dependencies.keys()) visit(id)
  return cycles
}

export function projectRollupOrder(properties: readonly ProjectProperty[]): string[] {
  const dependencies = projectRollupDependencies(properties)
  const cycles = projectRollupCycleIds(properties)
  const ids = properties
    .filter((property) => property.type === 'rollup' && property.config?.rollup)
    .map((property) => property.id)
  const done = new Set<string>()
  const order: string[] = []
  const visit = (id: string): void => {
    if (done.has(id) || cycles.has(id)) return
    const dependency = dependencies.get(id)
    if (dependency) visit(dependency)
    done.add(id)
    order.push(id)
  }
  for (const id of ids) visit(id)
  return order
}
