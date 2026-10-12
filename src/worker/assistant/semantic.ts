/**
 * Semantic recall for memories, on the deployment's own Workers AI stack.
 *
 * The reference project shipped its own embedding pipeline; this app already has one for notes
 * (`src/worker/mcp/ai-search.ts`), so the model name, the blob layout, the cosine helper and the
 * rank-fusion are imported from there rather than reimplemented — two encoders would silently stop
 * matching each other's vectors, and every recall would come back empty with no error to read.
 *
 * A memory is embedded when it is written, which is rare and small: the whole set is a few dozen
 * rows, so ranking is a scan rather than an index. The daily cap is the reader's, counted in the same
 * table as the request cap.
 */
import {
  AI_EMBEDDING_MODEL,
  cosineSimilarityPrecomputed,
  extractEmbeddings,
  decodeVector,
  encodeVector,
  fuseByRrf,
  vectorNorm,
} from '../mcp/ai-search'
import type { AssistantMemory } from '@shared/assistant'
import type { Env } from '../env'
import type { AssistantStore } from './store'

export interface MemoryEmbeddingStatus {
  available: boolean
  model: string
  vectors: number
  pending: number
  today: number
  cap: number
}

export function semanticAvailable(env: Env): boolean {
  return Boolean(env.AI)
}

/** The model a reader has not chosen one for, which is the one the notebook's own index uses. */
export function semanticModel(settings: { semanticModel?: string } | null | undefined): string {
  return settings?.semanticModel?.trim() || AI_EMBEDDING_MODEL
}

/**
 * Embeds with the reader's chosen model.
 *
 * `embedQueryText` is not used here: its cache is keyed by the text alone, so one isolate serving two
 * encoders would hand a memory vector back for the other model's query. The notes index keeps its own
 * path and its own cache.
 */
export async function embedWithModel(ai: NonNullable<Env['AI']>, model: string, text: string): Promise<Float32Array> {
  const [vector] = await extractEmbeddings(await ai.run(model, { text: [text] }), 1)
  return vector!
}

/** Embeds one memory. False means the deployment has no AI binding or the reader's cap is spent. */
export async function embedMemory(
  store: AssistantStore,
  env: Env,
  memory: Pick<AssistantMemory, 'id' | 'content'>,
  cap: number,
  model = AI_EMBEDDING_MODEL,
): Promise<boolean> {
  const ai = env.AI
  if (!ai || cap <= 0) return false
  const today = await store.todayUsage()
  if (today.embeddings >= cap) return false
  const vector = await embedWithModel(ai, model, memory.content)
  await store.upsertMemoryEmbedding(memory.id, model, encodeVector(vector), vectorNorm(vector))
  await store.incrementUsage({ embeddings: 1 })
  return true
}

export async function memoryEmbeddingStatus(
  store: AssistantStore,
  env: Env,
  cap: number,
  model = AI_EMBEDDING_MODEL,
): Promise<MemoryEmbeddingStatus> {
  const [vectors, pending, today] = await Promise.all([
    store.memoryEmbeddingCount(),
    store.memoriesWithoutEmbedding(model).then((rows) => rows.length),
    store.todayUsage(),
  ])
  return {
    available: semanticAvailable(env),
    model,
    vectors,
    pending,
    today: today.embeddings,
    cap,
  }
}

/** Embed everything that has no vector yet, stopping at the reader's daily cap. */
export async function reindexMemoryEmbeddings(
  store: AssistantStore,
  env: Env,
  cap: number,
  model = AI_EMBEDDING_MODEL,
): Promise<{ embedded: number, capped: boolean }> {
  const pending = await store.memoriesWithoutEmbedding(model)
  let embedded = 0
  for (const memory of pending) {
    if (!await embedMemory(store, env, memory, cap, model)) return { embedded, capped: true }
    embedded++
  }
  return { embedded, capped: false }
}

