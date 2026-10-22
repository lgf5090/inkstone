import {
  EMAIL_CONTACTS_MAX_PAGE_SIZE,
  EMAIL_CONTACTS_PAGE_SIZE,
  EMAIL_CONTACT_NAME_MAX_CHARS,
  isValidContactEmail,
  normalizeContactEmail,
} from '@shared/email/contacts'
import type {
  EmailContact,
  EmailContactInput,
  EmailContactPatch,
  EmailGroup,
  EmailGroupInput,
  EmailGroupPatch,
  EmailGroupWithMembers,
} from '@shared/email/contacts'
import { newId } from '../lib/id'

export interface EmailContactRow {
  id: string
  user_id: string
  email: string
  email_normalized: string
  name: string
  company: string
  notes: string
  starred: number
  usage_count: number
  last_used_at: number | null
  created_at: number
  updated_at: number
}

export interface EmailGroupRow {
  id: string
  user_id: string
  name: string
  description: string
  created_at: number
  updated_at: number
}

export interface EmailContactTouch {
  email: string
  name?: string | null
}

const GROUP_MEMBER_ORDER = `ORDER BY c.name COLLATE NOCASE ASC, c.email_normalized ASC`

export function toEmailContact(row: EmailContactRow): EmailContact {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    company: row.company,
    notes: row.notes,
    starred: Boolean(row.starred),
    usageCount: Number(row.usage_count),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export function toEmailGroup(row: EmailGroupRow): EmailGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export async function listEmailContacts(
  db: D1Database,
  userId: string,
  options: { query?: string; limit?: number } = {},
): Promise<EmailContactRow[]> {
  const query = (options.query ?? '').trim().toLowerCase()
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? EMAIL_CONTACTS_PAGE_SIZE), 1),
    EMAIL_CONTACTS_MAX_PAGE_SIZE,
  )
  const { results } = await db.prepare(
    `SELECT * FROM email_contacts
      WHERE user_id = ?1
        AND (?2 = '' OR instr(lower(name), ?2) > 0 OR instr(email_normalized, ?2) > 0)
      ORDER BY usage_count DESC, COALESCE(last_used_at, 0) DESC, name COLLATE NOCASE ASC, created_at ASC
      LIMIT ?3`,
  ).bind(userId, query, limit).all<EmailContactRow>()
  return results
}

