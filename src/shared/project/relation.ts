import { projectMultiValueIds } from './model'
import { isProjectId } from './limits'

export interface ProjectRelationOption {
  id: string
  title: string
}

export interface ProjectRelationBackReference {
  boardId: string
  fromCardId: string
  propertyId: string
  title: string | null
  visible: boolean
}

export function parseProjectRelationIds(value: string): string[] {
  return projectMultiValueIds(value).filter(isProjectId)
}

export function serializeProjectRelationIds(ids: readonly string[]): string | null {
  const kept = [...new Set(ids)].filter(isProjectId)
  return kept.length ? JSON.stringify(kept) : null
}

export function remapProjectRelationValue(value: string, idMap: ReadonlyMap<string, string>): string {
  const ids = parseProjectRelationIds(value)
  if (!ids.length) return value
  return JSON.stringify(ids.map((id) => idMap.get(id) ?? id))
}
