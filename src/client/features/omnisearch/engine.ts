/**
 * The local index: a MiniSearch instance plus the ranking rules the reference plugin is known for.
 *
 * Four decisions differ from the reference on purpose. Hard filters run before the list is cut, so a
 * quoted phrase cannot silently eat the slots; every score rule multiplies once, so a folder that
 * matches both as a prefix and as a path segment is not demoted twice; the recency window is the
 * cutoff the reader picked, not a curve that decays over three years; and embeds are de-duplicated
 * against the results they would otherwise repeat.
 */
import MiniSearch, { type Options as IndexOptions, type SearchResult } from 'minisearch'
import { isOmnisearchQueryEmpty, type ParsedOmnisearchQuery } from '@shared/omnisearch-query'
import { tagKey } from '@shared/markdown-utils'
import { foldTerm } from './fold'
import { buildExcerpt, findMatches, prioritizePhrase } from './excerpt'
import type { BuiltDocument } from './document'
import type { OmnisearchResult, OmnisearchStoredFields } from './types'
import { OMNISEARCH_DOC_ID_PREFIX } from './types'
import type { buildTokenizer } from './tokenizer'

export type Tokenizer = ReturnType<typeof buildTokenizer>

export const OMNISEARCH_INDEXED_FIELDS = [
  'title',
  'displayTitle',
  'basename',
  'aliases',
  'path',
  'folder',
  'headings1',
  'headings2',
  'headings3',
  'tags',
  'customValues',
  'body',
] as const

export const OMNISEARCH_STORED_FIELDS = [
  'kind',
  'title',
  'displayTitle',
  'path',
  'folder',
  'ext',
  'updatedAt',
  'archived',
  'starred',
  'noteId',
  'tags',
  'customValues',
  'excerpt',
  'truncated',
  'size',
] as const

export const RECENCY_CUTOFF_DAYS = { day: 1, week: 7, month: 30 } as const

const TITLE_PREFIX_BOOST = 8
const NAMED_TAG_BOOST = 4
const DOWNRANK_DIVISOR = 4
const EMBED_SCORE_DIVISOR = 10
const DAY_MS = 86_400_000

export interface ResolvedEngineSettings {
  weights: {
    title: number
    folder: number
    headings1: number
    headings2: number
    headings3: number
    tags: number
  }
  customPropertyWeights: { name: string; weight: number }[]
  recency: { enabled: boolean; cutoff: 'disabled' | 'day' | 'week' | 'month' }
  fuzziness: '0' | '1' | '2'
  simpleSearch: boolean
  ignoreDiacritics: boolean
  hideArchived: boolean
  downrankedFolders: string[]
  maxResults: number
  maxEmbeds: number
  showExcerpt: boolean
  keepLineReturns: boolean
  plainExcerpt: boolean
}

interface IndexRecord extends OmnisearchStoredFields {
  id: string
  basename: string
  aliases: string
  headings1: string
  headings2: string
  headings3: string
  customValues: string[]
  body: string
}

interface ScoredResult {
  id: string
  score: number
  terms: string[]
  doc: OmnisearchStoredFields
}

export interface EngineDeps {
  tokenizer: Tokenizer
  settings: () => ResolvedEngineSettings
  /** Bodies come from the local cache, never the network, so a search stays instant. */
  resolveBodies: (ids: string[]) => Promise<Map<string, string>>
  now?: () => number
}

export interface CachePayload {
  index: string
  refs: [string, number][]
  hasBody: [string, boolean][]
  embeds: [string, string[]][]
}

function carriesTag(carried: readonly string[], wanted: string): boolean {
  const prefix = `${wanted}/`
  return carried.some((tag) => tag === wanted || tag.startsWith(prefix))
}

function pathInFolder(path: string, folder: string): boolean {
  const needle = folder.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!needle) return false
  return path === needle || path.startsWith(`${needle}/`)
}

export class OmnisearchEngine {
  private minisearch: MiniSearch<IndexRecord>
  private refs = new Map<string, number>()
  /** document id -> the notes that embed it */
  private embeds = new Map<string, Set<string>>()
  /** note document id -> the documents it embeds, kept so a removal is not a full scan */
  private embeddedBy = new Map<string, Set<string>>()
  private hasBody = new Map<string, boolean>()

  constructor(private deps: EngineDeps) {
    this.minisearch = new MiniSearch<IndexRecord>(this.indexOptions())
  }

