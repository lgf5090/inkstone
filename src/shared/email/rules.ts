import { isValidEmailAddress, normalizeEmailAddress } from './format'
import { EMAIL_INBOUND_MAX_BYTES } from './model'
import { isValidEmailTagPath, normalizeEmailTagPath } from './tags'

export const EMAIL_FILTER_NAME_MAX_CHARS = 80
export const EMAIL_FILTER_MAX_RULES = 20
export const EMAIL_FILTER_MAX_CONDITIONS = 5
export const EMAIL_FILTER_MAX_ACTIONS = 5
export const EMAIL_FILTER_TEXT_MAX_CHARS = 200
export const EMAIL_FILTER_FOLDER_REF_MAX_CHARS = 120

export const EMAIL_FILTER_CONDITION_FIELDS = [
  'fromContains',
  'toContains',
  'subjectContains',
  'hasAttachment',
  'minBytes',
] as const

export const EMAIL_FILTER_ACTION_TYPES = ['moveTo', 'addTag', 'markRead', 'star', 'trash'] as const
export const EMAIL_FILTER_MATCH_MODES = ['all', 'any'] as const

export type EmailFilterConditionField = (typeof EMAIL_FILTER_CONDITION_FIELDS)[number]

export type EmailFilterActionType = (typeof EMAIL_FILTER_ACTION_TYPES)[number]

export type EmailFilterMatchMode = (typeof EMAIL_FILTER_MATCH_MODES)[number]

export type EmailFilterCondition =
  | { field: 'fromContains'; value: string; negate?: boolean }
  | { field: 'toContains'; value: string; negate?: boolean }
  | { field: 'subjectContains'; value: string; negate?: boolean }
  | { field: 'hasAttachment'; value: boolean; negate?: boolean }
  | { field: 'minBytes'; value: number; negate?: boolean }

export type EmailFilterAction =
  | { type: 'moveTo'; folder: string }
  | { type: 'addTag'; tag: string }
  | { type: 'markRead' }
  | { type: 'star' }
  | { type: 'trash' }

export interface EmailFilterInput {
  name: string
  enabled: boolean
  matchMode?: EmailFilterMatchMode
  conditions: EmailFilterCondition[]
  actions: EmailFilterAction[]
  stopProcessing?: boolean
}

export interface EmailFilterPatch {
  name?: string
  enabled?: boolean
  matchMode?: EmailFilterMatchMode
  conditions?: EmailFilterCondition[]
  actions?: EmailFilterAction[]
  stopProcessing?: boolean
}

export interface EmailFilter {
  id: string
  name: string
  enabled: boolean
  sortOrder: number
  matchMode?: EmailFilterMatchMode
  conditions: EmailFilterCondition[]
  actions: EmailFilterAction[]
  stopProcessing?: boolean
  createdAt: string
}

export interface EmailBlockedSender {
  address: string
  createdAt: string
}

export interface EmailBlockSenderResult {
  address: string
  messageId: string
  folderId: string
}

export function normalizeEmailSenderAddress(value: string): string {
  const text = value.trim()
  const open = text.lastIndexOf('<')
  const close = open >= 0 ? text.indexOf('>', open + 1) : -1
  const address = open >= 0 && close > open ? text.slice(open + 1, close).trim() : text
  return normalizeEmailAddress(address)
}

export function isBlockableSenderAddress(value: string): boolean {
  return isValidEmailAddress(value)
}

function readFilterName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name.length > EMAIL_FILTER_NAME_MAX_CHARS) return null
  return name
}

function readConditionText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > EMAIL_FILTER_TEXT_MAX_CHARS) return null
  return text
}

