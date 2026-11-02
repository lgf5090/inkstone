/**
 * The account's address book.
 *
 * Calendar guests and birthdays are the same person seen twice: a guest list stores an email, a
 * birthday stores a date. Keeping both in one row means the composer can suggest a known address
 * and the birthday sweep has a date to turn into a yearly event.
 */
import type { CalendarContactDto } from '@shared/calendar/model'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'

interface ContactRow {
  id: string
  name: string
  email: string
  birthday: string | null
  rev: number
}

const CONTACT_COLUMNS = 'id, name, email, birthday, rev'
const MAX_CONTACTS = 5000
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const BIRTHDAY_RE = /^\d{4}-\d{2}-\d{2}$/

function toDto(row: ContactRow): CalendarContactDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    birthday: row.birthday,
    rev: Number(row.rev),
  }
}

export interface CalendarContactInput {
  name?: unknown
  email?: unknown
  birthday?: unknown
}

function parseName(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest('name must be text')
  const name = value.trim()
  if (name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw ApiError.badRequest('name is invalid')
  return name
}

function parseEmail(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('email must be text')
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !EMAIL_RE.test(email)) throw ApiError.badRequest('email must be an email address')
  return email
}

function parseBirthday(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !BIRTHDAY_RE.test(value)) {
    throw ApiError.badRequest('birthday must be a YYYY-MM-DD date')
  }
  const [year, month, day] = value.split('-').map(Number)
  const check = new Date(year!, month! - 1, day!)
  if (check.getFullYear() !== year || check.getMonth() !== month! - 1 || check.getDate() !== day) {
    throw ApiError.badRequest('birthday must be a real date')
  }
  return value
}

export async function listContacts(
  db: D1Database,
  userId: string,
  query = '',
): Promise<CalendarContactDto[]> {
  const q = query.trim()
  if (!q) {
    const { results } = await db.prepare(
      `SELECT ${CONTACT_COLUMNS} FROM calendar_contacts
        WHERE user_id = ? ORDER BY lower(name) ASC, lower(email) ASC LIMIT ${MAX_CONTACTS}`,
    ).bind(userId).all<ContactRow>()
    return (results ?? []).map(toDto)
  }
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`
  const { results } = await db.prepare(
    `SELECT ${CONTACT_COLUMNS} FROM calendar_contacts
      WHERE user_id = ? AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
      ORDER BY lower(name) ASC, lower(email) ASC LIMIT 50`,
  ).bind(userId, pattern, pattern).all<ContactRow>()
  return (results ?? []).map(toDto)
}

export async function createContact(
  db: D1Database,
  userId: string,
  input: CalendarContactInput,
): Promise<CalendarContactDto> {
  const id = newId()
  const now = Date.now()
  const email = parseEmail(input.email)
  try {
    await db.prepare(
      `INSERT INTO calendar_contacts (user_id, id, name, email, birthday, created_at, updated_at, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    ).bind(userId, id, parseName(input.name), email, parseBirthday(input.birthday), now, now).run()
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message)) {
      throw ApiError.conflict('A contact with that email already exists')
    }
    throw error
  }
  const row = await contactRow(db, userId, id)
  if (!row) throw new Error('Calendar contact did not persist')
  return toDto(row)
}

export async function updateContact(
  db: D1Database,
  userId: string,
  id: string,
  input: CalendarContactInput & { rev?: unknown },
): Promise<CalendarContactDto> {
  const current = await contactRow(db, userId, id)
  if (!current) throw ApiError.notFound('Contact not found')
  const rev = typeof input.rev === 'number' && Number.isSafeInteger(input.rev) ? input.rev : current.rev
  if (rev !== current.rev) throw ApiError.conflict('The contact changed elsewhere. Refresh and try again')
  const name = input.name === undefined ? current.name : parseName(input.name)
  const email = input.email === undefined ? current.email : parseEmail(input.email)
  const birthday = input.birthday === undefined ? current.birthday : parseBirthday(input.birthday)
  try {
    const result = await db.prepare(
      `UPDATE calendar_contacts SET name = ?1, email = ?2, birthday = ?3,
              updated_at = ?4, rev = rev + 1
        WHERE user_id = ?5 AND id = ?6 AND rev = ?7`,
    ).bind(name, email, birthday, Date.now(), userId, id, rev).run()
    if ((result.meta.changes ?? 0) === 0) {
      throw ApiError.conflict('The contact changed elsewhere. Refresh and try again')
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof Error && /unique/i.test(error.message)) {
      throw ApiError.conflict('A contact with that email already exists')
    }
    throw error
  }
  const row = await contactRow(db, userId, id)
  if (!row) throw new Error('Calendar contact did not persist')
  return toDto(row)
}

export async function deleteContact(
  db: D1Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const result = await db.prepare(
    'DELETE FROM calendar_contacts WHERE user_id = ?1 AND id = ?2',
  ).bind(userId, id).run()
  return (result.meta.changes ?? 0) > 0
}

async function contactRow(db: D1Database, userId: string, id: string): Promise<ContactRow | null> {
  return (await db.prepare(
    `SELECT ${CONTACT_COLUMNS} FROM calendar_contacts WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, id).first<ContactRow>()) ?? null
}