  private indexOptions(): IndexOptions<IndexRecord> {
    return {
      fields: [...OMNISEARCH_INDEXED_FIELDS],
      storeFields: [...OMNISEARCH_STORED_FIELDS],
      idField: 'id',
      tokenize: (text) => this.deps.tokenizer.tokenizeForIndex(text),
      processTerm: (term) => foldTerm(term, this.deps.settings().ignoreDiacritics),
      logger: () => {},
    }
  }

  get documentCount(): number {
    return this.minisearch.documentCount
  }

  get references(): ReadonlyMap<string, number> {
    return this.refs
  }

  hasBodyFor(id: string): boolean {
    return this.hasBody.get(id) ?? false
  }

  has(id: string): boolean {
    return this.minisearch.has(id)
  }

  storedFieldsOf(id: string): OmnisearchStoredFields | null {
    if (!this.minisearch.has(id)) return null
    return (this.minisearch.getStoredFields(id) as OmnisearchStoredFields | undefined) ?? null
  }

  /**
   * A document is re-indexed when its revision moved, and dropped when it left the note list. The
   * reference compares mtimes the same way but keeps a second map of what to remove, which let a
   * modified file appear in both lists and be discarded after being added.
   */
  diff(revisions: ReadonlyMap<string, number>): { toAdd: string[]; toRemove: string[] } {
    const toAdd: string[] = []
    for (const [id, revision] of revisions) {
      if (this.refs.get(id) !== revision) toAdd.push(id)
    }
    const toRemove: string[] = []
    for (const id of this.refs.keys()) {
      if (!revisions.has(id)) toRemove.push(id)
    }
    return { toAdd, toRemove }
  }

  /**
   * Remember the revision of a document that could not be read, so the next diff leaves it alone
   * until it really changes. Without this a note that is too big for one page, or was trashed
   * mid-flight, would be re-requested on every refresh.
   */
  markRevisions(entries: [string, number][]): void {
    for (const [id, revision] of entries) {
      if (this.minisearch.has(id)) continue
      this.refs.set(id, revision)
    }
  }

  async addDocuments(entries: BuiltDocument[], bodyAvailability: boolean[] = []): Promise<void> {
    if (!entries.length) return
    const records: IndexRecord[] = entries.map((entry) => ({
      ...entry.stored,
      id: entry.doc.id,
      basename: entry.doc.basename,
      aliases: entry.doc.aliases,
      headings1: entry.doc.headings1,
      headings2: entry.doc.headings2,
      headings3: entry.doc.headings3,
      customValues: entry.customValues,
      body: entry.body,
    }))
    for (const record of records) {
      this.refs.set(record.id, record.updatedAt)
      this.forgetEmbeddingsOf(record.id)
    }
    const repeated = records.map((record) => record.id).filter((id) => this.minisearch.has(id))
    if (repeated.length) this.minisearch.discardAll(repeated)
    await this.minisearch.addAllAsync(records)
    records.forEach((record, index) => {
      this.hasBody.set(record.id, bodyAvailability[index] ?? true)
    })
  }

  removeDocuments(ids: readonly string[]): void {
    if (!ids.length) return
    const present = ids.filter((id) => this.minisearch.has(id))
    if (present.length) this.minisearch.discardAll(present)
    for (const id of ids) {
      this.refs.delete(id)
      this.hasBody.delete(id)
      this.forgetEmbeddingsOf(id)
      this.embeds.delete(id)
      for (const referencing of this.embeds.values()) referencing.delete(id)
    }
  }

  setEmbeddings(noteDocId: string, embedded: readonly string[]): void {
    this.forgetEmbeddingsOf(noteDocId)
    const next = new Set(embedded.filter((id) => id !== noteDocId))
    if (!next.size) return
    this.embeddedBy.set(noteDocId, next)
    for (const target of next) {
      const referencing = this.embeds.get(target) ?? new Set<string>()
      referencing.add(noteDocId)
      this.embeds.set(target, referencing)
    }
  }

  private forgetEmbeddingsOf(noteDocId: string): void {
    const previous = this.embeddedBy.get(noteDocId)
    if (!previous) return
    for (const target of previous) this.embeds.get(target)?.delete(noteDocId)
    this.embeddedBy.delete(noteDocId)
  }

  embedsOf(docId: string): string[] {
    const referencing = this.embeds.get(docId)
    return referencing ? [...referencing] : []
  }

