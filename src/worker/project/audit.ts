import type { ProjectActivityChange } from '@shared/project/model'
import { newProjectId } from '@shared/project/limits'

export type ProjectAuditEntity = ProjectActivityChange['entity']

export interface ProjectAuditSnapshot {
  entity: ProjectAuditEntity
  id: string
  value: Record<string, unknown> | null
}

const AUDIT_FIELDS: Record<ProjectAuditEntity, readonly string[]> = {
  board: ['title', 'description', 'icon', 'showDescription', 'type', 'minimumRole', 'archived', 'updatedCardProperties', 'deletedCardProperties'],
  card: ['title', 'icon', 'parentId', 'isTemplate', 'contentOrder', 'recurrence', 'completedAt', 'boardId', 'values'],
  comment: ['body'],
  content: ['type', 'title', 'fields'],
  view: ['title', 'viewType', 'fields', 'position'],
}

const MAX_AUDIT_VALUE_CHARS = 2_000
const MAX_AUDIT_CHANGES = 50

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function auditValue(value: unknown): string | null {
  if (value === undefined) return null
  const serialized = JSON.stringify(value)
  return serialized.length > MAX_AUDIT_VALUE_CHARS ? `${serialized.slice(0, MAX_AUDIT_VALUE_CHARS)}…` : serialized
}

function sameValue(left: unknown, right: unknown): boolean {
  return auditValue(left) === auditValue(right)
}

function pushChange(changes: ProjectActivityChange[], change: ProjectActivityChange): void {
  if (changes.length < MAX_AUDIT_CHANGES && !sameValue(change.oldValue, change.newValue)) changes.push(change)
}

export function diffProjectAuditSnapshot(
  snapshot: ProjectAuditSnapshot,
  patch: unknown,
  next: Record<string, unknown> | null,
  method: string,
): ProjectActivityChange[] {
  const changes: ProjectActivityChange[] = []
  if (method === 'DELETE') {
    pushChange(changes, {
      entity: snapshot.entity,
      entityId: snapshot.id,
      field: 'deleted',
      oldValue: false,
      newValue: true,
    })
    return changes
  }
  if (!isRecord(patch)) return changes
  const before = snapshot.value ?? {}
  for (const field of AUDIT_FIELDS[snapshot.entity]) {
    if (!(field in patch)) continue
    if (field === 'values' && snapshot.entity === 'card') {
      const oldValues = isRecord(before.values) ? before.values : {}
      const newValues = isRecord(next?.values) ? next.values : {}
      const requested = isRecord(patch.values) ? patch.values : {}
      for (const propertyId of Object.keys(requested)) {
        pushChange(changes, {
          entity: snapshot.entity,
          entityId: snapshot.id,
          field: `values.${propertyId}`,
          oldValue: oldValues[propertyId],
          newValue: newValues[propertyId],
        })
      }
      continue
    }
    pushChange(changes, {
      entity: snapshot.entity,
      entityId: snapshot.id,
      field,
      oldValue: before[field],
      newValue: next?.[field],
    })
  }
  return changes
}

export function createProjectAuditChanges(
  entity: ProjectAuditEntity,
  id: string,
  input: unknown,
  next: Record<string, unknown> | null,
): ProjectActivityChange[] {
  if (!isRecord(input)) return []
  const changes: ProjectActivityChange[] = []
  for (const field of AUDIT_FIELDS[entity]) {
    if (!(field in input)) continue
    if (field === 'values' && entity === 'card' && isRecord(input.values)) {
      for (const propertyId of Object.keys(input.values)) {
        pushChange(changes, {
          entity,
          entityId: id,
          field: `values.${propertyId}`,
          newValue: isRecord(next?.values) ? next.values[propertyId] : input.values[propertyId],
        })
      }
      continue
    }
    pushChange(changes, { entity, entityId: id, field, newValue: next && field in next ? next[field] : input[field] })
  }
  return changes
}

export async function recordProjectActivityChanges(
  db: D1Database,
  activityId: string,
  boardId: string,
  actorId: string,
  changes: readonly ProjectActivityChange[],
  now: number,
): Promise<void> {
  if (changes.length === 0) return
  await db.batch(changes.slice(0, MAX_AUDIT_CHANGES).map((change) => db.prepare(
    `INSERT INTO project_activity_changes
      (id, activity_id, board_id, actor_id, entity_type, entity_id, field_key, old_value, new_value, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(
    newProjectId('activity'), activityId, boardId, actorId, change.entity, change.entityId,
    change.field, auditValue(change.oldValue), auditValue(change.newValue), now,
  )))
}

export async function listProjectActivityChanges(
  db: D1Database,
  activityIds: readonly string[],
): Promise<Map<string, ProjectActivityChange[]>> {
  const grouped = new Map<string, ProjectActivityChange[]>()
  for (let offset = 0; offset < activityIds.length; offset += 90) {
    const ids = activityIds.slice(offset, offset + 90)
    if (ids.length === 0) continue
    const placeholders = ids.map((_, index) => `?${index + 1}`).join(',')
    const { results } = await db.prepare(
      `SELECT activity_id, entity_type, entity_id, field_key, old_value, new_value
       FROM project_activity_changes WHERE activity_id IN (${placeholders}) ORDER BY created_at, id`,
    ).bind(...ids).all<{
      activity_id: string
      entity_type: ProjectAuditEntity
      entity_id: string
      field_key: string
      old_value: string | null
      new_value: string | null
    }>()
    for (const row of results) {
      const list = grouped.get(row.activity_id) ?? []
      list.push({
        entity: row.entity_type,
        entityId: row.entity_id,
        field: row.field_key,
        ...(row.old_value === null ? {} : { oldValue: JSON.parse(row.old_value) as unknown }),
        ...(row.new_value === null ? {} : { newValue: JSON.parse(row.new_value) as unknown }),
      })
      grouped.set(row.activity_id, list)
    }
  }
  return grouped
}
