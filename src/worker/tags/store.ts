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
}