  toJSON(): CachePayload {
    return {
      index: JSON.stringify(this.minisearch.toJSON()),
      refs: [...this.refs.entries()],
      hasBody: [...this.hasBody.entries()],
      embeds: [...this.embeds.entries()].map(([target, referencing]) => [target, [...referencing]]),
    }
  }

  restore(payload: CachePayload): boolean {
    try {
      this.minisearch = MiniSearch.loadJSON<IndexRecord>(payload.index, this.indexOptions())
    } catch {
      return false
    }
    this.refs = new Map()
    for (const [id, revision] of payload.refs) {
      if (this.minisearch.has(id)) this.refs.set(id, revision)
    }
    this.hasBody = new Map(payload.hasBody.filter(([id]) => this.refs.has(id)))
    this.embeds = new Map()
    this.embeddedBy = new Map()
    for (const [target, referencing] of payload.embeds) {
      if (!this.refs.has(target)) continue
      for (const ref of referencing) {
        if (!this.refs.has(ref)) continue
        const set = this.embeds.get(target) ?? new Set<string>()
        set.add(ref)
        this.embeds.set(target, set)
        const forward = this.embeddedBy.get(ref) ?? new Set<string>()
        forward.add(target)
        this.embeddedBy.set(ref, forward)
      }
    }
    return true
  }

  clear(): void {
    this.minisearch = new MiniSearch<IndexRecord>(this.indexOptions())
    this.refs = new Map()
    this.embeds = new Map()
    this.embeddedBy = new Map()
    this.hasBody = new Map()
  }

