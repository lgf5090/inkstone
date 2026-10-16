/**
 * The vault as lists and counts, for the tools that answer "what do I have".
 *
 * `search_notes` answers a topic out of the notes; nothing answered the questions a reader asks about
 * the notebook itself — how many notes there are, which folders they sit in, which tags label them —
 * so the assistant had to guess or say it could not tell. The rows are already there, and the scope
 * every note tool obeys applies to a listing exactly as it applies to a search.
 *
 * The SQL lives here rather than in `mcp/retrieval.ts` because the shape is different: a listing pages
 * by recency rather than by relevance, and the scope is the assistant's own permission model, which the
 * MCP server does not have. What the two share is the notes schema, and that is shared through
 * `db/rows.ts`.
 */

import type { NoteScope } from './note-scope'

/** Which slice of the vault a listing asks for. */
export interface VaultListQuery {
  /** `recent` is newest first, `starred` the reader's favourites, `archived` the ones they filed away. */
  view?: 'recent' | 'starred' | 'archived'
  /** A folder and its descendants, already expanded: the reader's "Notes" means what is inside it. */
  folderIds?: readonly string[] | null
  tagId?: string | null
  limit?: number
}

/** What a folder or tag argument narrowed a question to. */
export interface VaultFilter {
  folderIds?: readonly string[] | null
  tagId?: string | null
}

export interface VaultNote {
  id: string
  title: string
  excerpt: string
  folder: string | null
  tags: string[]
  starred: boolean
  updatedAt: number
}

/**
 * Numbers the binds in the order the SQL needs them.
 *
 * The scope, the filters and the page size all reach the same statement, and a hand-numbered `?4` in
 * three places is how a listing ends up reading another account's folder. Nothing here builds a number
 * by hand: every placeholder comes from the position the value was pushed at.
 */
function binder(userId: string) {
  const binds: unknown[] = [userId]
  const bind = (value: unknown): string => {
    binds.push(value)
    return `?${binds.length}`
  }
  const inList = (values: readonly string[]): string => values.map((value) => bind(value)).join(', ')
  return { binds, bind, inList }
}

/**
 * The reader's permission, as a predicate.
 *
 * A reader who pointed the assistant at a folder asked a question about permissions, and the answer to
 * it belongs in SQL rather than in the prompt: the model that ignores the line saying "these folders
 * only" is the model the scope exists for. Both narrowings are required when both were given, which is
 * what `readableNoteIds` does for a named id and what a listing has to keep doing.
 */
function scopeClause(scope: NoteScope, inList: (values: readonly string[]) => string): string {
  if (!scope.restricted) return ''
  const folders = [...scope.folderIds]
  const tags = [...scope.tagIds]
  // Restricted to nothing is a real state — every folder the reader named has since been deleted — and
  // reading it as "no scope was set" would hand back the whole vault.
  if (!folders.length && !tags.length) return ' AND 0'
  const parts: string[] = []
  if (folders.length) parts.push(`n.folder_id IN (${inList(folders)})`)
  if (tags.length) parts.push(`EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag_id IN (${inList(tags)}))`)
  return ` AND ${parts.join(' AND ')}`
}

/** Live notes only: the trash is a different list and an archived note is not what a count means. */
function baseWhere(
  scope: NoteScope,
  filter: VaultFilter,
  bind: (value: unknown) => string,
  inList: (values: readonly string[]) => string,
): string {
  let where = `n.user_id = ?1 AND n.deleted_at IS NULL`
  if (filter.folderIds?.length) where += ` AND n.folder_id IN (${inList(filter.folderIds)})`
  if (filter.tagId) where += ` AND EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag_id = ${bind(filter.tagId)})`
  return where + scopeClause(scope, inList)
}

/**
 * The view as a predicate, beside the listing that uses it.
 *
 * A note the reader filed away is out of the working list they see in the notebook, so a listing is
 * recent-or-starred among the unarchived unless they asked for the archived ones. The count tool
 * answers the other question — how much there is altogether — and reports the archived ones as their
 * own number rather than dropping them.
 */
