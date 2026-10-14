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

import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt, likePattern, replaceTagInContent } from '@shared/markdown-utils'
import { utf8ByteLength } from '@shared/text-utils'
import type { AppBindings } from '../env'
import { tagScopePredicate, tagSelectQuery, type TagRow } from '../db/rows'
import {
  buildNoteDerivedStatements,
  INLINE_REWRITE_LIMIT,
  REWRITE_CONCURRENCY,
  REWRITE_LOAD_CHUNK,
  rewriteQueueStatement,
  shiftSqlPlaceholders,
} from '../db/writes'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'

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

/** The columns a PATCH compares against before it decides what changed. */
export interface TagCoreRow {
  id: string
  name: string
  color: string | null
  is_pinned: number
}

/**
 * One rename the route has already planned, guarded on the name the tag still answers to.
 *
 * `to` is the destination row's own name rather than the request's spelling, and `explicitColor` is
 * the route's `body.color !== undefined` test: the two rename branches write the colour only when the
 * client asked them to, which is not the rule `applyTagFamily` uses for a whole family.
 */
export interface TagRenameWrite {
  sourceId: string
  /** The name the tag had when the route read it; every statement in the batch is guarded on it. */
  from: string
  to: string
  color: string | null
  explicitColor: 0 | 1
  now: number
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

  /** The tag's identity columns, without the count the listing pays a join for. */
  async tagCore(id: string): Promise<TagCoreRow | null> {
    const row = await this.db
      .prepare(`SELECT id, name, color, is_pinned FROM tags WHERE id = ?1 AND user_id = ?2`)
      .bind(id, this.userId)
      .first<TagCoreRow>()
    return row ?? null
  }

  /** The two columns a delete guards on: the tag's name and nothing else. */
  async tagName(id: string): Promise<{ id: string; name: string } | null> {
    const row = await this.db
      .prepare(`SELECT id, name FROM tags WHERE id = ?1 AND user_id = ?2`)
      .bind(id, this.userId)
      .first<{ id: string; name: string }>()
    return row ?? null
  }

  /**
   * Drop one tag, its memberships and the change record that tells other devices about it.
   *
   * Three statements, one batch: all three are guarded on the same name the route read, so a tag that
   * was renamed underneath keeps its memberships and its row. The caller reads the last statement's
   * `meta.changes` as "the tag was still there to delete" and rolls its body rewrite back when not.
   */
  async deleteTag(input: { id: string; name: string; now: number }): Promise<boolean> {
    const guard = `EXISTS (SELECT 1 FROM tags WHERE id = ?1 AND user_id = ?2 AND name = ?3)`
    const statements = [
      this.db.prepare(`DELETE FROM note_tags WHERE tag_id = ?1 AND ${guard}`)
        .bind(input.id, this.userId, input.name),
      this.db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'tag', ?1, 'delete', ?4 WHERE ${guard}`,
      ).bind(input.id, this.userId, input.name, input.now),
      this.deleteTagStatement(input.id, input.name),
    ]
    const outcomes = await this.db.batch(statements)
    return Boolean(outcomes.at(-1)?.meta.changes)
  }

  /** The source-tag delete that ends both the delete and the merge batch, guarded on the name as read. */
  private deleteTagStatement(id: string, name: string): D1PreparedStatement {
    return this.db.prepare(`DELETE FROM tags WHERE id = ?1 AND user_id = ?2 AND name = ?3`)
      .bind(id, this.userId, name)
  }

  /**
   * Pin or unpin a tag still carrying the name and state the route read.
   *
   * The update is guarded on `is_pinned` as read and the change record on the state it wrote, so a
   * second device pinning the same tag in between shows up as `applied: false` rather than a record of
   * a change that never happened.
   */
  async setPinned(input: { id: string; name: string; from: number; to: number; now: number }): Promise<TagAppearanceResult> {
    const update = this.db.prepare(
      `UPDATE tags SET is_pinned = ?1
        WHERE id = ?2 AND user_id = ?3 AND name = ?4 AND is_pinned = ?5`,
    ).bind(input.to, input.id, this.userId, input.name, input.from)
    const change = this.db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'tag', ?2, 'upsert', ?3
        WHERE EXISTS (SELECT 1 FROM tags WHERE id = ?2 AND user_id = ?1 AND is_pinned = ?4)
       RETURNING seq`,
    ).bind(this.userId, input.id, input.now, input.to)
    const results = await this.db.batch([update, change])
    return {
      applied: Boolean(results[0]?.meta.changes),
      changeSeq: (results[1] as D1Result<{ seq: number }>).results?.[0]?.seq,
    }
  }

