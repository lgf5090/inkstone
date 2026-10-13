/**
 * Groups: reader-named collections of books.
 *
 * A shelf of four hundred novels needs a way to say "these are the ones I am working through" that is
 * neither a folder (a book lives in one place) nor a tag on a note (the book is not a note). So a group
 * is a list of book ids a reader owns, and a book may sit in as many of them as they like, which is the
 * only shape that lets a genre and a reading status both be true of the same volume.
 *
 * Everything here is pure: the store holds the array, these functions return the next one, and the
 * rules a reader can hit — an empty name, a name already taken, a deleted book — are decided once.
 */
import { randomLocalId } from '../../lib/random-id'

export interface BookGroup {
  id: string
  name: string
  bookIds: string[]
  createdAt: number
  updatedAt: number
}

export const GROUP_NAME_MAX = 40
export const GROUPS_MAX = 60
export const GROUP_BOOKS_MAX = 500

export type GroupRefusal = 'empty' | 'duplicate' | 'limit' | 'unknown'

export type GroupResult = { ok: true; groups: BookGroup[] } | { ok: false; reason: GroupRefusal }

/** Names are compared the way a reader reads them: trimmed, case-insensitive, spaces collapsed. */
export function groupKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function groupName(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, GROUP_NAME_MAX) : ''
}

/** What a shelf may hold, whatever arrived from the server or an import file. */
export function normaliseGroups(value: unknown): BookGroup[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: BookGroup[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Partial<BookGroup>
    const id = typeof row.id === 'string' && row.id ? row.id.slice(0, 80) : ''
    const name = groupName(row.name)
    if (!id || !name || seen.has(id) || seen.has(groupKey(name))) continue
    seen.add(id)
    seen.add(groupKey(name))
    const createdAt = typeof row.createdAt === 'number' ? row.createdAt : Date.now()
    out.push({
      id,
      name,
      bookIds: Array.isArray(row.bookIds)
        ? [...new Set(row.bookIds.filter((one): one is string => typeof one === 'string' && one.length > 0))].slice(0, GROUP_BOOKS_MAX)
        : [],
      createdAt,
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : createdAt,
    })
    if (out.length >= GROUPS_MAX) break
  }
  return out
}

/** Newest touched first, so a group a reader just edited stays where they left it. */
export function sortGroups(groups: BookGroup[]): BookGroup[] {
  return [...groups].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, 'zh-CN'))
}

export function createGroup(groups: BookGroup[], name: string): GroupResult {
  const clean = groupName(name)
  if (!clean) return { ok: false, reason: 'empty' }
  if (groups.length >= GROUPS_MAX) return { ok: false, reason: 'limit' }
  if (groups.some((one) => groupKey(one.name) === groupKey(clean))) return { ok: false, reason: 'duplicate' }
  const now = Date.now()
  return { ok: true, groups: [...groups, { id: randomLocalId('group'), name: clean, bookIds: [], createdAt: now, updatedAt: now }] }
}

export function renameGroup(groups: BookGroup[], id: string, name: string): GroupResult {
  const clean = groupName(name)
  if (!clean) return { ok: false, reason: 'empty' }
  if (!groups.some((one) => one.id === id)) return { ok: false, reason: 'unknown' }
  if (groups.some((one) => one.id !== id && groupKey(one.name) === groupKey(clean))) return { ok: false, reason: 'duplicate' }
  return {
    ok: true,
    groups: groups.map((one) => (one.id === id ? { ...one, name: clean, updatedAt: Date.now() } : one)),
  }
}

export function deleteGroup(groups: BookGroup[], id: string): BookGroup[] {
  return groups.filter((one) => one.id !== id)
}

/** In or out, and only the group that changed is rewritten. */
export function toggleBook(groups: BookGroup[], id: string, bookId: string): GroupResult {
  const target = groups.find((one) => one.id === id)
  if (!target) return { ok: false, reason: 'unknown' }
  const member = target.bookIds.includes(bookId)
  if (!member && target.bookIds.length >= GROUP_BOOKS_MAX) return { ok: false, reason: 'limit' }
  return {
    ok: true,
    groups: groups.map((one) => (one.id !== id
      ? one
      : { ...one, bookIds: member ? one.bookIds.filter((one2) => one2 !== bookId) : [...one.bookIds, bookId], updatedAt: Date.now() })),
  }
}

/** A book that is gone cannot be a member; a group emptied by that is still a group the reader made. */
export function pruneGroups(groups: BookGroup[], survivingBookIds: ReadonlySet<string>): BookGroup[] {
  return groups.map((one) => {
    const bookIds = one.bookIds.filter((bookId) => survivingBookIds.has(bookId))
    return bookIds.length === one.bookIds.length ? one : { ...one, bookIds, updatedAt: Date.now() }
  })
}

export function groupsHolding(groups: BookGroup[], bookId: string): BookGroup[] {
  return sortGroups(groups.filter((one) => one.bookIds.includes(bookId)))
}
