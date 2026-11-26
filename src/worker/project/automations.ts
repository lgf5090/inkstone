import type {
  ProjectAutomation,
  ProjectAutomationAction,
  ProjectAutomationCondition,
  ProjectAutomationTrigger,
} from '@shared/project/automation'
import {
  projectAutomationDedupeKey,
  projectAutomationMatches,
  projectAutomationTriggered,
} from '@shared/project/automation'
import type { ProjectAutomationCreateInput, ProjectAutomationPatchInput } from '@shared/project/validation'
import { newProjectId } from '@shared/project/limits'
import type { ProjectBoard, ProjectCard, ProjectProperty } from '@shared/project/model'
import { projectRoleAtLeast } from '@shared/project/model'
import { projectPropertyEditableBy } from '@shared/project/property-config'
import type { AppBindings } from '../env'
import { notifyProjectAutomation } from './notify'
import { cardPatchStatements, getProjectCard } from './cards'
import { assertProjectRelationValues, projectRelationTargets } from './relations'
import { projectRoleForBoard } from './visibility'

interface AutomationRow {
  id: string
  board_id: string
  trigger: string
  condition: string
  action: string
  enabled: number
  created_by: string
  created_at: number
  updated_at: number
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToAutomation(row: AutomationRow): ProjectAutomation {
  return {
    id: row.id,
    boardId: row.board_id,
    trigger: parseJson<ProjectAutomationTrigger>(row.trigger, { type: 'cardValueChanged' }),
    condition: row.condition ? parseJson<ProjectAutomationCondition | null>(row.condition, null) : null,
    action: parseJson<ProjectAutomationAction>(row.action, { type: 'notify', message: '' }),
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listProjectAutomations(db: D1Database, boardId: string): Promise<ProjectAutomation[]> {
  const { results } = await db.prepare('SELECT * FROM project_automations WHERE board_id = ?1 ORDER BY created_at, id')
    .bind(boardId).all<AutomationRow>()
  return results.map(rowToAutomation)
}

export async function getProjectAutomation(db: D1Database, boardId: string, id: string): Promise<ProjectAutomation | null> {
  const row = await db.prepare('SELECT * FROM project_automations WHERE board_id = ?1 AND id = ?2')
    .bind(boardId, id).first<AutomationRow>()
  return row ? rowToAutomation(row) : null
}

export async function createProjectAutomation(
  db: D1Database,
  boardId: string,
  userId: string,
  input: ProjectAutomationCreateInput,
  now: number,
): Promise<ProjectAutomation> {
  const id = input.id ?? newProjectId('automation')
  await db.prepare(
    `INSERT INTO project_automations (id, board_id, trigger, condition, action, enabled, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
  ).bind(
    id, boardId, JSON.stringify(input.trigger), JSON.stringify(input.condition ?? null),
    JSON.stringify(input.action), input.enabled ? 1 : 0, userId, now,
  ).run()
  return (await getProjectAutomation(db, boardId, id))!
}

export async function patchProjectAutomation(
  db: D1Database,
  boardId: string,
  id: string,
  patch: ProjectAutomationPatchInput,
  now: number,
): Promise<ProjectAutomation | null> {
  const current = await getProjectAutomation(db, boardId, id)
  if (!current) return null
  const next = {
    trigger: patch.trigger ?? current.trigger,
    condition: patch.condition === undefined ? current.condition : patch.condition,
    action: patch.action ?? current.action,
    enabled: patch.enabled ?? current.enabled,
  }
  await db.prepare(
    `UPDATE project_automations SET trigger = ?1, condition = ?2, action = ?3, enabled = ?4, updated_at = ?5
     WHERE board_id = ?6 AND id = ?7`,
  ).bind(
    JSON.stringify(next.trigger), JSON.stringify(next.condition ?? null), JSON.stringify(next.action),
    next.enabled ? 1 : 0, now, boardId, id,
  ).run()
  return (await getProjectAutomation(db, boardId, id))!
}

export async function deleteProjectAutomation(db: D1Database, boardId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM project_automations WHERE board_id = ?1 AND id = ?2').bind(boardId, id).run()
}

export async function runProjectAutomations(
  db: D1Database,
  env: AppBindings['Bindings'],
  board: ProjectBoard,
  before: ProjectCard,
  after: ProjectCard,
  properties: readonly ProjectProperty[],
  now: number,
  seen: Set<string>,
  applyEffects?: (before: ProjectCard, after: ProjectCard) => Promise<void>,
): Promise<ProjectCard> {
  const rules = await listProjectAutomations(db, board.id)
  let current = after
  for (const rule of rules) {
    if (!rule.enabled) continue
    const key = projectAutomationDedupeKey(rule.id, after.id, now)
    if (seen.has(key)) continue
    seen.add(key)
    if (!projectAutomationTriggered(rule.trigger, before, current)) continue
    if (!projectAutomationMatches(rule.condition, current)) continue
    const action = rule.action
    try {
      if (action.type === 'setValue') {
        const role = await projectRoleForBoard(db, board.id, rule.createdBy)
        const property = properties.find((entry) => entry.id === action.propertyId)
        if (!role || !projectRoleAtLeast(role, 'editor') || !property || !projectPropertyEditableBy(property, role)) {
          console.warn('[inkstone] project automation skipped by field permission:', { boardId: board.id, cardId: current.id, ruleId: rule.id })
          continue
        }
        const optionIds = new Set(property.options.map((option) => option.id))
        const validValue = property.type === 'select'
          ? action.value === '' || optionIds.has(action.value)
          : property.type === 'multiSelect'
            ? (() => {
                if (action.value === '') return true
                try {
                  const parsed: unknown = JSON.parse(action.value)
                  return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string' && optionIds.has(id))
                } catch { return false }
              })()
            : property.type === 'checkbox' ? action.value === 'true' || action.value === 'false' : true
        if (!validValue) {
          console.warn('[inkstone] project automation skipped by value validation:', { boardId: board.id, cardId: current.id, ruleId: rule.id })
          continue
        }
        const value = action.value === '' && (property.type === 'select' || property.type === 'multiSelect') ? null : action.value
        await assertProjectRelationValues(db, properties, { [property.id]: value }, rule.createdBy)
        await db.batch(cardPatchStatements(db, current, { values: { [property.id]: value } }, rule.createdBy, now, projectRelationTargets(properties)))
        const updated = await getProjectCard(db, current.id)
        if (!updated) continue
        if (applyEffects) await applyEffects(current, updated)
        current = await getProjectCard(db, current.id) ?? updated
      } else {
        await notifyProjectAutomation(db, env, {
          boardId: board.id,
          cardTitle: current.title,
          ownerId: board.ownerId,
          message: action.message,
        })
      }
    } catch (error) {
      console.warn('[inkstone] project automation failed:', {
        boardId: board.id, cardId: current.id, ruleId: rule.id, action: rule.action.type,
      }, error instanceof Error ? error.message : error)
    }
  }
  return current
}