  /**
   * Set a tag's colour and mark it manually chosen, guarded the same way as the pin.
   *
   * `color IS ?5` rather than `=` because a tag without a colour is `NULL`, and the update also flips
   * `is_manual` so the automatic-tag pruning in a later note save stops deleting a colour somebody
   * picked on purpose.
   */
  async setColor(input: {
    id: string
    name: string
    color: string | null
    previous: string | null
    now: number
  }): Promise<TagAppearanceResult> {
    const update = this.db.prepare(
      `UPDATE tags SET color = ?1, is_manual = 1
        WHERE id = ?2 AND user_id = ?3 AND name = ?4 AND color IS ?5`,
    ).bind(input.color, input.id, this.userId, input.name, input.previous)
    const change = this.db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'tag', ?2, 'upsert', ?3
        WHERE EXISTS (SELECT 1 FROM tags WHERE id = ?2 AND user_id = ?1 AND color IS ?4)
       RETURNING seq`,
    ).bind(this.userId, input.id, input.now, input.color)
    const results = await this.db.batch([update, change])
    return {
      applied: Boolean(results[0]?.meta.changes),
      changeSeq: (results[1] as D1Result<{ seq: number }>).results?.[0]?.seq,
    }
  }

  /**
   * The tag this account would rename onto, ignoring the tag being renamed.
   *
   * `ORDER BY created_at ASC, id ASC` is the tie-break that decides which duplicate row a merge
   * copies onto, so it stays next to the merge rather than being spelled out twice.
   */
  async findRenameDestination(name: string, exceptId: string): Promise<{ id: string; name: string } | null> {
    const row = await this.db
      .prepare(
        `SELECT id, name FROM tags
          WHERE user_id = ?1 AND id <> ?2 AND name = ?3 COLLATE NOCASE
          ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .bind(this.userId, exceptId, name)
      .first<{ id: string; name: string }>()
    return row ?? null
  }

