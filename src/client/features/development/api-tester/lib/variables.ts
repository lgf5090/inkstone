import { DYNAMIC_VARIABLES } from '@shared/development/api-tester/keywords'
import type { ApiTesterState, EnvVariable, TagNode } from '@shared/development/api-tester/types'

export interface Variable {
  key: string
  value: string
  enabled?: boolean
}

function guid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = (Math.random() * 16) | 0
    const value = character === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

const DYNAMIC_FNS: Record<string, () => string> = {
  $guid: guid,
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $randomInt: () => String(Math.floor(Math.random() * 1000)),
  $randomFloat: () => String(Math.random()),
}

export function isDynamicVariable(name: string): boolean {
  return (DYNAMIC_VARIABLES as readonly string[]).includes(name)
}

export function resolveVariable(raw: string, variables: readonly Variable[]): string {
  if (!raw) return raw
  return raw.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, name: string) => {
    const key = name.trim()
    const dynamic = DYNAMIC_FNS[key]
    if (dynamic) return dynamic()
    const found = variables.find((variable) => variable.enabled !== false && variable.key === key)
    return found ? found.value : match
  })
}

export function collectVarNames(raw: string): string[] {
  if (!raw) return []
  const found = new Set<string>()
  const pattern = /\{\{\s*([^}]+?)\s*\}\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw))) {
    const name = match[1]!.trim()
    if (!DYNAMIC_FNS[name]) found.add(name)
  }
  return [...found]
}

export function activeVariables(state: ApiTesterState): Variable[] {
  const globals = (state.globalVariables ?? []).filter((variable) => variable.enabled)
  if (!state.activeEnvId) return globals
  const environment = state.environments.find((entry) => entry.id === state.activeEnvId)
  if (!environment) return globals
  const environmentKeys = new Set(environment.variables.filter((variable) => variable.enabled).map((variable) => variable.key))
  return [
    ...globals.filter((variable) => !environmentKeys.has(variable.key)),
    ...environment.variables.filter((variable) => variable.enabled),
  ]
}

export function variableRecord(variables: readonly Variable[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const variable of variables) {
    if (variable.enabled !== false && variable.key) record[variable.key] = variable.value
  }
  return record
}

export function tagPath(tags: readonly TagNode[], tagId: string): string {
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const parts: string[] = []
  let current = byId.get(tagId)
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    parts.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return parts.join(' / ')
}

export function secretVariableValue(variable: EnvVariable, revealed: boolean): string {
  if (!variable.secret || revealed) return variable.value
  return variable.value ? '••••••••' : ''
}
