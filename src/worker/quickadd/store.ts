/**
 * Every read and write the QuickAdd HTTP routes make against D1.
 *
 * The shape follows `share/store.ts`: a store built per request from the account it serves, methods
 * that hand back rows, the boolean a guarded write matched, or the answers the route prints, and no
 * `Response` in between. Two kinds of read live here:
 *  - the library envelope on the account's own `users` row. `WHERE id = ?1` binds `c.get('userId')`,
 *    and `users.id` *is* the account, so one device can neither read nor overwrite another's library.
 *    The envelope text is the route's to build and to parse; the store only moves the column;
 *  - the property scans behind `{{FIELD:}}`. Their `user_id` predicate is not a literal in the
 *    template but the first clause `fieldScopeWhere()` always splices — `n.user_id = ?1` bound to the
 *    account the store was built with — because the optional folder/tag scopes are named by the
 *    caller and have to be numbered after it.
 *
 * The scan's three bounds (`FIELD_SCAN_LIMIT`, `FIELD_VALUE_LIMIT`, `FIELD_VALUE_MAX_LENGTH`) are part
 * of the answer rather than configuration: a value list is a convenience, and a slow one is worse than
 * the author typing the word.
 */

import { parseFrontMatter } from '@shared/markdown-utils'

/** A property's values across the newest notes, for `{{FIELD:}}` suggestions.
 *
 * The schema has no property index, so this reads note text and parses it. Two things bound the cost:
 * the scan stops at the newest few hundred notes, and `folder:` matches the note's own folder name
 * rather than walking the tree — a value list is a convenience, and a slow one is worse than the
 * author typing the word.
 */
const FIELD_SCAN_LIMIT = 400
const FIELD_VALUE_LIMIT = 200
/** Also the ceiling the route validates an incoming `value` against, so it is exported, not local. */
export const FIELD_VALUE_MAX_LENGTH = 200

function clampCount(value: string | undefined, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return max
  return Math.min(Math.trunc(parsed), max)
}

function collectValues(content: unknown, name: string, into: Map<string, number>): void {
  if (typeof content !== 'string' || !content) return
  const parsed = parseFrontMatter(content)
  if (parsed.errors.length) return
  const value = parsed.data[name] ?? parsed.data[name.toLowerCase()] ?? Object.entries(parsed.data)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  for (const item of items) {
    if (typeof item === 'object') continue
    const text = String(item).trim()
    if (!text || text.length > FIELD_VALUE_MAX_LENGTH) continue
    const key = text.toLocaleLowerCase()
    into.set(key, (into.get(key) ?? 0) + 1)
  }
}

/** What a `{{FIELD:property}}` suggestion asks for. */
export interface FieldValueQuery {
  name: string
  folder?: string | null
  tag?: string | null
  excludeTag?: string | null
  limit?: string | null
}

/** The three optional scopes a property scan may be narrowed by. */
interface FieldScope {
  folder?: string | null
  tag?: string | null
  excludeTag?: string | null
}

/**
 * The WHERE half of a property scan. Shared by the value list and the note list because the two must
 * agree about which notes count: a capture target that offered type=draft as a value and then
 * matched a different set of notes against it would be a second truth in one screen.
 */
function fieldScopeWhere(userId: string, scope: FieldScope): { where: string[]; args: string[] } {
  const where = ['n.user_id = ?1', 'n.deleted_at IS NULL']
  const args: string[] = [userId]
  if (scope.folder) {
    where.push('EXISTS (SELECT 1 FROM folders f WHERE f.id = n.folder_id AND LOWER(f.name) = ?' + String(args.length + 1) + ')')
    args.push(scope.folder.toLocaleLowerCase())
  }
  if (scope.tag) {
    where.push('EXISTS (SELECT 1 FROM note_tags nt JOIN tags tg ON tg.id = nt.tag_id WHERE nt.note_id = n.id AND LOWER(tg.name) = ?' + String(args.length + 1) + ')')
    args.push(scope.tag.toLocaleLowerCase())
  }
  if (scope.excludeTag) {
    where.push('NOT EXISTS (SELECT 1 FROM note_tags nt JOIN tags tg ON tg.id = nt.tag_id WHERE nt.note_id = n.id AND LOWER(tg.name) = ?' + String(args.length + 1) + ')')
    args.push(scope.excludeTag.toLocaleLowerCase())
  }
  return { where, args }
}

/** The scalar values a note's property holds, lowercased for comparison. */
function propertyItems(content: unknown, name: string): string[] {
  if (typeof content !== 'string' || !content) return []
  const parsed = parseFrontMatter(content)
  if (parsed.errors.length) return []
  const value = parsed.data[name] ?? parsed.data[name.toLowerCase()] ?? Object.entries(parsed.data)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  return items
    .filter((item) => typeof item !== 'object')
    .map((item) => String(item).trim().toLocaleLowerCase())
    .filter((item) => item !== '' && item.length <= FIELD_VALUE_MAX_LENGTH)
}

/** What a `property:field=value` capture target asks for. */
export interface FieldNoteQuery extends FieldScope {
  name: string
  value?: string | null
  limit?: string | null
}

export class QuickAddStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /** The stored envelope as the column holds it; `null` is "never saved", not "empty library". */
  async readLibrary(): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT quickadd FROM users WHERE id = ?1')
      .bind(this.userId)
      .first<{ quickadd: string | null }>()
    return row?.quickadd ?? null
  }

  /**
   * Replace the stored envelope.
   *
   * `false` is the route's 404: the update is addressed by account id, so a row that vanished between
   * the session read and this write changes nothing.
   */
  async writeLibrary(envelope: string): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE users SET quickadd = ?1 WHERE id = ?2')
      .bind(envelope, this.userId)
      .run()
    return Boolean(result.meta?.changes)
  }

  /**
   * The values of one property across the newest notes, most-used first.
   *
   * The bounds above ARE the behaviour, so the scan is a store method rather than a route detail: a
   * caller hands in already-validated query text and gets the value list back.
   */
  async fieldValues(query: FieldValueQuery): Promise<string[]> {
    const limit = clampCount(query.limit ?? undefined, FIELD_VALUE_LIMIT)
    const { where, args } = fieldScopeWhere(this.userId, query)
    const rows = await this.db.prepare(
      `SELECT content FROM notes n WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${FIELD_SCAN_LIMIT}`,
    )
      .bind(...args)
      .all<{ content: string }>()

    const counts = new Map<string, number>()
    for (const row of rows.results) collectValues(row.content, query.name, counts)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([value]) => value)
  }

  /**
   * The notes whose property holds this value, newest first — the note-side half of the same scan, for
   * a capture target that names a property instead of a note. With no value it asks "which notes have
   * this property at all", which is what `property:type` means.
   */
  async fieldNotes(query: FieldNoteQuery): Promise<{ id: string; title: string }[]> {
    const limit = clampCount(query.limit ?? undefined, FIELD_VALUE_LIMIT)
    const wanted = (query.value ?? '').trim().toLocaleLowerCase()
    const { where, args } = fieldScopeWhere(this.userId, query)
    const rows = await this.db.prepare(
      `SELECT id, title, content FROM notes n WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${FIELD_SCAN_LIMIT}`,
    )
      .bind(...args)
      .all<{ id: string; title: string; content: string }>()

    const found: { id: string; title: string }[] = []
    for (const row of rows.results) {
      const items = propertyItems(row.content, query.name)
      if (items.length === 0) continue
      if (wanted !== '' && !items.includes(wanted)) continue
      found.push({ id: row.id, title: row.title })
      if (found.length >= limit) break
    }
    return found
  }
}