  /** The oldest tag answering to `name`, after a body rewrite may have created the destination row. */
  async findOldestByName(name: string): Promise<{ id: string } | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM tags WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE
          ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .bind(this.userId, name)
      .first<{ id: string }>()
    return row ?? null
  }

  /**
   * Rename a single tag whose own id survived the body rewrite, so no destination row is needed.
   *
   * Two statements in one batch: the update is guarded on the name the route read, and the change
   * record only lands if the guard matched — otherwise a device would be told to pull a rename that
   * never happened.
   */
  async applyDirectRename(input: TagRenameWrite): Promise<boolean> {
    const update = this.db.prepare(
      `UPDATE tags SET name = ?4,
         color = CASE WHEN ?5 = 1 THEN ?6 ELSE color END,
         is_manual = 1
        WHERE id = ?1 AND user_id = ?2 AND name = ?3`,
    ).bind(input.sourceId, this.userId, input.from, input.to, input.explicitColor, input.color)
    const change = this.db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?2, 'tag', ?1, 'upsert', ?4
        WHERE EXISTS (SELECT 1 FROM tags
          WHERE id = ?1 AND user_id = ?2 AND name = ?5)`,
    ).bind(input.sourceId, this.userId, input.from, input.now, input.to)
    const [applied] = await this.db.batch([update, change])
    return Boolean(applied?.meta.changes)
  }

  /**
   * Merge one tag onto a destination row that already exists, and retire the source.
   *
   * Six statements, one batch, because the merge is only atomic as a whole: the destination row is
   * created from the source (`ON CONFLICT` copies the colour and pin rather than renaming in place,
   * which would hit `idx_tags_unique`), the memberships move, only then does the source go, and the
   * two change records name the rows that exist after each step. The last statement's `meta.changes`
   * is what the route reads as "the source was still there to delete".
   */
  async mergeRenamedTag(input: TagRenameWrite & { targetId: string }): Promise<boolean> {
    const sourceGuard = `EXISTS (SELECT 1 FROM tags
      WHERE id = ?1 AND user_id = ?2 AND name = ?3)`
    const statements = [
      this.db.prepare(
        `INSERT INTO tags (id, user_id, name, color, is_manual, is_pinned, created_at)
         SELECT ?4, ?2, ?5,
                CASE WHEN ?6 = 1 THEN ?7 ELSE source.color END,
                1, source.is_pinned, ?8
           FROM tags source
          WHERE source.id = ?1 AND source.user_id = ?2 AND source.name = ?3
           ON CONFLICT(user_id, name) DO UPDATE SET
             color = CASE WHEN ?6 = 1 THEN ?7 ELSE COALESCE(tags.color, excluded.color) END,
             is_manual = 1,
             is_pinned = MAX(tags.is_pinned, excluded.is_pinned)`,
      ).bind(input.sourceId, this.userId, input.from, input.targetId, input.to, input.explicitColor, input.color, input.now),
      this.db.prepare(
        `INSERT OR IGNORE INTO note_tags (note_id, tag_id)
         SELECT nt.note_id, target.id
           FROM note_tags nt
           JOIN tags target ON target.user_id = ?2 AND target.name = ?4
          WHERE nt.tag_id = ?1 AND ${sourceGuard}`,
      ).bind(input.sourceId, this.userId, input.from, input.to),
      this.db.prepare(`DELETE FROM note_tags WHERE tag_id = ?1 AND ${sourceGuard}`)
        .bind(input.sourceId, this.userId, input.from),
      this.db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'tag', target.id, 'upsert', ?4
           FROM tags target WHERE target.user_id = ?2 AND target.name = ?5 AND ${sourceGuard}`,
      ).bind(input.sourceId, this.userId, input.from, input.now, input.to),
      this.db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'tag', ?1, 'delete', ?4 WHERE ${sourceGuard}`,
      ).bind(input.sourceId, this.userId, input.from, input.now),
      this.deleteTagStatement(input.sourceId, input.from),
    ]
    const results = await this.db.batch(statements)
    return Boolean(results.at(-1)?.meta.changes)
  }

  /**
   * The tags of this account answering to any of `names`, case-insensitively.
   *
   * Chunked at 90 names per statement because D1 caps bound variables well below what a long family
   * produces, and node:sqlite does not complain — one IN query per chunk instead of two round trips
   * per step. The caller still has the whole result set, so the chunk size is a transport limit only.
   */
  async findRowsNamed(names: readonly string[]): Promise<Array<{ id: string; name: string }>> {
    const rows: Array<{ id: string; name: string }> = []
    for (let start = 0; start < names.length; start += 90) {
      const chunk = names.slice(start, start + 90)
      const { results } = await this.db.prepare(
        `SELECT id, name FROM tags WHERE user_id = ?1
          AND name COLLATE NOCASE IN (${chunk.map((_name, index) => `?${index + 2}`).join(', ')})`,
      ).bind(this.userId, ...chunk).all<{ id: string; name: string }>()
      rows.push(...results)
    }
    return rows
  }
}

/** One member of a tag family moving from `from` to `to`. */
export interface TagFamilyStep {
  id: string
  from: string
  to: string
}

/**
 * The tag plus every descendant, deepest name first, each mapped onto `destination`. The `/` in
 * the LIKE pattern is load-bearing: without that boundary `a` would claim the unrelated sibling
 * `ab` and rewrite every `#ab` in the library. The family is snapshotted before anything is
 * written so each step only ever sees the exact name it was asked about.
 */
export async function planTagFamily(
  db: D1Database,
  userId: string,
  root: { id: string; name: string },
  destination: string,
): Promise<TagFamilyStep[]> {
  const { results: family } = await db.prepare(
    `SELECT id, name FROM tags
      WHERE user_id = ?1 AND ${tagScopePredicate('name', '?2', '?3')}
      ORDER BY length(name) DESC, name COLLATE NOCASE`,
  ).bind(userId, root.name, likePattern(`${root.name}/`)).all<{ id: string; name: string }>()

  const plan: TagFamilyStep[] = []
  for (const member of family) {
    const to = destination + member.name.slice(root.name.length)
    if (to !== member.name) plan.push({ id: member.id, from: member.name, to })
  }
  return plan
}

/**
 * Bodies first, rows second: rewriteTagInNotes finds its candidates by joining on the source tag
 * row, so that row has to still exist. The derived pass then creates the destination rows from
 * the rewritten content, which is why the batch copies onto them instead of renaming in place
 * (an UPDATE would hit idx_tags_unique).
 *
 * Known gap: past INLINE_REWRITE_LIMIT a member's rewrite is handed to rewrite_queue whose
 * rollback is a no-op, so a later member failing cannot undo an earlier queued rename. That
 * converges to a partially moved family with a duplicate tag, never to lost text. A family
 * large enough to need several batches has the same exposure inside the row pass: each batch
 * is its own transaction, so a failure in a later one leaves the earlier ones applied.
 */
