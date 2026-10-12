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
  decodeVector,
  embedQueryText,
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

/** Embeds one memory. False means the deployment has no AI binding or the reader's cap is spent. */
export async function embedMemory(
  store: AssistantStore,
  env: Env,
  memory: Pick<AssistantMemory, 'id' | 'content'>,
  cap: number,
): Promise<boolean> {
  const ai = env.AI
  if (!ai || cap <= 0) return false
  const today = await store.todayUsage()
  if (today.embeddings >= cap) return false
  const vector = await embedQueryText(ai, memory.content)
  await store.upsertMemoryEmbedding(memory.id, AI_EMBEDDING_MODEL, encodeVector(vector), vectorNorm(vector))
  await store.incrementUsage({ embeddings: 1 })
  return true
}

export async function memoryEmbeddingStatus(
  store: AssistantStore,
  env: Env,
  cap: number,
): Promise<MemoryEmbeddingStatus> {
  const [vectors, pending, today] = await Promise.all([
    store.memoryEmbeddingCount(),
    store.memoriesWithoutEmbedding(AI_EMBEDDING_MODEL).then((rows) => rows.length),
    store.todayUsage(),
  ])
  return {
    available: semanticAvailable(env),
    model: AI_EMBEDDING_MODEL,
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
): Promise<{ embedded: number, capped: boolean }> {
  const pending = await store.memoriesWithoutEmbedding(AI_EMBEDDING_MODEL)
  let embedded = 0
  for (const memory of pending) {
    if (!await embedMemory(store, env, memory, cap)) return { embedded, capped: true }
    embedded++
  }
  return { embedded, capped: false }
}

/** Below this the vector is noise; the lexical list still decides on its own. */
export const SEMANTIC_MIN_SCORE = 0.2

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
): Promise<AssistantMemory[]> {
  const ai = env.AI
  if (!ai) return []
  const [rows, queryVector] = await Promise.all([
    store.memoryEmbeddingsWithMemory(AI_EMBEDDING_MODEL, statuses),
    embedQueryText(ai, query),
  ])
  if (!rows.length) return []
  const queryNorm = vectorNorm(queryVector)
  return rows
    .map((row) => ({
      memory: row.memory,
      score: cosineSimilarityPrecomputed(queryVector, queryNorm, decodeStored(row.vector), row.norm ?? undefined),
    }))
    .filter((entry) => entry.score > SEMANTIC_MIN_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.memory)
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