function readCondition(value: unknown): EmailFilterCondition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.negate !== undefined && typeof raw.negate !== 'boolean') return null
  const negate = raw.negate ?? false
  switch (raw.field) {
    case 'fromContains':
    case 'toContains':
    case 'subjectContains': {
      const text = readConditionText(raw.value)
      return text ? { field: raw.field, value: text, negate } : null
    }
    case 'hasAttachment':
      return typeof raw.value === 'boolean' ? { field: 'hasAttachment', value: raw.value, negate } : null
    case 'minBytes':
      return typeof raw.value === 'number'
        && Number.isSafeInteger(raw.value)
        && raw.value >= 0
        && raw.value <= EMAIL_INBOUND_MAX_BYTES
        ? { field: 'minBytes', value: raw.value, negate }
        : null
    default:
      return null
  }
}

export function parseEmailFilterConditions(value: unknown): EmailFilterCondition[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > EMAIL_FILTER_MAX_CONDITIONS) return null
  const conditions: EmailFilterCondition[] = []
  const fields = new Set<EmailFilterConditionField>()
  for (const entry of value) {
    const condition = readCondition(entry)
    if (!condition || fields.has(condition.field)) return null
    fields.add(condition.field)
    conditions.push(condition)
  }
  return conditions
}

function readAction(value: unknown): EmailFilterAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  switch (raw.type) {
    case 'moveTo': {
      if (typeof raw.folder !== 'string') return null
      const folder = raw.folder.trim()
      if (!folder || folder.length > EMAIL_FILTER_FOLDER_REF_MAX_CHARS) return null
      return { type: 'moveTo', folder }
    }
    case 'addTag': {
      if (typeof raw.tag !== 'string') return null
      const tag = normalizeEmailTagPath(raw.tag)
      return isValidEmailTagPath(tag) ? { type: 'addTag', tag } : null
    }
    case 'markRead':
      return { type: 'markRead' }
    case 'star':
      return { type: 'star' }
    case 'trash':
      return { type: 'trash' }
    default:
      return null
  }
}

export function parseEmailFilterActions(value: unknown): EmailFilterAction[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > EMAIL_FILTER_MAX_ACTIONS) return null
  const actions: EmailFilterAction[] = []
  const types = new Set<EmailFilterActionType>()
  for (const entry of value) {
    const action = readAction(entry)
    if (!action || types.has(action.type)) return null
    types.add(action.type)
    actions.push(action)
  }
  return actions
}

export function parseEmailFilterInput(value: unknown): EmailFilterInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = readFilterName(raw.name)
  const enabled = raw.enabled === undefined ? true : typeof raw.enabled === 'boolean' ? raw.enabled : null
  const matchMode = raw.matchMode === undefined ? 'all' : raw.matchMode === 'all' || raw.matchMode === 'any' ? raw.matchMode : null
  const stopProcessing = raw.stopProcessing === undefined
    ? false
    : typeof raw.stopProcessing === 'boolean' ? raw.stopProcessing : null
  const conditions = parseEmailFilterConditions(raw.conditions)
  const actions = parseEmailFilterActions(raw.actions)
  if (!name || enabled === null || matchMode === null || stopProcessing === null || !conditions || !actions) return null
  return { name, enabled, matchMode, conditions, actions, stopProcessing }
}

export function parseEmailFilterPatch(value: unknown): EmailFilterPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const patch: EmailFilterPatch = {}
  if (raw.name !== undefined) {
    const name = readFilterName(raw.name)
    if (!name) return null
    patch.name = name
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return null
    patch.enabled = raw.enabled
  }
  if (raw.matchMode !== undefined) {
    if (raw.matchMode !== 'all' && raw.matchMode !== 'any') return null
    patch.matchMode = raw.matchMode
  }
  if (raw.stopProcessing !== undefined) {
    if (typeof raw.stopProcessing !== 'boolean') return null
    patch.stopProcessing = raw.stopProcessing
  }
  if (raw.conditions !== undefined) {
    const conditions = parseEmailFilterConditions(raw.conditions)
    if (!conditions) return null
    patch.conditions = conditions
  }
  if (raw.actions !== undefined) {
    const actions = parseEmailFilterActions(raw.actions)
    if (!actions) return null
    patch.actions = actions
  }
  return Object.keys(patch).length > 0 ? patch : null
}