export async function applyTagFamily(
  env: TagRewriteEnv,
  ftsEnabled: boolean,
  userId: string,
  plan: readonly TagFamilyStep[],
  color?: string | null,
): Promise<{ moved: number; rewritten: number }> {
  const rewrites: TagRewriteResult[] = []
  try {
    for (const step of plan)
      rewrites.push(await rewriteTagInNotes(env, ftsEnabled, userId, step.id, step.from, step.to))
  } catch (error) {
    try {
      for (const rewrite of rewrites.reverse()) await rewrite.rollback()
    } catch {
      throw ApiError.conflict('Tag rename could not be rolled back safely; refresh and try again')
    }
    throw error
  }

  const explicitColor = color === undefined ? 0 : 1
  const now = Date.now()
  const guard = `EXISTS (SELECT 1 FROM tags WHERE id = ?1 AND user_id = ?2 AND name = ?3)`
  const db = env.DB
  const statements = plan.flatMap((step) => {
    const source = [step.id, userId, step.from] as const
    return [
      db.prepare(
        `INSERT INTO tags (id, user_id, name, color, is_manual, is_pinned, created_at)
         SELECT ?4, ?2, ?5,
                CASE WHEN ?6 = 1 THEN ?7 ELSE source.color END,
                1, source.is_pinned, source.created_at
           FROM tags source WHERE source.id = ?1 AND source.user_id = ?2 AND source.name = ?3
         ON CONFLICT(user_id, name) DO UPDATE SET
           color = CASE WHEN ?6 = 1 THEN ?7 ELSE COALESCE(tags.color, excluded.color) END,
           is_manual = 1,
           is_pinned = MAX(tags.is_pinned, excluded.is_pinned)`,
      ).bind(...source, newId(), step.to, explicitColor, color ?? null),
      db.prepare(
        `INSERT OR IGNORE INTO note_tags (note_id, tag_id)
         SELECT nt.note_id, target.id
           FROM note_tags nt JOIN tags target ON target.user_id = ?2 AND target.name = ?4
          WHERE nt.tag_id = ?1 AND ${guard}`,
      ).bind(...source, step.to),
      db.prepare(`DELETE FROM note_tags WHERE tag_id = ?1 AND ${guard}`).bind(...source),
      db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'tag', target.id, 'upsert', ?4
           FROM tags target WHERE target.user_id = ?2 AND target.name = ?5 AND ${guard}`,
      ).bind(...source, now, step.to),
      db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'tag', ?1, 'delete', ?4 WHERE ${guard}`,
      ).bind(...source, now),
      db.prepare(`DELETE FROM tags WHERE id = ?1 AND user_id = ?2 AND name = ?3`)
        .bind(...source),
    ]
  })

  // Six statements per member, so a family of fourteen already outgrows the batch ceiling this
  // repo respects elsewhere (the sibling renumbering in the folders store). Each chunk is its own
  // transaction, so a late failure leaves the earlier chunk applied; note bodies still roll back.
  const MAX_BATCH_STATEMENTS = 80
  let outcomes: D1Result[]
  try {
    outcomes = []
    for (let start = 0; start < statements.length; start += MAX_BATCH_STATEMENTS) {
      const chunk = await db.batch(statements.slice(start, start + MAX_BATCH_STATEMENTS))
      outcomes.push(...chunk)
    }
  } catch (error) {
    try {
      for (const rewrite of [...rewrites].reverse()) await rewrite.rollback()
    } catch {
      throw ApiError.conflict('Tag rename could not be rolled back safely; refresh and try again')
    }
    throw ApiError.conflict('The tag rename was refused. Refresh and try again')
  }
  if (plan.some((_step, index) => !outcomes[index * 6 + 5]?.meta.changes)) {
    try {
      for (const rewrite of rewrites.reverse()) await rewrite.rollback()
    } catch {
      throw ApiError.conflict('Tag rename could not be rolled back safely; refresh and try again')
    }
    throw ApiError.conflict('The tag changed elsewhere. Refresh and try again')
  }
  return { moved: plan.length, rewritten: rewrites.reduce((sum, r) => sum + r.rewritten, 0) }
}

/** Either a guarded appearance write landed, or the tag changed underneath and nothing was recorded. */
export interface TagAppearanceResult {
  applied: boolean
  changeSeq: number | undefined
}

