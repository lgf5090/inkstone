/**
 * Every read and write the notes HTTP routes make against D1.
 *
 * The shape follows `assistant/store.ts`, the one place in this worker where a route holds no SQL at
 * all: a store built per request from the account it serves, methods that take already-validated
 * input and hand back rows or the record the route needs to answer with, and nothing in between that
 * knows about HTTP. Two rules hold throughout, both inherited from that file:
 *  - every statement carries `user_id`, so one reader's notes can never surface in another's listing,
 *    and the few statements that cannot (a cross-account id collision probe, a join through a note id
 *    that the scoped statement already resolved) are the deliberate exceptions, written next to the
 *    scoped statement that put the id in play;
 *  - a mutation's statements stay in one D1 batch. The guards inside them (`rev`, `content_hash`,
 *    `updated_at`) only mean "nobody changed this row between my read and my write" while the whole
 *    batch lands together, so splitting a batch into sequential runs would turn an atomic edit into a
 *    lost update that no test would notice.
 *
 * Change records (`changes.seq`) come back to the caller rather than being broadcast here: the cursor
 * belongs to the response and the background drain to the request context, both of which are the
 * route's business.
 */

import { likePattern } from '@shared/markdown-utils'
import type { SortKey, SortOrder, ViewKind } from '@shared/types'
import {
  NOTE_COLUMNS_NOTAGS,
  attachNoteTags,
  noteTagsQueryForPage,
  tagScopePredicate,
  type NoteRow,
  type NoteTagRow,
} from '../db/rows'

/**
 * The last row of a page, in the order the listing sorted it.
 *
 * A keyset cursor is a row's sort position, not an offset, so a page turn cannot shift when another
 * note is edited in between; the offset form below only exists for links minted before that was true.
 */
export interface NotesListCursor {
  view: ViewKind
  sort: SortKey
  order: SortOrder
  pinned: number
  value: string | number
  id: string
}

export type ParsedNotesListCursor =
  | { kind: 'first' }
  | { kind: 'legacy'; offset: number }
  | { kind: 'keyset'; cursor: NotesListCursor }

/** A validated listing request: the route parses the query string, this names what to fetch. */
export interface NotesListQuery {
  view: ViewKind
  sort: SortKey
  order: SortOrder
  limit: number
  cursor: ParsedNotesListCursor
  /** Required by the `folder` view; checked by the route. */
  folderId?: string
  /** Tag scopes to keep, required by the `tag` view; combined with AND. */
  tags?: string[]
  /** Tag scopes to drop, already trimmed and capped by the route. */
  excludeTags?: string[]
}

export interface NotesListPage {
  /** The page plus one extra row when there is a next page, so the route decides `nextCursor`. */
  rows: NoteRow[]
  /** `null` on a keyset page: the client already counted the listing this page continues. */
  total: number | null
}

