/**
 * Semantic recall for the assistant, on the deployment's own Workers AI stack.
 *
 * The reference project shipped its own embedding pipeline; this app already has one for notes
 * (`src/worker/mcp/ai-search.ts`), so the model name, the blob layout, the cosine helper and the
 * rank-fusion are imported from there rather than reimplemented — two encoders would silently stop
 * matching each other's vectors, and every recall would come back empty with no error to read.
 *
 * Both things the assistant recalls by meaning are here: memories, which this module embeds itself, and
 * notes, whose index belongs to the MCP module and is only read from here.
 *
 * A memory is embedded when it is written, which is rare and small: the whole set is a few dozen
 * rows, so ranking is a scan rather than an index. The daily cap is the reader's, counted in the same
 * table as the request cap.
 */
import { truncateText } from '@shared/text-utils'
import {
  AI_EMBEDDING_MODEL,
  cosineSimilarityPrecomputed,
  extractEmbeddings,
  decodeVector,
  encodeVector,
  fuseByRrf,
  getAiSearchStatus,
  searchSemanticNotes,
  SEMANTIC_SCORE_FLOOR,
  semanticSnippet,
  vectorNorm,
  type SemanticSearchHit,
} from '../mcp/ai-search'
import type { AssistantMemory, AssistantSettings } from '@shared/assistant'
import type { Env } from '../env'
import type { AssistantStore, MemoryScope } from './store'

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
 *
 * `absolute` is the note index's own bar rather than a second measurement of it, because a memory recall
 * and a note recall cannot be allowed to disagree about what "close enough to say so" means: two numbers
 * would decide the same question twice, and only one of them would get updated when the model changed.
 */
export const SEMANTIC_FLOOR = { absolute: SEMANTIC_SCORE_FLOOR, relative: 0.1, backstop: 0.4 }
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
  scope?: MemoryScope,
): Promise<AssistantMemory[]> {
  const ai = env.AI
  if (!ai) return []
  const [rows, queryVector] = await Promise.all([
    // Scoped at the read, not after it: a vector from another project must never be a candidate, or a
    // project's facts would surface in a thread that is not allowed to recall them.
    store.memoryEmbeddingsWithMemory(model, statuses, 500, scope),
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

// ------------------------------------------------------------------ notes

/** Why the meaning half of a note search was never attempted. */
export type NoteVectorSkip = 'no_ai_binding' | 'index_off' | 'cap_reached'

export interface NoteVectorGate {
  hybrid: boolean
  skip: NoteVectorSkip | null
}

/**
 * Whether this turn may ask the note index for matches by meaning, and why not if it may not.
 *
 * Read through the index's own status function rather than a second flag, because that is the answer the
 * settings page shows the reader: a turn that decided differently would argue with the screen beside it.
 * The cap is the one the memory index already spends from — `limits.maxEmbeddingsPerDay`, counted in the
 * same daily row — since a second budget for calls to the same model is a second number nobody can
 * reconcile from the usage screen.
 */
export async function noteVectorGate(
  store: AssistantStore,
  env: Env,
  settings: AssistantSettings,
): Promise<NoteVectorGate> {
  const status = await getAiSearchStatus(env.DB, env, store.userId)
  if (!status.available) return { hybrid: false, skip: 'no_ai_binding' }
  if (!status.enabled) return { hybrid: false, skip: 'index_off' }
  const cap = settings.limits.maxEmbeddingsPerDay
  if (cap <= 0) return { hybrid: false, skip: 'cap_reached' }
  if ((await store.todayUsage()).embeddings >= cap) return { hybrid: false, skip: 'cap_reached' }
  return { hybrid: true, skip: null }
}

export interface NoteVectorRecall {
  hits: SemanticSearchHit[]
  /** Why there is no meaning half after it *was* attempted; null when `hits` is the real answer. */
  failed: string | null
}

/**
 * The meaning half of a note search.
 *
 * `searchSemanticNotes` is the index's own reader — same encoder, same model, same scan window, and the
 * same `SEMANTIC_SCORE_FLOOR` applied before it answers, which is why there is no second filter here: a
 * chat page and an MCP `search` call cannot disagree about what "similar" means, and a bar kept in two
 * places is a bar that only moves in one of them. The reader's own `semanticModel` is deliberately not
 * passed in: the stored note vectors were written by the model the index was built with, and a query
 * encoded by a second one comes back as a confident zero for notes that have nothing to do with each other.
 *
 * A failure is handed back rather than absorbed, because the alternative is a keyword page that reads
 * like a complete answer. It is logged as well: the outage is the deployment's AI binding's problem, and
 * the log is the one place somebody can actually see it.
 */
export async function recallNotesByVector(
  store: AssistantStore,
  env: Env,
  query: string,
): Promise<NoteVectorRecall> {
  if (!env.AI) return { hits: [], failed: 'this deployment has no AI binding' }
  try {
    const hits = await searchSemanticNotes(env, env.DB, store.userId, query, {})
    // `null` is the index's own refusal — the binding vanished or the reader switched the index off
    // between the gate above and this read. Nothing was embedded, so nothing is charged, and the caller
    // is told the meaning half is absent rather than handed an empty list that reads as "no note matched".
    if (!hits) return { hits: [], failed: 'the reader\'s AI note index stopped answering mid-read' }
    // Counted only once the call answered: an outage that never embedded anything must not spend the
    // reader's day, or the index would stay unused until midnight for a fault that lasts a minute.
    await store.incrementUsage({ embeddings: 1 })
    // An empty list here is an answer rather than a gap in coverage: the index searched, and nothing of
    // the reader's cleared its bar. The refusal above is the only case that means "no meaning half".
    return { hits, failed: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn('[inkstone] assistant note vector search failed:', reason)
    return { hits: [], failed: truncateText(reason, 160) }
  }
}

export type NoteHitSource = 'keyword' | 'meaning' | 'both'

export interface KeywordNoteHit {
  id: string
  title: string
  snippet: string
}

export interface FusedNoteHit {
  id: string
  title: string
  excerpt: string
  source: NoteHitSource
}

/**
 * The two ranked lists merged into the page the model reads.
 *
 * Ranks, not scores: a lexical relevance number and a cosine are two different measurements of two
 * different things, and the only comparison between them that means anything is "which of your lists put
 * this one first". A note near the top of both beats one that only one index likes, and each hit keeps
 * saying where it came from, because "found by keyword" and "found by meaning" are different evidence for
 * the model to weigh and for the reader to be told.
 */
export function fuseNoteHits(
  keyword: readonly KeywordNoteHit[],
  meaning: readonly SemanticSearchHit[],
): FusedNoteHit[] {
  const byKeyword = new Map(keyword.map((hit) => [hit.id, hit]))
  const byMeaning = new Map(meaning.map((hit) => [hit.id, hit]))
  return fuseByRrf(keyword, meaning).map(({ item, sources }) => {
    const keywordHit = sources.has('lexical') ? byKeyword.get(item.id) : undefined
    const meaningHit = sources.has('semantic') ? byMeaning.get(item.id) : undefined
    return {
      id: item.id,
      title: item.title,
      // A keyword hit already carries the sentence that matched; a meaning hit only carries the note's
      // own opening, which is all the index stores.
      excerpt: keywordHit?.snippet ?? semanticSnippet(meaningHit?.excerpt ?? ''),
      source: keywordHit && meaningHit ? 'both' : meaningHit ? 'meaning' : 'keyword',
    }
  })
}