/**
 * Only the D1 binding the rewrite path reads.
 *
 * `lib/rewrite-drain.ts` and `mcp/library.ts` reach this through the tags route and have always handed
 * over their request environment, so the parameter stays the shape they pass instead of every caller
 * being rewritten for a naming change. Nothing here reads a second field of it.
 */
export type TagRewriteEnv = Pick<AppBindings['Bindings'], 'DB'>

export interface TagRewriteResult {
  rewritten: number
  remaining: number
  rollback: () => Promise<void>
}

export async function rewriteTagInNotes(
  env: TagRewriteEnv,
  ftsEnabled: boolean,
  userId: string,
  tagId: string,
  from: string,
  to: string | null,
  forceInline = false,
  budgetNotes = Number.POSITIVE_INFINITY,
): Promise<TagRewriteResult> {
  const db = env.DB
  const { results } = await db.prepare(
    `SELECT n.id FROM notes n
       JOIN note_tags nt ON nt.note_id = n.id
      WHERE nt.tag_id = ?1 AND n.user_id = ?2`,
  )
    .bind(tagId, userId)
    .all<{ id: string }>()

  if (!forceInline && results.length > INLINE_REWRITE_LIMIT) {
    await db.batch([
      rewriteQueueStatement(db, userId, to === null ? 'tag-delete' : 'tag-rename', tagId, from, to ?? ''),
    ])
    return { rewritten: 0, remaining: 0, rollback: async () => {} }
  }

  let rewritten = 0
  const rewrittenNotes: RewrittenTagNote[] = []
  try {
    const candidateIds = results.map((c) => c.id)
    const plan = Number.isFinite(budgetNotes) ? candidateIds.slice(0, budgetNotes) : candidateIds
    const remaining = candidateIds.length - plan.length
    type CandidateNote = {
      id: string
      title: string
      content: string
      rev: number
      updated_at: number
      deleted_at: number | null
    }
    // Load and rewrite in small windows: a hub tag must not pin every candidate body in
    // the isolate before the first write happens.
    for (let start = 0; start < plan.length; start += REWRITE_LOAD_CHUNK) {
      const windowIds = plan.slice(start, start + REWRITE_LOAD_CHUNK)
      const placeholders = windowIds.map((_, idx) => `?${idx + 2}`).join(', ')
      const { results: loaded } = await db.prepare(
        `SELECT id, title, content, rev, updated_at, deleted_at
           FROM notes WHERE user_id = ?1 AND id IN (${placeholders})`,
      ).bind(userId, ...windowIds).all<CandidateNote>()
      const notesToRewrite = loaded.filter((note) => replaceTagInContent(note.content, from, to) !== note.content)
      for (let i = 0; i < notesToRewrite.length; i += REWRITE_CONCURRENCY) {
        const batch = notesToRewrite.slice(i, i + REWRITE_CONCURRENCY)
        const outcomes = await Promise.all(
          batch.map(async (initialNote) => {
            let currentNote: CandidateNote | null = initialNote
            for (let attempt = 0; attempt < 5; attempt++) {
              if (!currentNote) return { success: true }
              const content = replaceTagInContent(currentNote.content, from, to)
              if (content === currentNote.content) return { success: true }

              const title = currentNote.title
              const { words, chars } = countText(content)
              const hash = await sha256Hex(content)
              const now = Math.max(Date.now(), currentNote.updated_at + 1)
              const nextRev = currentNote.rev + 1
              const mutationGuard = `EXISTS (SELECT 1 FROM notes
                WHERE id = ?1 AND user_id = ?2 AND rev = ?3
                  AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
              const mutationValues = [currentNote.id, userId, nextRev, hash, title, now] as const
              const update = db.prepare(
                `UPDATE notes SET title = ?1, content = ?2, excerpt = ?3, word_count = ?4, char_count = ?5,
                   content_hash = ?6, rev = ?7, updated_at = ?8
                  WHERE id = ?9 AND user_id = ?10 AND rev = ?11`,
              ).bind(
                title,
                content,
                deriveExcerpt(content),
                words,
                chars,
                hash,
                nextRev,
                now,
                currentNote.id,
                userId,
                currentNote.rev,
              )
              const snapshot = db.prepare(
                `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
                  WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}`,
              ).bind(
                newId(),
                currentNote.id,
                userId,
                currentNote.title,
                currentNote.content,
                utf8ByteLength(currentNote.content),
                now,
                ...mutationValues,
              )
              const trim = db.prepare(
                `DELETE FROM note_versions WHERE note_id = ?1
                   AND ${shiftSqlPlaceholders(mutationGuard, 1)}
                   AND id IN (
                     SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
              ).bind(currentNote.id, ...mutationValues, LIMITS.versionsPerNote)
              const statements: D1PreparedStatement[] = [update, snapshot, trim]
              if (currentNote.deleted_at === null) {
                statements.push(...buildNoteDerivedStatements({
                  db,
                  userId,
                  noteId: currentNote.id,
                  title,
                  content,
                  ftsEnabled,
                  titleChanged: title !== currentNote.title,
                  previousTitle: currentNote.title,
                  expectedRev: nextRev,
                  expectedContentHash: hash,
                  expectedTitle: title,
                  expectedUpdatedAt: now,
                }).statements)
              }
              statements.push(
                db.prepare(
                  `INSERT INTO changes (user_id, entity, entity_id, op, at)
                   SELECT ?1, 'note', ?2, 'upsert', ?3
                    WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}`,
                ).bind(userId, currentNote.id, now, ...mutationValues),
              )
              const [updated] = await db.batch(statements)
              if (updated?.meta.changes) {
                return { success: true, rewrittenNote: { note: currentNote, nextRev, updatedAt: now } }
              }
              currentNote = await db.prepare(
                `SELECT id, title, content, rev, updated_at, deleted_at
                   FROM notes WHERE id = ?1 AND user_id = ?2`,
              ).bind(currentNote.id, userId).first<CandidateNote>()
            }
            return { success: false }
          }),
        )
      for (const res of outcomes) {
        if (!res.success) {
          throw ApiError.conflict(`Some notes are still being edited. Safely completed ${rewritten} notes; try again later`)
        }
        if (res.rewrittenNote) {
          rewritten++
          rewrittenNotes.push(res.rewrittenNote)
        }
      }
      }
    }
    return {
      rewritten,
      remaining,
      rollback: () => rollbackTagRewrites(env, ftsEnabled, userId, rewrittenNotes),
    }
  } catch (error) {
    try {
      await rollbackTagRewrites(env, ftsEnabled, userId, rewrittenNotes)
    } catch {
      throw ApiError.conflict('Tag rename could not be rolled back safely; refresh and try again')
    }
    throw error
  }
}