export class NotesStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * One page of a note view, with its tags and (for a first page) its total.
   *
   * The page and its tags are two statements in one batch because a listing of 500 notes cannot pay
   * 500 correlated `GROUP_CONCAT` walks; see `noteTagsQueryForPage`. The count rides in the same
   * batch only when the caller actually needs a fresh one.
   */
  async list(query: NotesListQuery): Promise<NotesListPage> {
    const { view, sort, order, limit, cursor } = query
    const binds: unknown[] = [this.userId]
    let where = 'n.user_id = ?1'

    if (view === 'trash') {
      where += ' AND n.deleted_at IS NOT NULL'
    } else {
      where += ' AND n.deleted_at IS NULL'
      where += view === 'archived' ? ' AND n.is_archived = 1' : ' AND n.is_archived = 0'
    }

    if (view === 'starred') where += ' AND n.is_starred = 1'
    if (view === 'unfiled') where += ' AND n.folder_id IS NULL'
    if (view === 'untagged') {
      where += ' AND NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id)'
    }

    if (view === 'folder') {
      binds.push(query.folderId!)
      where += ` AND n.folder_id = ?${binds.length}`
    }

    // Several `tag` params combine with AND, and each one also matches its whole subtree so the
    // rolled-up count in the sidebar and the result set agree. Both halves have to stay in step
    // with tagInScope(), which spells the same rule in TypeScript for the offline shell.
    for (const scope of query.excludeTags ?? []) {
      binds.push(scope, likePattern(`${scope}/`))
      const nameBind = binds.length - 1
      const prefixBind = binds.length
      where += ` AND NOT EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                   WHERE nt.note_id = n.id AND t.user_id = n.user_id
                     AND ${tagScopePredicate('t.name', `?${nameBind}`, `?${prefixBind}`)})`
    }

    if (view === 'tag') {
      for (const tag of query.tags ?? []) {
        binds.push(tag, likePattern(`${tag}/`))
        const nameBind = binds.length - 1
        const prefixBind = binds.length
        where += ` AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                   WHERE nt.note_id = n.id AND t.user_id = n.user_id
                     AND ${tagScopePredicate('t.name', `?${nameBind}`, `?${prefixBind}`)})`
      }
    }

    const countWhere = where
    const countBinds = [...binds]

    const dir = order === 'asc' ? 'ASC' : 'DESC'
    const valueColumn = view === 'trash'
      ? 'n.deleted_at'
      : sort === 'created'
        ? 'n.created_at'
        : sort === 'title'
          ? 'n.title'
          : 'n.updated_at'
    const valueCollation = sort === 'title' && view !== 'trash' ? ' COLLATE NOCASE' : ''
    const orderBy =
      view === 'trash'
        ? `n.deleted_at ${dir}, n.id ASC`
        : ({
            updated: `n.is_pinned DESC, n.updated_at ${dir}, n.id ASC`,
            created: `n.is_pinned DESC, n.created_at ${dir}, n.id ASC`,
            title: `n.is_pinned DESC, n.title COLLATE NOCASE ${dir}, n.id ASC`,
          }[sort] ?? `n.is_pinned DESC, n.updated_at ${dir}, n.id ASC`)

    if (cursor.kind === 'keyset') {
      const comparison = order === 'asc' ? '>' : '<'
      if (view === 'trash') {
        binds.push(cursor.cursor.value, cursor.cursor.value, cursor.cursor.id)
        const valueBind = binds.length - 2
        const repeatedValueBind = binds.length - 1
        const idBind = binds.length
        where += ` AND (${valueColumn}${valueCollation} ${comparison} ?${valueBind}
          OR (${valueColumn}${valueCollation} = ?${repeatedValueBind} AND n.id > ?${idBind}))`
      } else {
        binds.push(
          cursor.cursor.pinned,
          cursor.cursor.pinned,
          cursor.cursor.value,
          cursor.cursor.value,
          cursor.cursor.id,
        )
        const firstPinnedBind = binds.length - 4
        const repeatedPinnedBind = binds.length - 3
        const valueBind = binds.length - 2
        const repeatedValueBind = binds.length - 1
        const idBind = binds.length
        where += ` AND (n.is_pinned < ?${firstPinnedBind}
          OR (n.is_pinned = ?${repeatedPinnedBind} AND (
            ${valueColumn}${valueCollation} ${comparison} ?${valueBind}
            OR (${valueColumn}${valueCollation} = ?${repeatedValueBind} AND n.id > ?${idBind})
          )))`
      }
    }

    const pageFrom = cursor.kind === 'legacy'
      ? `FROM notes n WHERE ${where} ORDER BY ${orderBy}
         LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
      : `FROM notes n WHERE ${where} ORDER BY ${orderBy}
         LIMIT ?${binds.length + 1}`
    const pageBinds = cursor.kind === 'legacy'
      ? [...binds, limit + 1, cursor.offset]
      : [...binds, limit + 1]
    const listStatement = this.db.prepare(`SELECT ${NOTE_COLUMNS_NOTAGS} ${pageFrom}`).bind(...pageBinds)
    const tagStatement = this.db.prepare(noteTagsQueryForPage(pageFrom)).bind(...pageBinds)
    // A keyset page continues a listing the client already counted; re-counting scans every
    // visible row (up to LIMITS.notesMaxPerUser) again on each page turn.
    const countTotal = cursor.kind !== 'keyset'
    const results = await this.db.batch(countTotal
      ? [
          this.db.prepare(`SELECT COUNT(*) AS total FROM notes n WHERE ${countWhere}`).bind(...countBinds),
          listStatement,
          tagStatement,
        ]
      : [listStatement, tagStatement])
    const [countResult, listResult, tagResult] = countTotal
      ? results
      : [undefined, results[0], results[1]]

    const total = countTotal
      ? Number((countResult?.results?.[0] as { total?: unknown } | undefined)?.total ?? 0)
      : null
    const rows = (listResult?.results as NoteRow[] | undefined) ?? []
    attachNoteTags(rows, (tagResult?.results as NoteTagRow[] | undefined) ?? [])
    return { rows, total }
  }
}
