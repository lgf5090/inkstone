/**
 * Reading and writing a property's settings JSON.
 *
 * The column is free-form so a new capability does not need a migration, which makes this the one
 * place that decides what a stored object may say: unknown keys are dropped, role lists are reduced
 * to the four real roles, and an empty result is `undefined` rather than an empty object so callers
 * can tell "no settings" from "settings that say nothing".
 */
import type { ProjectProperty, ProjectPropertyConfig, ProjectRole } from './model'
import { PROJECT_PROPERTY_CAPABILITIES, PROJECT_ROLES } from './model'

function readRoles(value: unknown): ProjectRole[] | undefined {
  if (!Array.isArray(value)) return undefined
  const roles = PROJECT_ROLES.filter((role) => value.includes(role))
  return roles.length ? roles : undefined
}

export function parseProjectPropertyConfig(raw: string | null | undefined): ProjectPropertyConfig | undefined {
  if (!raw || raw === '{}') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const config: ProjectPropertyConfig = {}
  if (typeof record.targetBoardId === 'string' && record.targetBoardId) config.targetBoardId = record.targetBoardId.slice(0, 64)
  if (typeof record.expression === 'string' && record.expression.trim()) config.expression = record.expression.slice(0, 500)
  if (record.multiple === true) config.multiple = true
  const viewRoles = readRoles(record.viewRoles)
  if (viewRoles) config.viewRoles = viewRoles
  const editRoles = readRoles(record.editRoles)
  if (editRoles) config.editRoles = editRoles
  return Object.keys(config).length ? config : undefined
}

export function serializeProjectPropertyConfig(config: ProjectPropertyConfig | undefined): string {
  return JSON.stringify(config ?? {})
}

/** A role list that is absent or empty means every role; the check is the same in both directions. */
export function projectPropertyVisibleTo(property: ProjectProperty, role: ProjectRole): boolean {
  const roles = property.config?.viewRoles
  return !roles || roles.length === 0 || roles.includes(role)
}

export function projectPropertyEditableBy(property: ProjectProperty, role: ProjectRole): boolean {
  if (PROJECT_PROPERTY_CAPABILITIES[property.type].readOnly) return false
  const roles = property.config?.editRoles
  return !roles || roles.length === 0 || roles.includes(role)
}
