/**
 * Every read and write the tag HTTP routes make against D1.
 *
 * The shape follows `notes/store.ts` and `assistant/store.ts`: a store built per request from the
 * account it serves, methods that take already-validated input and hand back rows or the record the
 * route needs to answer with, and nothing in between that knows about HTTP. Two rules hold throughout:
 *  - every statement carries `user_id`, so one account's tags can never surface in another's listing.
 *    The few that cannot are deliberate: the id-collision probe below answers a client-supplied id,
 *    which is only meaningful across accounts, and the rewrite paths that address a note by an id this
 *    store already resolved inside a `user_id`-scoped statement;
 *  - a mutation's statements stay in one D1 batch. The guards inside them (`name`, `is_pinned`, `color`)
 *    only mean "nobody changed this row between my read and my write" while the whole batch lands
 *    together, so splitting a batch into sequential runs would turn an atomic rename into a partially
 *    moved family that no test would notice.
 *
 * `broadcastCursor` and the FTS drain stay with the route: the cursor belongs to the response and the
 * background work to the request context.
 */

import { tagSelectQuery, type TagRow } from '../db/rows'

/** A manual tag the route has validated and named; `id` and `now` were chosen by the route. */
export interface TagCreateInput {
  id: string
  name: string
  /** Already passed through `organizerColorOrNull`, so the store never decides what a colour means. */
  color: string | null
  now: number
}

export interface TagCreateResult {
  /** False when the insert lost to a tag with the same `(user_id, name)` that appeared in between. */
  created: boolean
  changeSeq: number | undefined
  /** The row as this batch leaves it, so the route answers without a second round trip. */
  row: TagRow | null
}

export class TagsStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * Every tag of this account with its live note count, in the order the sidebar lists them.
   *
   * `tagSelectQuery` folds the count of non-archived, non-trashed notes into the one grouped read, so
   * the listing costs a single statement however many tags the account owns.
   */
  async listTags(): Promise<TagRow[]> {
    const { results } = await this.db
      .prepare(`${tagSelectQuery('t.user_id = ?1')} ORDER BY t.name COLLATE NOCASE`)
      .bind(this.userId)
      .all<TagRow>()
    return results ?? []
  }

  /** One tag of this account, counts included; `null` is both "not mine" and "not there". */
  async tagRow(id: string): Promise<TagRow | null> {
    const row = await this.db
      .prepare(tagSelectQuery('t.user_id = ?1 AND t.id = ?2'))
      .bind(this.userId, id)
      .first<TagRow>()
    return row ?? null
  }

  /**
   * Whether any account already owns this id.
   *
   * Deliberately the one read here without a `user_id` filter: it answers a client-supplied id
   * collision, which is only meaningful across accounts. It reads a single column of a row the caller
   * cannot address any other way, and the caller has already failed the same id against its own tag.
   */
  async idTakenByAnyone(id: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT user_id FROM tags WHERE id = ?1`)
      .bind(id)
      .first<{ user_id: string }>()
    return row !== null
  }

  /**
   * The account's own tag answering to `name`, if it has one — the create-time duplicate probe.
   *
   * `LIMIT 1` with no ordering is what the create path asked for: any hit at all is a conflict, so
   * which one comes back does not matter. The rename probes below are separate methods because they
   * do care, and re-ordering them would change which tag a merge picks as its destination.
   */
  async hasTagNamed(name: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT id FROM tags WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE LIMIT 1`)
      .bind(this.userId, name)
      .first<{ id: string }>()
    return row !== null
  }

  /**
   * Create one manual tag, with its change record and readback in the same batch.
   *
   * The change insert is guarded on the tag existing afterwards, so a create that matched no row
   * records nothing for the other devices to pull; the readback rides along for the same reason the
   * notes create does — the answer describes exactly the state this batch left behind.
   */
  async createTag(input: TagCreateInput): Promise<TagCreateResult> {
    const insert = this.db.prepare(
      `INSERT INTO tags (id, user_id, name, color, is_manual, created_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5)`,
    ).bind(input.id, this.userId, input.name, input.color, input.now)
    const change = this.db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'tag', ?2, 'upsert', ?3
        WHERE EXISTS (SELECT 1 FROM tags WHERE id = ?2 AND user_id = ?1)
       RETURNING seq`,
    ).bind(this.userId, input.id, input.now)
    const readback = this.db.prepare(
      tagSelectQuery('t.user_id = ?1 AND t.id = ?2'),
    ).bind(this.userId, input.id)
    const results = await this.db.batch([insert, change, readback])
    return {
      created: Boolean(results[0]?.meta.changes),
      changeSeq: (results.at(-2) as D1Result<{ seq: number }>).results?.[0]?.seq,
      row: (results.at(-1) as D1Result<TagRow>).results?.[0] ?? null,
    }
  }
}