  async search(query: ParsedOmnisearchQuery, options: { singleDocId?: string } = {}): Promise<OmnisearchResult[]> {
    const settings = this.deps.settings()
    const now = this.deps.now?.() ?? Date.now()
    const terms = [...query.terms, ...query.exact]
    const namedTags = query.boostedTags.map(tagKey)
    if (isOmnisearchQueryEmpty(query)) return []
    let candidates: ScoredResult[]

    if (terms.length) {
      const groups = this.deps.tokenizer.tokenizeForSearch(terms.join(' '))
      candidates = groups.queries.length
        ? this.runSearch(groups, now).map((result) => toScored(result))
        : []
      // The index answers with text matches only; every qualifier has to be applied on top of it,
      // or a note that fails the filter still shows up because its body happens to contain the word.
      candidates = candidates.filter((candidate) => this.passesFilters(candidate.doc, query))
    } else {
      candidates = this.browseByQualifiers(query)
    }

    if (options.singleDocId) {
      candidates = candidates.filter((candidate) => candidate.id === options.singleDocId)
    }
    if (!candidates.length) return []

    const bodies = await this.loadBodies(candidates.map((candidate) => candidate.id))
    if (query.excludeTerms.length) {
      candidates = candidates.filter((candidate) => {
        const haystack = foldTerm(bodies.get(candidate.id) ?? '', settings.ignoreDiacritics)
        return !query.excludeTerms.some((term) => haystack.includes(term))
      })
    }
    if (query.exact.length) {
      candidates = candidates.filter((candidate) => {
        const stored = candidate.doc
        const haystack = foldTerm(
          `${bodies.get(candidate.id) ?? ''} ${stored.title} ${stored.displayTitle}`,
          settings.ignoreDiacritics,
        )
        return query.exact.every((phrase) => haystack.includes(phrase))
      })
    }
    if (!candidates.length) return []

    const ranked = candidates
      .map((candidate) => ({ ...candidate, score: this.adjustScore(candidate, query, namedTags) }))
      .sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, settings.maxResults))

    const mapped = ranked.map((candidate) => this.toResult(candidate, bodies, terms, namedTags, query))
    return this.injectEmbeds(mapped)
  }

  private runSearch(
    groups: ReturnType<Tokenizer['tokenizeForSearch']>,
    now: number,
  ): SearchResult[] {
    const settings = this.deps.settings()
    const fuzziness = settings.fuzziness === '0' ? 0 : settings.fuzziness === '1' ? 0.1 : 0.2
    const prefixLength = settings.simpleSearch ? 3 : 1
    return this.minisearch.search(groups, {
      tokenize: (text) => [text],
      prefix: (term: string) => term.length >= prefixLength,
      fuzzy: (term: string) => (term.length <= 3 ? 0 : term.length <= 5 ? fuzziness / 2 : fuzziness),
      boost: this.boosts(),
      boostDocument: (_id, _term, storedFields) => {
        const updatedAt = typeof storedFields?.updatedAt === 'number' ? storedFields.updatedAt : 0
        return recencyFactor(updatedAt, now, settings.recency)
      },
    })
  }

  /** A qualifier-only query has no terms to look up, so the stored fields answer directly. */
  private browseByQualifiers(query: ParsedOmnisearchQuery): ScoredResult[] {
    const out: ScoredResult[] = []
    for (const id of this.refs.keys()) {
      const doc = this.storedFieldsOf(id)
      if (!doc || !this.passesFilters(doc, query)) continue
      out.push({ id, score: 0, terms: [], doc })
    }
    return out
  }

  private boosts(): Record<string, number> {
    const { weights } = this.deps.settings()
    return {
      title: weights.title,
      displayTitle: weights.title,
      basename: weights.title,
      aliases: weights.title,
      path: weights.folder,
      folder: weights.folder,
      headings1: weights.headings1,
      headings2: weights.headings2,
      headings3: weights.headings3,
      tags: weights.tags,
      customValues: 1,
      body: 1,
    }
  }

  private passesFilters(doc: OmnisearchStoredFields, query: ParsedOmnisearchQuery): boolean {
    const settings = this.deps.settings()
    if (query.trash) return false
    if (settings.hideArchived && doc.archived) return false
    if (query.starred !== null && doc.starred !== query.starred) return false
    if (query.archived !== null && doc.archived !== query.archived) return false
    if (query.ext.length && !query.ext.includes(doc.ext)) return false
    if (query.excludeExt.includes(doc.ext)) return false
    const haystack = foldTerm(doc.path, settings.ignoreDiacritics)
    if (query.path.length && !query.path.some((needle) => haystack.includes(needle))) return false
    if (query.excludePath.some((needle) => haystack.includes(needle))) return false
    if (query.folder) {
      const folder = foldTerm(query.folder, settings.ignoreDiacritics)
      if (!foldTerm(doc.folder, settings.ignoreDiacritics).includes(folder)) return false
    }
    for (const tag of query.tags) {
      if (!carriesTag(doc.tags, tagKey(tag))) return false
    }
    for (const tag of query.excludeTags) {
      if (carriesTag(doc.tags, tagKey(tag))) return false
    }
    // `#tag` is a boost, not a filter, as long as the query also has words to search. With nothing but
    // the tag it has to filter, or browsing by `#mood` would return the whole vault.
    if (!query.terms.length && !query.exact.length && query.boostedTags.length) {
      if (!query.boostedTags.some((tag) => carriesTag(doc.tags, tagKey(tag)))) return false
    }
    return true
  }

  private adjustScore(candidate: ScoredResult, query: ParsedOmnisearchQuery, namedTags: string[]): number {
    const settings = this.deps.settings()
    const { doc } = candidate
    let score = candidate.score
    const phrase = query.text || query.exact[0] || ''
    if (phrase) {
      const title = foldTerm(doc.displayTitle || doc.title, settings.ignoreDiacritics)
      if (title.startsWith(foldTerm(phrase, settings.ignoreDiacritics))) score *= TITLE_PREFIX_BOOST
    }
    for (const tag of namedTags) {
      if (carriesTag(doc.tags, tag)) {
        score *= NAMED_TAG_BOOST
        break
      }
    }
    for (const rule of settings.customPropertyWeights) {
      if (!rule.name || !Number.isFinite(rule.weight) || rule.weight <= 0) continue
      // The reference called `.includes()` on the raw front matter value, so a numeric property threw
      // and took the whole search with it. Values are strings by the time they get here.
      const hit = doc.customValues.some((value) => {
        const folded = foldTerm(value, settings.ignoreDiacritics)
        return query.terms.some((term) => folded.includes(term))
      })
      if (hit) {
        score *= rule.weight
        break
      }
    }
    for (const folder of settings.downrankedFolders) {
      if (pathInFolder(doc.folder, folder) || pathInFolder(doc.path, folder)) {
        score /= DOWNRANK_DIVISOR
        break
      }
    }
    return score
  }

  private async loadBodies(ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map()
    try {
      return await this.deps.resolveBodies([...new Set(ids)])
    } catch {
      return new Map()
    }
  }

  private toResult(
    candidate: ScoredResult,
    bodies: Map<string, string>,
    terms: string[],
    namedTags: string[],
    query: ParsedOmnisearchQuery,
  ): OmnisearchResult {
    const settings = this.deps.settings()
    const body = bodies.get(candidate.id) ?? ''
    const found = [...new Set([...candidate.terms, ...terms, ...namedTags])]
    const matches = prioritizePhrase(
      findMatches(body, found, { ignoreDiacritics: settings.ignoreDiacritics }),
      body,
      query.text || query.exact[0] || '',
      settings.ignoreDiacritics,
    )
    const excerpt = settings.showExcerpt && body
      ? buildExcerpt(body, matches[0]?.offset ?? -1, {
        ignoreDiacritics: settings.ignoreDiacritics,
        keepLineReturns: settings.keepLineReturns,
        plainText: settings.plainExcerpt,
        terms: found,
      })
      : { lines: [], leading: false, trailing: false }
    return {
      id: candidate.id,
      doc: candidate.doc,
      score: candidate.score,
      terms: found,
      matches,
      isEmbed: false,
      excerpt,
      matchCount: matches.length,
    }
  }

  private injectEmbeds(results: OmnisearchResult[]): OmnisearchResult[] {
    const limit = this.deps.settings().maxEmbeds
    if (limit <= 0) return results
    const seen = new Set(results.map((result) => result.id))
    const out: OmnisearchResult[] = []
    for (const result of results) {
      out.push(result)
      let taken = 0
      for (const id of this.embedsOf(result.id)) {
        if (taken >= limit) break
        if (seen.has(id)) continue
        const doc = this.storedFieldsOf(id)
        if (!doc) continue
        seen.add(id)
        taken++
        out.push({
          id,
          doc,
          score: result.score / EMBED_SCORE_DIVISOR,
          terms: result.terms,
          matches: [],
          isEmbed: true,
          excerpt: doc.excerpt
            ? { lines: [{ text: doc.excerpt, hits: [] }], leading: false, trailing: false }
            : { lines: [], leading: false, trailing: false },
          matchCount: 0,
        })
      }
    }
    return out
  }

  /** In-file search needs the body's own match list, which the index cannot give precisely. */
  inFileMatches(body: string, terms: readonly string[]): ReturnType<typeof findMatches> {
    return findMatches(body, terms, { ignoreDiacritics: this.deps.settings().ignoreDiacritics })
  }
}

