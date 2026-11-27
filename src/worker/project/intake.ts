import type { ProjectIntakeConfig, ProjectProperty } from '@shared/project/model'
import { PROJECT_INTAKE_PROPERTY_TYPES } from '@shared/project/model'
import { projectPropertyEditableBy } from '@shared/project/property-config'
import { ApiError } from '../lib/errors'
import { assertProjectValuesWritable } from './property-access'

const PUBLIC_INTAKE_PROPERTY_TYPES: ReadonlySet<ProjectProperty['type']> = new Set(PROJECT_INTAKE_PROPERTY_TYPES)

export function publicIntakeProperties(properties: readonly ProjectProperty[], config: ProjectIntakeConfig): ProjectProperty[] {
  const allowed = new Set(config.propertyIds)
  return properties.filter((property) => allowed.has(property.id) && PUBLIC_INTAKE_PROPERTY_TYPES.has(property.type))
}

export async function assertPublicIntakeValues(
  db: D1Database,
  boardId: string,
  properties: readonly ProjectProperty[],
  config: ProjectIntakeConfig,
  values: Record<string, string>,
): Promise<void> {
  if (!config.enabled) throw ApiError.notFound('Intake is not enabled')
  const byId = new Map(properties.map((property) => [property.id, property]))
  const allowed = new Set(config.propertyIds)
  for (const propertyId of Object.keys(values)) {
    if (!allowed.has(propertyId)) throw ApiError.badRequest('Field is not allowed in this form')
  }
  for (const propertyId of config.requiredPropertyIds) {
    if (!(values[propertyId] ?? '').trim()) throw ApiError.badRequest('Required field is missing')
  }
  for (const propertyId of allowed) {
    const property = byId.get(propertyId)
    if (!property || !PUBLIC_INTAKE_PROPERTY_TYPES.has(property.type) || !projectPropertyEditableBy(property, 'editor')) {
      throw ApiError.badRequest('Form field is not editable')
    }
  }
  await assertProjectValuesWritable(db, boardId, 'editor', values)
}
