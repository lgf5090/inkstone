import { isValidEmailAddress, normalizeEmailAddress } from './format'

export const EMAIL_CONTACT_EMAIL_MAX_CHARS = 320
export const EMAIL_CONTACT_NAME_MAX_CHARS = 120
export const EMAIL_CONTACT_COMPANY_MAX_CHARS = 120
export const EMAIL_CONTACT_NOTES_MAX_CHARS = 2000
export const EMAIL_CONTACT_QUERY_MAX_CHARS = 120
export const EMAIL_CONTACTS_PAGE_SIZE = 20
export const EMAIL_CONTACTS_MAX_PAGE_SIZE = 50
export const EMAIL_GROUP_NAME_MAX_CHARS = 80
export const EMAIL_GROUP_DESCRIPTION_MAX_CHARS = 500

export interface EmailContact {
  id: string
  email: string
  name: string
  company: string
  notes: string
  starred: boolean
  usageCount: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface EmailGroup {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

export interface EmailGroupMember {
  groupId: string
  contactId: string
  createdAt: string
}

export interface EmailGroupWithMembers extends EmailGroup {
  members: EmailContact[]
}

export interface EmailContactInput {
  email: string
  name: string
  company: string
  notes: string
  starred: boolean
}

export interface EmailContactPatch {
  email?: string
  name?: string
  company?: string
  notes?: string
  starred?: boolean
}

export interface EmailGroupInput {
  name: string
  description: string
}

export interface EmailGroupPatch {
  name?: string
  description?: string
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export function normalizeContactEmail(value: string): string {
  return normalizeEmailAddress(value)
}

export function isValidContactEmail(value: string): boolean {
  const normalized = normalizeContactEmail(value)
  return normalized.length <= EMAIL_CONTACT_EMAIL_MAX_CHARS && isValidEmailAddress(normalized)
}

export function parseEmailContactInput(value: unknown): EmailContactInput | null {
  if (!isRecord(value)) return null
  const email = readEmail(value.email)
  if (!email) return null
  const name = optionalText(value.name, EMAIL_CONTACT_NAME_MAX_CHARS)
  if (name === null) return null
  const company = optionalText(value.company, EMAIL_CONTACT_COMPANY_MAX_CHARS)
  if (company === null) return null
  const notes = optionalText(value.notes, EMAIL_CONTACT_NOTES_MAX_CHARS)
  if (notes === null) return null
  if (value.starred !== undefined && typeof value.starred !== 'boolean') return null
  return { email, name, company, notes, starred: value.starred === true }
}

export function parseEmailContactPatch(value: unknown): EmailContactPatch | null {
  if (!isRecord(value)) return null
  const patch: EmailContactPatch = {}
  if (value.email !== undefined) {
    const email = readEmail(value.email)
    if (!email) return null
    patch.email = email
  }
  if (value.name !== undefined) {
    const name = optionalText(value.name, EMAIL_CONTACT_NAME_MAX_CHARS)
    if (name === null) return null
    patch.name = name
  }
  if (value.company !== undefined) {
    const company = optionalText(value.company, EMAIL_CONTACT_COMPANY_MAX_CHARS)
    if (company === null) return null
    patch.company = company
  }
  if (value.notes !== undefined) {
    const notes = optionalText(value.notes, EMAIL_CONTACT_NOTES_MAX_CHARS)
    if (notes === null) return null
    patch.notes = notes
  }
  if (value.starred !== undefined) {
    if (typeof value.starred !== 'boolean') return null
    patch.starred = value.starred
  }
  return Object.keys(patch).length ? patch : null
}

export function parseEmailGroupInput(value: unknown): EmailGroupInput | null {
  if (!isRecord(value)) return null
  const name = requiredText(value.name, EMAIL_GROUP_NAME_MAX_CHARS)
  if (!name) return null
  const description = optionalText(value.description, EMAIL_GROUP_DESCRIPTION_MAX_CHARS)
  if (description === null) return null
  return { name, description }
}

export function parseEmailGroupPatch(value: unknown): EmailGroupPatch | null {
  if (!isRecord(value)) return null
  const patch: EmailGroupPatch = {}
  if (value.name !== undefined) {
    const name = requiredText(value.name, EMAIL_GROUP_NAME_MAX_CHARS)
    if (!name) return null
    patch.name = name
  }
  if (value.description !== undefined) {
    const description = optionalText(value.description, EMAIL_GROUP_DESCRIPTION_MAX_CHARS)
    if (description === null) return null
    patch.description = description
  }
  return Object.keys(patch).length ? patch : null
}

function readEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim()
  if (!email || email.length > EMAIL_CONTACT_EMAIL_MAX_CHARS) return null
  return isValidEmailAddress(email) ? email : null
}

function requiredText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > max || CONTROL_CHARS.test(text)) return null
  return text
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length > max || CONTROL_CHARS.test(text)) return null
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
