/**
 * Private AI semantic search for the MCP module.
 *
 * Notes are embedded with Workers AI (`@cf/baai/bge-m3`, 1024 dims,
 * multilingual) and the vectors live in D1 — no public query endpoint, one
 * index per account. Content changes are queued and drained in the
 * background; when the AI binding is missing or the model call fails the
 * feature degrades to plain lexical search instead of failing (the old
 * behavior that surfaced as HTTP 503s).
 */
import { toPlainText } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import { getMeta, selectQueueUsersRoundRobin, setMeta } from '../db/metadata'
import type { Env } from '../env'

export const AI_EMBEDDING_MODEL = '@cf/baai/bge-m3'
const AI_EMBEDDING_DIMS = 1024
const EMBED_TEXT_MAX_CHARS = 4_000
const MAX_SEMANTIC_VECTORS = 200
const SEMANTIC_TOP_K = 40
const DRAIN_USERS_PER_RUN = 10
const DRAIN_PER_USER = 25
const AI_DRAIN_CURSOR_META_KEY = 'ai-index-drain-user-v1'
const ENQUEUE_CHUNK = 200
const EMBED_CHUNK = 16
export const RRF_K = 60

export type AiIndexKind = 'embed' | 'delete'

export interface AiSearchStatus {
  available: boolean
  enabled: boolean
  model: string
  indexedCount: number
  pendingCount: number
  reason: 'no_ai_binding' | null
}

export interface SemanticSearchHit {
  id: string
  title: string
  excerpt: string
  rev: number
  updatedAt: number
  score: number
}

interface QueueRow {
  note_id: string
  kind: AiIndexKind
  created_at: number
}

interface EmbeddingRow {
  id: string
  title: string
  excerpt: string
  rev: number
  updated_at: number
  vector: ArrayBuffer
  norm: number | null
}

export interface SemanticFilters {
  tags?: string[]
  folder?: string
  starred?: boolean
  archived?: boolean
}

export function isAiSearchAvailable(env: Env): boolean {
  return Boolean(env.AI)
}