export async function getEmailContact(
  db: D1Database,
  userId: string,
  id: string,
): Promise<EmailContactRow | null> {
  return db.prepare(
    `SELECT * FROM email_contacts WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<EmailContactRow>()
}

export async function findEmailContactByEmail(
  db: D1Database,
  userId: string,
  emailNormalized: string,
): Promise<EmailContactRow | null> {
  return db.prepare(
    `SELECT * FROM email_contacts WHERE user_id = ?1 AND email_normalized = ?2`,
  ).bind(userId, emailNormalized).first<EmailContactRow>()
}

export async function createEmailContact(
  db: D1Database,
  userId: string,
  input: EmailContactInput,
  now = Date.now(),
): Promise<EmailContactRow> {
  const id = newId()
  await db.prepare(
    `INSERT INTO email_contacts (
       id, user_id, email, email_normalized, name, company, notes, starred,
       usage_count, last_used_at, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL, ?9, ?9)`,
  ).bind(
    id,
    userId,
    input.email.trim(),
    normalizeContactEmail(input.email),
    input.name.trim(),
    input.company.trim(),
    input.notes.trim(),
    input.starred ? 1 : 0,
    now,
  ).run()
  const created = await getEmailContact(db, userId, id)
  if (!created) throw new Error('The contact could not be read back after creation')
  return created
}

export async function updateEmailContact(
  db: D1Database,
  userId: string,
  id: string,
  patch: EmailContactPatch,
  now = Date.now(),
): Promise<EmailContactRow | null> {
  const current = await getEmailContact(db, userId, id)
  if (!current) return null
  const email = patch.email?.trim() ?? current.email
  await db.prepare(
    `UPDATE email_contacts
        SET email = ?1, email_normalized = ?2, name = ?3, company = ?4, notes = ?5, starred = ?6, updated_at = ?7
      WHERE user_id = ?8 AND id = ?9`,
  ).bind(
    email,
    patch.email === undefined ? current.email_normalized : normalizeContactEmail(patch.email),
    patch.name?.trim() ?? current.name,
    patch.company?.trim() ?? current.company,
    patch.notes?.trim() ?? current.notes,
    patch.starred === undefined ? current.starred : patch.starred ? 1 : 0,
    now,
    userId,
    id,
  ).run()
  return getEmailContact(db, userId, id)
}

export async function deleteEmailContact(db: D1Database, userId: string, id: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`DELETE FROM email_group_members WHERE user_id = ?1 AND contact_id = ?2`).bind(userId, id),
    db.prepare(`DELETE FROM email_contacts WHERE user_id = ?1 AND id = ?2`).bind(userId, id),
  ])
  return Boolean(results[1]?.meta.changes)
}

export async function touchContacts(
  db: D1Database,
  userId: string,
  contacts: readonly EmailContactTouch[],
  now = Date.now(),
): Promise<number> {
  const seen = new Set<string>()
  let touched = 0
  for (const contact of contacts) {
    const email = contact.email.trim()
    if (!email || !isValidContactEmail(email)) continue
    const emailNormalized = normalizeContactEmail(email)
    if (seen.has(emailNormalized)) continue
    seen.add(emailNormalized)
    const name = (contact.name ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, EMAIL_CONTACT_NAME_MAX_CHARS)
    await db.prepare(
      `INSERT INTO email_contacts (
         id, user_id, email, email_normalized, name, company, notes, starred,
         usage_count, last_used_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, '', '', 0, 1, ?6, ?6, ?6)
       ON CONFLICT(user_id, email_normalized) DO UPDATE SET
         usage_count = email_contacts.usage_count + 1,
         last_used_at = excluded.last_used_at,
         updated_at = excluded.updated_at,
         name = CASE WHEN email_contacts.name = '' THEN excluded.name ELSE email_contacts.name END`,
    ).bind(newId(), userId, email, emailNormalized, name, now).run()
    touched += 1
  }
  return touched
}

export async function listEmailGroups(db: D1Database, userId: string): Promise<EmailGroupWithMembers[]> {
  const { results: groups } = await db.prepare(
    `SELECT * FROM email_groups WHERE user_id = ?1 ORDER BY name COLLATE NOCASE ASC, created_at ASC`,
  ).bind(userId).all<EmailGroupRow>()
  if (!groups.length) return []
  const { results: members } = await db.prepare(
    `SELECT c.*, m.group_id AS member_group_id
       FROM email_group_members m
       JOIN email_contacts c ON c.user_id = m.user_id AND c.id = m.contact_id
      WHERE m.user_id = ?1
      ${GROUP_MEMBER_ORDER}`,
  ).bind(userId).all<EmailContactRow & { member_group_id: string }>()
  const byGroup = new Map<string, EmailContact[]>()
  for (const member of members) {
    const list = byGroup.get(member.member_group_id) ?? []
    list.push(toEmailContact(member))
    byGroup.set(member.member_group_id, list)
  }
  return groups.map((group) => ({ ...toEmailGroup(group), members: byGroup.get(group.id) ?? [] }))
}

export async function getEmailGroup(
  db: D1Database,
  userId: string,
  id: string,
): Promise<EmailGroupRow | null> {
  return db.prepare(
    `SELECT * FROM email_groups WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<EmailGroupRow>()
}

export async function getEmailGroupWithMembers(
  db: D1Database,
  userId: string,
  id: string,
): Promise<EmailGroupWithMembers | null> {
  const group = await getEmailGroup(db, userId, id)
  if (!group) return null
  const { results: members } = await db.prepare(
    `SELECT c.*
       FROM email_group_members m
       JOIN email_contacts c ON c.user_id = m.user_id AND c.id = m.contact_id
      WHERE m.user_id = ?1 AND m.group_id = ?2
      ${GROUP_MEMBER_ORDER}`,
  ).bind(userId, id).all<EmailContactRow>()
  return { ...toEmailGroup(group), members: members.map(toEmailContact) }
}

export async function findEmailGroupByName(
  db: D1Database,
  userId: string,
  name: string,
): Promise<EmailGroupRow | null> {
  return db.prepare(
    `SELECT * FROM email_groups WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE`,
  ).bind(userId, name.trim()).first<EmailGroupRow>()
}

export async function createEmailGroup(
  db: D1Database,
  userId: string,
  input: EmailGroupInput,
  now = Date.now(),
): Promise<EmailGroupRow> {
  const id = newId()
  await db.prepare(
    `INSERT INTO email_groups (id, user_id, name, description, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
  ).bind(id, userId, input.name.trim(), input.description.trim(), now).run()
  const created = await getEmailGroup(db, userId, id)
  if (!created) throw new Error('The group could not be read back after creation')
  return created
}

export async function updateEmailGroup(
  db: D1Database,
  userId: string,
  id: string,
  patch: EmailGroupPatch,
  now = Date.now(),
): Promise<EmailGroupRow | null> {
  const current = await getEmailGroup(db, userId, id)
  if (!current) return null
  await db.prepare(
    `UPDATE email_groups SET name = ?1, description = ?2, updated_at = ?3 WHERE user_id = ?4 AND id = ?5`,
  ).bind(
    patch.name?.trim() ?? current.name,
    patch.description?.trim() ?? current.description,
    now,
    userId,
    id,
  ).run()
  return getEmailGroup(db, userId, id)
}

export async function deleteEmailGroup(db: D1Database, userId: string, id: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`DELETE FROM email_group_members WHERE user_id = ?1 AND group_id = ?2`).bind(userId, id),
    db.prepare(`DELETE FROM email_groups WHERE user_id = ?1 AND id = ?2`).bind(userId, id),
  ])
  return Boolean(results[1]?.meta.changes)
}

export async function addEmailGroupMember(
  db: D1Database,
  userId: string,
  groupId: string,
  contactId: string,
  now = Date.now(),
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO email_group_members (user_id, group_id, contact_id, created_at)
     VALUES (?1, ?2, ?3, ?4)`,
  ).bind(userId, groupId, contactId, now).run()
}

export async function removeEmailGroupMember(
  db: D1Database,
  userId: string,
  groupId: string,
  contactId: string,
): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM email_group_members WHERE user_id = ?1 AND group_id = ?2 AND contact_id = ?3`,
  ).bind(userId, groupId, contactId).run()
  return Boolean(result.meta.changes)
}