interface RewrittenTagNote {
  note: {
    id: string
    title: string
    content: string
    rev: number
    updated_at: number
    deleted_at: number | null
  }
  nextRev: number
  updatedAt: number
}

async function rollbackTagRewrites(
  env: TagRewriteEnv,
  ftsEnabled: boolean,
  userId: string,
  rewrittenNotes: readonly RewrittenTagNote[],
): Promise<void> {
  const db = env.DB
  for (const rewritten of [...rewrittenNotes].reverse()) {
    const { note, nextRev, updatedAt } = rewritten
    const hash = await sha256Hex(note.content)
    const { words, chars } = countText(note.content)
    const update = db.prepare(
      `UPDATE notes SET content = ?1, excerpt = ?2, word_count = ?3, char_count = ?4,
         content_hash = ?5, rev = ?6, updated_at = ?7
        WHERE id = ?8 AND user_id = ?9 AND rev = ?10 AND updated_at = ?11`,
    ).bind(
      note.content,
      deriveExcerpt(note.content),
      words,
      chars,
      hash,
      note.rev,
      note.updated_at,
      note.id,
      userId,
      nextRev,
      updatedAt,
    )
    const statements: D1PreparedStatement[] = [update]
    if (note.deleted_at === null) {
      statements.push(...buildNoteDerivedStatements({
        db,
        userId,
        noteId: note.id,
        title: note.title,
        content: note.content,
        ftsEnabled,
        expectedRev: note.rev,
        expectedContentHash: hash,
        expectedTitle: note.title,
        expectedUpdatedAt: note.updated_at,
      }).statements)
    }
    statements.push(
      db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'note', ?2, 'upsert', ?3
          WHERE EXISTS (SELECT 1 FROM notes
            WHERE id = ?2 AND user_id = ?1 AND rev = ?4 AND updated_at = ?5)`,
      ).bind(userId, note.id, Date.now(), note.rev, note.updated_at),
    )
    const [restored] = await db.batch(statements)
    if (!restored?.meta.changes) throw new Error('tag rewrite rollback conflict')
  }
}