/**
 * What counts as a relevant vector, measured on bge-m3: the best hit has to clear `absolute`, and only
 * hits within `relative` of it are kept with it. When fewer than `fallbackCount` clear that bar, the
 * best remaining ones up to `backstop` fill in, so a genuinely relevant memory is never lost to a
 * slightly lower score — while a query with nothing to match ("what is the capital of France?" tops out
 * near 0.38) still returns nothing.
 */
export const SEMANTIC_FLOOR = { absolute: 0.55, relative: 0.1, backstop: 0.4 }
export const SEMANTIC_FALLBACK_COUNT = 4

export interface ScoredMemory {
  id: string
  score: number
  updatedAt: number
}

/**
 * The floor rule as a plain function: cosine first, then the newer memory, then the lower id, so two
 * runs over the same rows agree. A top hit below `absolute` means the strict list stays empty and every
 * slot comes from the `backstop` fill.
 */
export function selectVectorHits(
  scored: readonly ScoredMemory[],
  floor = SEMANTIC_FLOOR,
  fallbackCount = SEMANTIC_FALLBACK_COUNT,
): ScoredMemory[] {
  const all = [...scored].sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt || compareIds(left.id, right.id))
  const top = all[0]
  const kept = top && top.score >= floor.absolute
    ? all.filter((entry) => entry.score >= floor.absolute && entry.score >= top.score - floor.relative)
    : []
  if (kept.length >= fallbackCount) return kept.slice(0, fallbackCount)
  const taken = new Set(kept.map((entry) => entry.id))
  for (const entry of all) {
    if (kept.length >= fallbackCount || entry.score < floor.backstop) break
    if (!taken.has(entry.id)) kept.push(entry)
  }
  return kept.slice(0, fallbackCount)
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * D1 hands a BLOB back as an ArrayBuffer in workerd and as a view into a larger buffer in tests, and
 * `new Float32Array(aUint8Array)` reads its *values* rather than its bytes — so the buffer is cut out
 * by offset and length before the shared decoder sees it.
 */
function decodeStored(raw: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = raw instanceof ArrayBuffer ? raw : raw.slice(raw.byteOffset, raw.byteOffset + raw.byteLength).buffer
  return decodeVector(bytes as ArrayBuffer)
}

/** Memories ordered by cosine similarity to the query, or empty when nothing can be embedded. */
export async function rankMemoriesByVector(
  store: AssistantStore,
  env: Env,
  query: string,
  statuses: readonly string[],
  limit: number,
  model = AI_EMBEDDING_MODEL,
): Promise<AssistantMemory[]> {
  const ai = env.AI
  if (!ai) return []
  const [rows, queryVector] = await Promise.all([
    store.memoryEmbeddingsWithMemory(model, statuses),
    embedWithModel(ai, model, query),
  ])
  if (!rows.length) return []
  const queryNorm = vectorNorm(queryVector)
  const scored = rows
    // A stored vector from another encoder size is never scored: it would only produce a confident
    // number for a meaningless comparison.
    .filter((row) => decodeStored(row.vector).length === queryVector.length)
    .map((row) => ({
      memory: row.memory,
      entry: {
        id: row.memory.id,
        score: cosineSimilarityPrecomputed(queryVector, queryNorm, decodeStored(row.vector), row.norm ?? undefined),
        updatedAt: row.memory.updatedAt,
      },
    }))
  const byId = new Map(scored.map((row) => [row.entry.id, row.memory]))
  return selectVectorHits(scored.map((row) => row.entry), SEMANTIC_FLOOR, Math.max(limit, SEMANTIC_FALLBACK_COUNT))
    .slice(0, limit)
    .map((entry) => byId.get(entry.id)!)
    .filter((memory) => memory !== undefined)
}

/**
 * Reciprocal-rank fusion of the word-overlap list and the vector list.
 *
 * Two different scores are not comparable, so the ranks are: a memory either list puts near the top
 * surfaces, and one both lists like wins outright.
 */
export function fuseMemoryRecall(
  lexical: readonly AssistantMemory[],
  semantic: readonly AssistantMemory[],
  limit: number,
): AssistantMemory[] {
  return fuseByRrf(lexical, semantic).slice(0, limit).map((hit) => hit.item)
}
