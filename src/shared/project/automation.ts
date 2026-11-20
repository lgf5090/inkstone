import type { ProjectCard } from './model'

export interface ProjectAutomationTrigger {
  type: 'cardValueChanged'
  propertyId?: string
}

export interface ProjectAutomationCondition {
  propertyId: string
  op: 'equals' | 'notEquals' | 'isSet' | 'isEmpty'
  value: string
}

export type ProjectAutomationAction =
  | { type: 'setValue', propertyId: string, value: string }
  | { type: 'notify', message: string }

export interface ProjectAutomation {
  id: string
  boardId: string
  trigger: ProjectAutomationTrigger
  condition: ProjectAutomationCondition | null
  action: ProjectAutomationAction
  enabled: boolean
  createdBy: string
  createdAt: number
  updatedAt: number
}

export function projectAutomationTriggered(
  trigger: ProjectAutomationTrigger,
  before: ProjectCard,
  after: ProjectCard,
): boolean {
  if (trigger.type !== 'cardValueChanged') return false
  if (trigger.propertyId) {
    return (before.values[trigger.propertyId] ?? '') !== (after.values[trigger.propertyId] ?? '')
  }
  return true
}

export function projectAutomationMatches(
  condition: ProjectAutomationCondition | null,
  card: ProjectCard,
): boolean {
  if (!condition) return true
  const raw = card.values[condition.propertyId] ?? ''
  if (condition.op === 'equals') return raw === condition.value
  if (condition.op === 'notEquals') return raw !== condition.value
  if (condition.op === 'isSet') return raw !== ''
  return raw === ''
}

export function projectAutomationDedupeKey(ruleId: string, cardId: string, now: number): string {
  return `${ruleId}:${cardId}:${now}`
}