function viewClause(view: VaultListQuery['view']): string {
  return view === 'archived' ? ' AND n.is_archived = 1' : ' AND n.is_archived = 0'
}

interface FolderRow {
  id: string
  parent_id: string | null
  name: string
}

/**
 * Every folder the reader has, with the path a person would write.
 *
 * Read in one query and joined in memory rather than with a recursive CTE: a vault has tens of folders
 * and hundreds of notes, and the subquery that walks a parent chain per row costs more than the one
 * table read it saves.
 */
async function readFolders(db: D1Database, userId: string): Promise<{ paths: Map<string, string>, rows: FolderRow[] }> {
  const { results } = await db.prepare(
    `SELECT id, parent_id, name FROM folders
      WHERE user_id = ?1 AND deleted_at IS NULL
      ORDER BY position ASC, name COLLATE NOCASE ASC`,
  ).bind(userId).all<FolderRow>()
  const byId = new Map((results ?? []).map((row) => [row.id, row]))
  const paths = new Map<string, string>()
  for (const row of results ?? []) {
    const names = [row.name]
    const seen = new Set([row.id])
    let parent = row.parent_id ? byId.get(row.parent_id) : undefined
    while (parent && !seen.has(parent.id) && names.length < 12) {
      seen.add(parent.id)
      names.unshift(parent.name)
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined
    }
    paths.set(row.id, names.join(' / '))
  }
  return { paths, rows: results ?? [] }
}

const UUID_LIKE = /^[0-9a-hjkmnp-tv-z]{26}$/

/**
 * The folders a name could mean, by id or by the path the reader sees.
 *
 * More than one is a real answer: "Notes" is a plausible name in two branches of a tree, and picking
 * one silently would report on a folder the reader never meant. The caller is the one that turns the
 * count into words, because what to do about it is a tool's decision rather than a query's.
 */
export async function matchVaultFolders(
  db: D1Database,
  userId: string,
  ref: string,
): Promise<{ id: string, label: string }[]> {
  const { paths, rows } = await readFolders(db, userId)
  if (UUID_LIKE.test(ref) && paths.has(ref)) return [{ id: ref, label: paths.get(ref)! }]
  const wanted = ref.trim().toLowerCase()
  return rows
    .filter((row) => {
      const path = paths.get(row.id)!.toLowerCase()
      return row.name.trim().toLowerCase() === wanted || path === wanted || path.endsWith(` / ${wanted}`)
    })
    .map((row) => ({ id: row.id, label: paths.get(row.id)! }))
}

/**
 * A folder and everything under it.
 *
 * The folder tree is how a reader thinks about their vault — "what is in Notes" means the whole
 * branch, which is also what the scope resolver does with a folder the reader permitted. A filter that
 * stopped at the exact id would answer a narrower question than the one asked.
 */
export async function folderSubtree(db: D1Database, userId: string, folderId: string): Promise<string[]> {
  const { rows } = await readFolders(db, userId)
  const children = new Map<string | null, string[]>()
  for (const row of rows) {
    const bucket = children.get(row.parent_id) ?? []
    bucket.push(row.id)
    children.set(row.parent_id, bucket)
  }
  const out: string[] = []
  const seen = new Set<string>()
  const frontier = [folderId]
  while (frontier.length && out.length < 400) {
    const id = frontier.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    frontier.push(...children.get(id) ?? [])
  }
  return out
}

