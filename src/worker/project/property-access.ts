/**
 * The write half of field permissions: a property may name the roles allowed to edit it, and a caller
 * that is not one of them must be refused before the row is touched. Reads are redacted in `bundle.ts`
 * by the same rule, so a hidden property cannot be edited by guessing its id either.
 */
import type { ProjectRole } from '@shared/project/model'
import { projectPropertyEditableBy } from '@shared/project/property-config'
import { ApiError } from '../lib/errors'
import { readBoardProperties } from './boards'

export async function assertProjectValuesWritable(
  db: D1Database,
  boardId: string,
  role: ProjectRole,
  values: Record<string, unknown> | undefined,
): Promise<void> {
  if (!values) return
  const properties = await readBoardProperties(db, boardId)
  const byId = new Map(properties.map((property) => [property.id, property]))
  for (const propertyId of Object.keys(values)) {
    const property = byId.get(propertyId)
    if (property && !projectPropertyEditableBy(property, role)) {
      throw ApiError.forbidden(`property ${propertyId} is not editable by this role`)
    }
  }
}