export async function getAiSearchStatus(
  db: D1Database,
  env: Env,
  userId: string,
): Promise<AiSearchStatus> {
  const [enabled, indexed, pending] = await Promise.all([
    isAiSearchEnabled(db, userId),
    db.prepare(`SELECT COUNT(*) AS n FROM ai_note_embeddings WHERE user_id = ?1`)
      .bind(userId).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM ai_index_queue WHERE user_id = ?1`)
      .bind(userId).first<{ n: number }>(),
  ])
  return {
    available: isAiSearchAvailable(env),
    enabled,
    model: AI_EMBEDDING_MODEL,
    indexedCount: indexed?.n ?? 0,
    pendingCount: pending?.n ?? 0,
    reason: isAiSearchAvailable(env) ? null : 'no_ai_binding',
  }
}

export async function setAiSearchEnabled(
  db: D1Database,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await setMeta(db, aiSearchPrefKey(userId), enabled ? '1' : '0')
}

export async function isAiSearchEnabled(db: D1Database, userId: string): Promise<boolean> {
  return await getMeta(db, aiSearchPrefKey(userId)) === '1'
}

// Stored in app_meta instead of a column on mcp_preferences: D1 does not
// reliably support ALTER TABLE ADD COLUMN with constraints, and app_meta
// exists on every database without any migration.
function aiSearchPrefKey(userId: string): string {
  return `ai-search-enabled:${userId}`
}

/**
 * Queues a note for embedding (or vector deletion). The single row per note
 * uses last-write-wins semantics: a delete supersedes a pending embed and
 * vice versa. Queuing is skipped entirely while the account has AI search
 * disabled, except deletions which always clean up stale vectors.
 */
export function noteIndexQueueStatement(
  db: D1Database,
  userId: string,
  noteId: string,
  kind: AiIndexKind,
  now = Date.now(),
): D1PreparedStatement {
  const guard = kind === 'embed'
    ? ` WHERE EXISTS (SELECT 1 FROM app_meta WHERE key = ?5 AND value = '1')`
    : ` WHERE ${aiDeleteNeededSql('?1', '?2')}`
  const statement = db.prepare(
    `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
     SELECT ?1, ?2, ?3,
       MAX(?4, COALESCE((SELECT created_at + 1 FROM ai_index_queue
         WHERE user_id = ?1 AND note_id = ?2), ?4))${guard}`,
  )
  return kind === 'embed'
    ? statement.bind(userId, noteId, kind, now, aiSearchPrefKey(userId))
    : statement.bind(userId, noteId, kind, now)
}

export function aiDeleteNeededSql(userId: string, noteId: string): string {
  return `(EXISTS (SELECT 1 FROM ai_note_embeddings
    WHERE user_id = ${userId} AND note_id = ${noteId})
    OR EXISTS (SELECT 1 FROM ai_index_queue
      WHERE user_id = ${userId} AND note_id = ${noteId}))`
}

export async function enqueueAllNotesForIndex(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<number> {
  const boundary = await db.prepare(
    `SELECT MAX(id) AS id FROM notes WHERE user_id = ?1 AND deleted_at IS NULL`,
  ).bind(userId).first<{ id: string | null }>()
  const lastId = boundary?.id
  if (!lastId) return 0

  let cursor = ''
  let enqueued = 0
  while (cursor < lastId) {
    const { results } = await db.prepare(
      `SELECT id FROM notes
        WHERE user_id = ?1 AND deleted_at IS NULL AND id > ?2 AND id <= ?3
        ORDER BY id ASC LIMIT ?4`,
    ).bind(userId, cursor, lastId, ENQUEUE_CHUNK).all<{ id: string }>()
    if (!results.length) break

    const statements = results.map(({ id }) => db.prepare(
      `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
       SELECT ?1, ?2, 'embed',
         MAX(?3, COALESCE((SELECT created_at + 1 FROM ai_index_queue
           WHERE user_id = ?1 AND note_id = ?2), ?3))`,
    ).bind(userId, id, now))
    await db.batch(statements)
    enqueued += results.length
    cursor = results[results.length - 1]!.id
  }
  return enqueued
}

export async function clearAiIndex(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM ai_note_embeddings WHERE user_id = ?1`,
  ).bind(userId).first<{ n: number }>()
  await db.batch([
    db.prepare(`DELETE FROM ai_note_embeddings WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM ai_index_queue WHERE user_id = ?1`).bind(userId),
  ])
  return row?.n ?? 0
}

/**
 * Processes queued embedding jobs. Called from the hourly cron with a large
 * budget and from write paths (via waitUntil) with a small one. Items are
 * processed sequentially so Workers AI rate limits are respected; a failing
 * item stops the batch and is retried on the next run.
 */
export async function drainAiIndexQueue(env: Env, max: number): Promise<{ processed: number }> {
  if (!env.AI) return { processed: 0 }
  const budget = Math.max(0, Math.trunc(max))
  if (!Number.isFinite(budget) || budget === 0) return { processed: 0 }
  let processed = 0
  const users = await selectQueueUsersRoundRobin(
    env.DB,
    'ai_index_queue',
    AI_DRAIN_CURSOR_META_KEY,
    Math.min(DRAIN_USERS_PER_RUN, Math.ceil(budget / DRAIN_PER_USER)),
  )
  for (const user_id of users) {
    if (processed >= budget) break
    if (!await isAiSearchEnabled(env.DB, user_id)) {
      // The account turned AI search off; its queue would otherwise grow forever.
      await env.DB.prepare(`DELETE FROM ai_index_queue WHERE user_id = ?1`).bind(user_id).run()
      continue
    }
    processed += await drainUserQueue(env, user_id, Math.min(budget - processed, DRAIN_PER_USER))
  }
  return { processed }
}

/**
 * Drains a couple of queued embeddings right after a write so semantic
 * results stay fresh between cron runs. Never blocks the response.
 */
export function scheduleAiDrainForNote(
  c: { env: Env; executionCtx?: { waitUntil: (promise: Promise<unknown>) => void } | undefined },
  userId: string,
): void {
  if (!c.executionCtx) return
  c.executionCtx.waitUntil(drainUserQueueForWrites(c.env, userId).catch((error) => {
    console.warn('[inkstone] Background embedding drain failed:', error instanceof Error ? error.message : error)
  }))
}

async function drainUserQueueForWrites(env: Env, userId: string, max = 2): Promise<void> {
  if (!env.AI) return
  if (!await isAiSearchEnabled(env.DB, userId)) return
  await drainUserQueue(env, userId, max)
}

async function drainUserQueue(env: Env, userId: string, max: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT note_id, kind, created_at FROM ai_index_queue
      WHERE user_id = ?1 ORDER BY created_at ASC LIMIT ?2`,
  ).bind(userId, max).all<QueueRow>()
  let done = 0
  for (let offset = 0; offset < results.length; offset += EMBED_CHUNK) {
    const chunk = results.slice(offset, offset + EMBED_CHUNK)
    try {
      done += await processQueueChunk(env, userId, chunk)
    } catch (error) {
      console.warn('[inkstone] AI index drain paused:', error instanceof Error ? error.message : error)
      break
    }
  }
  return done
}

async function processQueueChunk(env: Env, userId: string, items: QueueRow[]): Promise<number> {
  const db = env.DB
  const ai = env.AI
  if (!ai || !items.length) return 0
  const queueGuard = `EXISTS (SELECT 1 FROM ai_index_queue
    WHERE user_id = ?3 AND note_id = ?4 AND kind = ?5 AND created_at = ?6)`
  const insertQueueGuard = `EXISTS (SELECT 1 FROM ai_index_queue
    WHERE user_id = ?7 AND note_id = ?8 AND kind = ?9 AND created_at = ?10)`
  const cleanup = (item: QueueRow): D1PreparedStatement[] => [
    db.prepare(
      `DELETE FROM ai_note_embeddings
        WHERE user_id = ?1 AND note_id = ?2 AND ${queueGuard}`,
    ).bind(userId, item.note_id, userId, item.note_id, item.kind, item.created_at),
    db.prepare(
      `DELETE FROM ai_index_queue
        WHERE user_id = ?1 AND note_id = ?2 AND kind = ?3 AND created_at = ?4`,
    ).bind(userId, item.note_id, item.kind, item.created_at),
  ]

  const statements: D1PreparedStatement[] = []
  const embeds: QueueRow[] = []
  for (const item of items) {
    if (item.kind === 'delete') statements.push(...cleanup(item))
    else embeds.push(item)
  }
  if (embeds.length) {
    const { results: noteRows } = await db.prepare(
      `SELECT id, title, substr(content, 1, ?3) AS content FROM notes
        WHERE user_id = ?1 AND deleted_at IS NULL
          AND id IN (SELECT value FROM json_each(?2))`,
    ).bind(userId, JSON.stringify(embeds.map((item) => item.note_id)), EMBED_TEXT_MAX_CHARS)
      .all<{ id: string; title: string; content: string }>()
    const byId = new Map(noteRows.map((row) => [row.id, row]))
    const present: Array<{ item: QueueRow; text: string }> = []
    for (const item of embeds) {
      const note = byId.get(item.note_id)
      if (!note) {
        statements.push(...cleanup(item))
        continue
      }
      present.push({ item, text: `${note.title}\n${note.content}`.slice(0, EMBED_TEXT_MAX_CHARS) })
    }
    if (present.length) {
      const vectors = await embedTexts(ai, present.map((entry) => entry.text))
      present.forEach(({ item }, index) => {
        const vector = vectors[index]!
        statements.push(
          db.prepare(
            `INSERT INTO ai_note_embeddings (user_id, note_id, model, vector, indexed_at, norm)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${insertQueueGuard}
             ON CONFLICT(user_id, note_id) DO UPDATE SET
               vector = excluded.vector, indexed_at = excluded.indexed_at, norm = excluded.norm`,
          ).bind(
            userId,
            item.note_id,
            AI_EMBEDDING_MODEL,
            encodeVector(vector),
            Date.now(),
            vectorNorm(vector),
            userId,
            item.note_id,
            item.kind,
            item.created_at,
          ),
          db.prepare(
            `DELETE FROM ai_index_queue
              WHERE user_id = ?1 AND note_id = ?2 AND kind = ?3 AND created_at = ?4`,
          ).bind(userId, item.note_id, item.kind, item.created_at),
        )
      })
    }
  }
  await db.batch(statements)
  return items.length
}

/**
 * Semantic retrieval over the account's embedding index. Returns null when
 * AI is unavailable or the query embedding fails; the caller degrades to
 * lexical search.
 */
export async function searchSemanticNotes(
  env: Env,
  db: D1Database,
  userId: string,
  query: string,
  filters: SemanticFilters,
): Promise<SemanticSearchHit[] | null> {
  if (!env.AI || !await isAiSearchEnabled(db, userId)) return null
  const queryVector = await embedQueryText(env.AI, query)
  const { binds, where } = semanticWhere(userId, filters)
  binds.push(MAX_SEMANTIC_VECTORS)
  const { results } = await db.prepare(
    `SELECT n.id, n.title, n.excerpt, n.rev, n.updated_at, e.vector, e.norm
       FROM ai_note_embeddings e JOIN notes n
         ON n.id = e.note_id AND n.user_id = e.user_id
      WHERE ${where}
      ORDER BY e.indexed_at DESC
      LIMIT ?${binds.length}`,
  ).bind(...binds).all<EmbeddingRow>()
  if (!results.length) return []
  const queryNorm = vectorNorm(queryVector)
  const scored = results.map((row) => ({
    row,
    score: cosineSimilarityPrecomputed(queryVector, queryNorm, decodeVector(row.vector), row.norm ?? undefined),
  }))
  scored.sort((a, b) =>
    b.score - a.score ||
    b.row.updated_at - a.row.updated_at ||
    a.row.id.localeCompare(b.row.id),
  )
  return scored.slice(0, SEMANTIC_TOP_K).map(({ row, score }) => ({
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    rev: row.rev,
    updatedAt: row.updated_at,
    score,
  }))
}

/**
 * Reciprocal-rank fusion: merges two ranked lists into one by rank, so a
 * note that ranks well in both lexical and semantic search surfaces above
 * one that only appears in a single index.
 */
export interface FusedHit<T> {
  item: T
  rrf: number
  sources: Set<'lexical' | 'semantic'>
}

export function fuseByRrf<T extends { id: string }>(
  lexical: readonly T[],
  semantic: readonly T[],
  k = RRF_K,
): FusedHit<T>[] {
  const combined = new Map<string, FusedHit<T>>()
  const push = (list: readonly T[], source: 'lexical' | 'semantic') => {
    for (let index = 0; index < list.length; index++) {
      const item = list[index]!
      const key = item.id
      const existing = combined.get(key)
      if (existing) {
        existing.rrf += 1 / (k + index + 1)
        existing.sources.add(source)
      } else {
        combined.set(key, { item, rrf: 1 / (k + index + 1), sources: new Set([source]) })
      }
    }
  }
  push(lexical, 'lexical')
  push(semantic, 'semantic')
  return [...combined.values()].sort((a, b) =>
    b.rrf - a.rrf ||
    b.sources.size - a.sources.size ||
    a.item.id.localeCompare(b.item.id),
  )
}

/** Calls the Workers AI embedding model for many texts in one round trip. */
export async function embedTexts(
  ai: NonNullable<Env['AI']>,
  texts: string[],
): Promise<Float32Array[]> {
  if (!texts.length) return []
  const result = await ai.run(AI_EMBEDDING_MODEL, { text: texts })
  return extractEmbeddings(result, texts.length)
}

/** Calls the Workers AI embedding model and returns a Float32Array. */
export async function embedText(ai: NonNullable<Env['AI']>, text: string): Promise<Float32Array> {
  const [vector] = await embedTexts(ai, [text])
  return vector!
}

const queryEmbedCache = new Map<string, { vector: Float32Array; expiresAt: number }>()
const QUERY_EMBED_TTL_MS = 600_000
const QUERY_EMBED_CACHE_MAX = 64

/** Query embeddings repeat constantly across MCP calls; cache per isolate. */
export async function embedQueryText(ai: NonNullable<Env['AI']>, text: string): Promise<Float32Array> {
  const hit = queryEmbedCache.get(text)
  if (hit && hit.expiresAt > Date.now()) return hit.vector
  const vector = await embedText(ai, text)
  if (queryEmbedCache.size >= QUERY_EMBED_CACHE_MAX) queryEmbedCache.clear()
  queryEmbedCache.set(text, { vector, expiresAt: Date.now() + QUERY_EMBED_TTL_MS })
  return vector
}

/** Handles both the `{ data: [{ embedding }] }` and `{ shape, data }` shapes. */
export function extractEmbedding(result: unknown): Float32Array {
  const data = (result as { data?: unknown } | null)?.data
  if (Array.isArray(data)) {
    const first = data[0] as { embedding?: unknown } | unknown[] | undefined
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const embedding = (first as { embedding?: unknown }).embedding
      if (Array.isArray(embedding)) return Float32Array.from(embedding as number[])
    } else if (Array.isArray(first)) {
      return Float32Array.from(first as number[])
    }
  }
  throw new Error('Unexpected embedding response shape')
}
export function extractEmbeddings(result: unknown, expected: number): Float32Array[] {
  const data = (result as { data?: unknown } | null)?.data
  if (Array.isArray(data) && data.length === expected) {
    return data.map((entry) => extractEmbedding({ data: [entry] }))
  }
  throw new Error('Unexpected embedding response shape')
}


export function encodeVector(vector: Float32Array): ArrayBuffer {
  return new Float32Array(vector).buffer
}

export function decodeVector(buffer: ArrayBuffer): Float32Array {
  const view = new Float32Array(buffer)
  return view.length === AI_EMBEDDING_DIMS ? view : view.slice(0, AI_EMBEDDING_DIMS)
}

export function vectorNorm(v: Float32Array): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    sum += v[i]! * v[i]!
  }
  return Math.sqrt(sum)
}

export function cosineSimilarityPrecomputed(
  a: Float32Array,
  normA: number,
  b: Float32Array,
  knownNormB?: number,
): number {
  if (normA === 0) return 0
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normBSquare = 0
  for (let index = 0; index < length; index++) {
    dot += a[index]! * b[index]!
    if (knownNormB === undefined) normBSquare += b[index]! * b[index]!
  }
  const denominator = normA * (knownNormB ?? Math.sqrt(normBSquare))
  return denominator === 0 ? 0 : dot / denominator
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const normA = vectorNorm(a)
  return cosineSimilarityPrecomputed(a, normA, b)
}

export function semanticSnippet(excerpt: string, radius = 90): string {
  const plain = toPlainText(excerpt).replace(/\s+/g, ' ').trim()
  if (!plain) return ''
  return truncateText(plain, radius * 2) + (plain.length > radius * 2 ? '…' : '')
}

function semanticWhere(userId: string, filters: SemanticFilters): { binds: unknown[]; where: string } {
  const binds: unknown[] = [userId]
  let where = `e.user_id = ?1 AND n.deleted_at IS NULL`
  if (filters.starred === true) where += ' AND n.is_starred = 1'
  if (filters.archived === true) where += ' AND n.is_archived = 1'
  else if (filters.archived === false) where += ' AND n.is_archived = 0'
  for (const tag of filters.tags ?? []) {
    binds.push(tag)
    where += ` AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id = n.id AND t.user_id = n.user_id
          AND t.name = ?${binds.length} COLLATE NOCASE)`
  }
  if (filters.folder) {
    binds.push(filters.folder)
    where += ` AND EXISTS (SELECT 1 FROM folders f WHERE f.id = n.folder_id
        AND f.name = ?${binds.length} COLLATE NOCASE AND f.user_id = n.user_id)`
  }
  return { binds, where }
}