/** A tag the model named, by id or by name. Tags have one name each, so there is no ambiguity to report. */
export async function resolveVaultTag(  db: D1Database,
  userId: string,
  ref: string,
): Promise<{ id: string, label: string } | null> {
  if (UUID_LIKE.test(ref)) {
    const row = await db.prepare(`SELECT id, name FROM tags WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, ref).first<{ id: string, name: string }>()
    if (row) return { id: row.id, label: row.name }
  }
  const row = await db.prepare(`SELECT id, name FROM tags WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE`)
    .bind(userId, ref.trim()).first<{ id: string, name: string }>()
  return row ? { id: row.id, label: row.name } : null
}

export interface VaultListing {
  notes: VaultNote[]
  total: number
  scopeLimited: boolean
}

/** One page of the vault, newest first, with the total the page was cut out of. */
export async function listVaultNotes(
  db: D1Database,
  userId: string,
  scope: NoteScope,
  query: VaultListQuery,
): Promise<VaultListing> {
  const { binds, bind, inList } = binder(userId)
  const where = baseWhere(scope, query, bind, inList)
  const view = query.view === 'starred' ? ' AND n.is_starred = 1' : viewClause(query.view)
  const limit = Math.max(1, Math.min(50, query.limit ?? 20))
  const scopeLimited = scope.restricted
  const counted = await db.prepare(
    `SELECT COUNT(*) AS total FROM notes n WHERE ${where}${view}`,
  ).bind(...binds).first<{ total: number }>()
  bind(limit)
  const { results } = await db.prepare(
    `SELECT n.id, n.title, n.excerpt, n.folder_id, n.is_starred, n.updated_at,
            (SELECT GROUP_CONCAT(t.name, char(1)) FROM note_tags nt
               JOIN tags t ON t.id = nt.tag_id
              WHERE nt.note_id = n.id AND t.user_id = n.user_id) AS tag_names
       FROM notes n WHERE ${where}${view}
      ORDER BY n.updated_at DESC, n.id ASC LIMIT ?${binds.length}`,
  ).bind(...binds).all<{
    id: string
    title: string
    excerpt: string
    folder_id: string | null
    is_starred: number
    updated_at: number
    tag_names: string | null
  }>()
  const { paths } = await readFolders(db, userId)
  return {
    total: counted?.total ?? 0,
    scopeLimited,
    notes: (results ?? []).map((row) => ({
      id: row.id,
      title: row.title || 'Untitled',
      excerpt: (row.excerpt ?? '').slice(0, 200),
      folder: row.folder_id ? paths.get(row.folder_id) ?? null : null,
      tags: row.tag_names ? row.tag_names.split('\u0001') : [],
      starred: row.is_starred === 1,
      updatedAt: row.updated_at,
    })),
  }
}

export interface VaultCounts {
  total: number
  starred: number
  archived: number
  folders: { path: string, count: number }[]
  tags: { name: string, count: number }[]
  scopeLimited: boolean
}

/** How many notes there are, and where they sit. */
export async function countVaultNotes(
  db: D1Database,
  userId: string,
  scope: NoteScope,
  filter: VaultFilter = {},
): Promise<VaultCounts> {
  const counts = binder(userId)
  const countWhere = baseWhere(scope, filter, counts.bind, counts.inList)
  const totals = await db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(n.is_starred), 0) AS starred,
            COALESCE(SUM(n.is_archived), 0) AS archived
       FROM notes n WHERE ${countWhere}`,
  ).bind(...counts.binds).first<{ total: number, starred: number, archived: number }>()
  const byFolder = binder(userId)
  const folderWhere = baseWhere(scope, filter, byFolder.bind, byFolder.inList)
  const folderRows = await db.prepare(
    `SELECT n.folder_id AS folder_id, COUNT(*) AS count FROM notes n
      WHERE ${folderWhere} GROUP BY n.folder_id ORDER BY count DESC, n.folder_id ASC LIMIT 12`,
  ).bind(...byFolder.binds).all<{ folder_id: string | null, count: number }>()
  const byTag = binder(userId)
  const tagWhere = baseWhere(scope, filter, byTag.bind, byTag.inList)
  const tagRows = await db.prepare(
    `SELECT t.name AS name, COUNT(*) AS count FROM notes n
       JOIN note_tags nt ON nt.note_id = n.id
       JOIN tags t ON t.id = nt.tag_id AND t.user_id = n.user_id
      WHERE ${tagWhere} GROUP BY t.id, t.name ORDER BY count DESC, t.name COLLATE NOCASE ASC LIMIT 12`,
  ).bind(...byTag.binds).all<{ name: string, count: number }>()
  const { paths } = await readFolders(db, userId)
  return {
    total: totals?.total ?? 0,
    starred: totals?.starred ?? 0,
    archived: totals?.archived ?? 0,
    // Ordered here rather than in SQL because the paths are joined in memory: a tie between two folders
    // with the same count would otherwise be broken by whichever id happened to sort first, and the
    // reader reading the answer would see the order change between two identical questions.
    folders: (folderRows.results ?? [])
      .map((row) => ({
        path: row.folder_id ? paths.get(row.folder_id) ?? 'Unknown folder' : '(no folder)',
        count: row.count,
      }))
      .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path)),
    tags: tagRows.results ?? [],
    scopeLimited: scope.restricted,
  }
}