/**
 * MiniSearch spreads the stored fields onto the result itself, so the row a reader sees has to be
 * lifted back out of it. The engine's own keys (terms, match, score) are not part of the document.
 */
function toScored(result: SearchResult): ScoredResult {
  const record = result as unknown as Record<string, unknown>
  const doc: Record<string, unknown> = {}
  for (const key of OMNISEARCH_STORED_FIELDS) {
    if (key in record) doc[key] = record[key]
  }
  return {
    id: String(result.id),
    score: result.score,
    terms: result.terms ?? [],
    doc: doc as unknown as OmnisearchStoredFields,
  }
}

/**
 * The reference boosted by `1 + exp(cutoff * days / 1000)`, which decays over roughly three years, so
 * its "24 hours" and "30 days" options behaved alike. Here the window *is* the cutoff: a note touched
 * inside it scores up to twice, and the lift is gone when the window passes.
 */
export function recencyFactor(updatedAt: number, now: number, rule: ResolvedEngineSettings['recency']): number {
  if (!rule.enabled || rule.cutoff === 'disabled') return 1
  const days = RECENCY_CUTOFF_DAYS[rule.cutoff]
  const elapsed = Math.max(0, now - updatedAt) / DAY_MS
  if (elapsed >= days) return 1
  return 1 + (1 - elapsed / days)
}

export function docIdForNote(noteId: string): string {
  return `${OMNISEARCH_DOC_ID_PREFIX.note}${noteId}`
}

export function docIdForFile(fileId: string): string {
  return `${OMNISEARCH_DOC_ID_PREFIX.file}${fileId}`
}

export function noteIdOfDoc(docId: string): string {
  return docId.startsWith(OMNISEARCH_DOC_ID_PREFIX.note)
    ? docId.slice(OMNISEARCH_DOC_ID_PREFIX.note.length)
    : ''
}

export function fileIdOfDoc(docId: string): string {
  return docId.startsWith(OMNISEARCH_DOC_ID_PREFIX.file)
    ? docId.slice(OMNISEARCH_DOC_ID_PREFIX.file.length)
    : ''
}