/**
 * The folder tree with how much sits in each branch.
 *
 * The count is per folder rather than cumulative down the tree: a reader asking where their notes are
 * wants to know what is *in* a folder, and a parent that reported its children's notes would double
 * every number.
 */
export async function listVaultFolders(
  db: D1Database,
  userId: string,
  scope: NoteScope,
): Promise<{ path: string, count: number }[]> {
  const { paths, rows } = await readFolders(db, userId)
  const counts = binder(userId)
  // A folder scope narrows which folders are worth naming; a tag-only scope says nothing about folders,
  // so every folder is listed and the counts below are what the reader's tags actually reach.
  const folderFilter = scope.restricted && scope.folderIds.size
    ? ` AND n.folder_id IN (${counts.inList([...scope.folderIds])})`
    : ''
  const scoped = scope.restricted && !scope.folderIds.size && scope.tagIds.size
    ? ` AND EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag_id IN (${counts.inList([...scope.tagIds])}))`
    : ''
  const { results } = await db.prepare(
    `SELECT n.folder_id AS folder_id, COUNT(*) AS count FROM notes n
      WHERE n.user_id = ?1 AND n.deleted_at IS NULL${folderFilter}${scoped}
      GROUP BY n.folder_id`,
  ).bind(...counts.binds).all<{ folder_id: string | null, count: number }>()
  const byFolder = new Map((results ?? []).filter((row) => row.folder_id).map((row) => [row.folder_id!, row.count]))
  const visible = scope.restricted && scope.folderIds.size
    ? rows.filter((row) => scope.folderIds.has(row.id))
    : rows
  // By path, which puts a parent above its children because a parent's path is a prefix of its child's,
  // and is the same order for the same vault whatever order the rows were written in.
  return visible
    .map((row) => ({ path: paths.get(row.id)!, count: byFolder.get(row.id) ?? 0 }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

/** The tags in use, most used first. */
export async function listVaultTags(
  db: D1Database,
  userId: string,
  scope: NoteScope,
  limit = 60,
): Promise<{ name: string, count: number }[]> {
  const counts = binder(userId)
  const { binds, inList } = counts
  const folderFilter = scope.restricted && scope.folderIds.size
    ? ` AND n.folder_id IN (${inList([...scope.folderIds])})`
    : ''
  const tagFilter = scope.restricted && scope.tagIds.size
    ? ` AND t.id IN (${inList([...scope.tagIds])})`
    : ''
  const { results } = await db.prepare(
    `SELECT t.name AS name, COUNT(n.id) AS count
       FROM tags t
       LEFT JOIN note_tags nt ON nt.tag_id = t.id
       LEFT JOIN notes n ON n.id = nt.note_id AND n.user_id = t.user_id AND n.deleted_at IS NULL${folderFilter}
      WHERE t.user_id = ?1${tagFilter}
      GROUP BY t.id, t.name
      ORDER BY count DESC, t.name COLLATE NOCASE ASC LIMIT ?${binds.length + 1}`,
  ).bind(...binds, Math.max(1, Math.min(200, limit))).all<{ name: string, count: number }>()
  return results ?? []
}

/** The name a model can call a note by, or null when the reader does not have it any more. */
export async function noteTitleIfLive(db: D1Database, userId: string, noteId: string): Promise<string | null> {
  if (!UUID_LIKE.test(noteId)) return null
  const row = await db.prepare(
    `SELECT title FROM notes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  ).bind(userId, noteId).first<{ title: string }>()
  return row ? row.title.slice(0, 200) || 'Untitled' : null
}

/** The line a scoped answer carries, so the model can say why a list looks short. */
export const SCOPE_NOTE = 'limited to the folders the reader allowed the assistant to read'
