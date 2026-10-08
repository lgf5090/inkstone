/**
 * The indexer: keeps the local index in step with the note store and the cache on disk.
 *
 * The client already holds every note summary and its `updatedAt`, so the diff that decides what to
 * re-read is computed here without asking the server for a list; the batch endpoint only ever
 * supplies bodies. Work is chunked between idle slots, because building an index for a few thousand
 * notes must not cost the reader a frame.
 */
import { useSyncExternalStore } from 'react'
import { extractAttachmentIds, extractWikiLinks, normalizeLinkKey } from '@shared/markdown-utils'
import { parseOmnisearchQuery, type ParsedOmnisearchQuery } from '@shared/omnisearch-query'
import { api } from '../../lib/api'
import { localDb } from '../../lib/db'
import { folderPathLabel } from '../../lib/folders'
import { preloadPinyin, pinyinIsLoaded } from '../../lib/pinyin'
import { useSession } from '../../store/session'
import { useNotes } from '../../store/notes'
import { buildFileDocument, buildNoteDocument, type FileSource, type NoteSource } from './document'
import { docIdForFile, docIdForNote, noteIdOfDoc, OmnisearchEngine } from './engine'
import { buildTokenizer } from './tokenizer'
import { foldTerm } from './fold'
import { eraseCache, OMNISEARCH_CACHE_VERSION, readCache, writeCache, type OmnisearchCacheRecord } from './cache'
import { bodyBudgetBytes, documentSettings, engineSettings, indexFingerprint } from './settings'
import type { OmnisearchResult, OmnisearchStoredFields } from './types'

export type IndexPhase = 'idle' | 'loading' | 'indexing' | 'writing' | 'done' | 'failed' | 'off'

export interface IndexerStatus {
  phase: IndexPhase
  /** Documents the index holds right now. */
  indexed: number
  /** Live notes the reader has, which may be more than the index can hold. */
  available: number
  /** Notes left out because of the `maxIndexedNotes` ceiling. */
  deferred: number
  /** Bytes of note bodies kept on the device for excerpts. */
  bodyBytes: number
  busy: boolean
  /** Indexing stopped on an error; what is already indexed still answers. */
  error: string | null
  /** The last cache write was refused, which is what the quota hint keys on. */
  cacheFailed: boolean
  ready: boolean
}

const FETCH_CHUNK = 20
const REFRESH_DELAY_MS = 900
const CACHE_WRITE_DELAY_MS = 4000
const IDLE_TIMEOUT_MS = 2000
const ATTACHMENT_PAGES_MAX = 20

const INITIAL_STATUS: IndexerStatus = {
  phase: 'idle',
  indexed: 0,
  available: 0,
  deferred: 0,
  bodyBytes: 0,
  busy: false,
  error: null,
  cacheFailed: false,
  ready: false,
}

const nextIdleSlot: () => Promise<void> = () => new Promise((resolve) => {
  if (typeof window === 'undefined') {
    resolve()
    return
  }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS })
    return
  }
  window.setTimeout(resolve, 0)
})

export class OmnisearchIndexer {
  private engine: OmnisearchEngine | null = null
  private status: IndexerStatus = { ...INITIAL_STATUS }
  private listeners = new Set<() => void>()
  private fingerprint = ''
  private bodyBytes = 0
  private refreshTimer = 0
  private cacheTimer = 0
  private chain: Promise<void> = Promise.resolve()
  private coalesced: Promise<void> | null = null
  private started = false
  private storeUnsubscribe: (() => void) | null = null
  private sessionUnsubscribe: (() => void) | null = null
  private fileSources: FileSource[] = []

  getStatus = (): IndexerStatus => this.status

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private patch(next: Partial<IndexerStatus>): void {
    this.status = { ...this.status, ...next }
    for (const listener of this.listeners) listener()
  }

  /** Called once the session is authed and the note store has hydrated. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const search = useSession.getState().settings.search
    if (!search.enabled) {
      this.patch({ phase: 'off', ready: false, busy: false })
      return
    }
    if (search.pinyinSearch && !pinyinIsLoaded()) await preloadPinyin()
    this.buildEngine()
    await this.loadFromCache()
    this.watchStores()
    await this.loadAttachments()
    await this.reconcile()
  }

  private buildEngine(): void {
    const search = useSession.getState().settings.search
    this.fingerprint = indexFingerprint(search)
    const tokenizer = buildTokenizer({
      splitCamelCase: search.splitCamelCase,
      cjkBigrams: search.cjkBigrams,
      pinyinSearch: search.pinyinSearch,
    }, (term) => foldTerm(term, search.ignoreDiacritics))
    this.engine = new OmnisearchEngine({
      tokenizer,
      settings: () => engineSettings(useSession.getState().settings.search),
      resolveBodies: async (docIds) => {
        const noteIds = docIds.map(noteIdOfDoc).filter(Boolean)
        if (!noteIds.length) return new Map()
        const found = await localDb.getOmnisearchBodies(noteIds)
        const out = new Map<string, string>()
        for (const [noteId, body] of found) out.set(docIdForNote(noteId), body)
        return out
      },
    })
    this.bodyBytes = 0
    this.patch({ ...INITIAL_STATUS, phase: this.status.phase === 'off' ? 'off' : 'idle' })
  }

  /**
   * A settings change that alters tokens throws the cache away rather than mixing vocabularies, which
   * is what the reference plugin asks the reader to do by hand with a "needs a restart" note.
   */
  async applySettingsChanged(): Promise<void> {
    const search = useSession.getState().settings.search
    if (!search.enabled) {
      await this.shutdown()
      return
    }
    const wasOff = this.status.phase === 'off'
    if (wasOff) {
      this.buildEngine()
      await this.loadFromCache()
      await this.loadAttachments()
      this.watchStores()
      await this.reconcile()
      return
    }
    if (indexFingerprint(search) === this.fingerprint) return
    const ids = this.engine ? [...this.engine.references.keys()].map(noteIdOfDoc).filter(Boolean) : []
    this.engine = null
    await eraseCache(ids)
    this.buildEngine()
    await this.loadAttachments()
    await this.reconcile()
  }

  private async shutdown(): Promise<void> {
    this.engine = null
    this.patch({ ...INITIAL_STATUS, phase: 'off' })
  }

  private async loadFromCache(): Promise<void> {
    const engine = this.engine
    if (!engine) return
    if (!useSession.getState().settings.search.useCache) return
    this.patch({ phase: 'loading' })
    const record = await readCache(this.fingerprint)
    if (!record) return
    if (!engine.restore(record.payload)) {
      await eraseCache()
      return
    }
    this.bodyBytes = record.bodyBytes
    this.patch({ bodyBytes: record.bodyBytes, indexed: engine.documentCount })
  }

  private watchStores(): void {
    if (!this.storeUnsubscribe) {
      let previousNotes = useNotes.getState().notes
      let previousContents = useNotes.getState().contents
      this.storeUnsubscribe = useNotes.subscribe((state) => {
        if (state.notes === previousNotes && state.contents === previousContents) return
        previousNotes = state.notes
        previousContents = state.contents
        this.scheduleRefresh()
      })
    }
    if (!this.sessionUnsubscribe) {
      let previous = useSession.getState().settings.search
      this.sessionUnsubscribe = useSession.subscribe((state) => {
        if (state.settings.search === previous) return
        previous = state.settings.search
        void this.applySettingsChanged()
      })
    }
  }

  private scheduleRefresh(): void {
    if (this.status.phase === 'off') return
    window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => void this.reconcile(), REFRESH_DELAY_MS)
  }

  /**
   * The notes the index will hold: live, newest first, cut at the reader's own ceiling. Archived notes
   * stay in, because hiding them is a ranking choice, not an indexing one.
   */
  private targets(): { revisions: Map<string, number>; deferred: number; total: number } {
    const notes = useNotes.getState().notes
    const limit = useSession.getState().settings.search.maxIndexedNotes
    const live: { id: string; updatedAt: number }[] = []
    for (const note of Object.values(notes)) {
      if (note.deletedAt) continue
      live.push({ id: note.id, updatedAt: note.updatedAt })
    }
    live.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    const chosen = live.slice(0, limit)
    const revisions = new Map<string, number>()
    for (const note of chosen) revisions.set(docIdForNote(note.id), note.updatedAt)
    for (const file of this.fileSources) revisions.set(docIdForFile(file.id), file.updatedAt)
    return { revisions, deferred: live.length - chosen.length, total: live.length }
  }

  /** Attachments are indexed by name only: there is no in-browser OCR for their contents. */
  private async loadAttachments(): Promise<void> {
    const out: FileSource[] = []
    let cursor: string | undefined
    for (let page = 0; page < ATTACHMENT_PAGES_MAX; page++) {
      try {
        const response = await api.files.list(cursor)
        for (const file of response.files) {
          out.push({
            id: file.id,
            filename: file.filename,
            noteId: file.noteId,
            updatedAt: file.createdAt,
            size: file.size,
            mime: file.mime,
          })
        }
        cursor = response.nextCursor ?? undefined
      } catch {
        cursor = undefined
        break
      }
      if (!cursor) break
    }
    this.fileSources = out
  }

  /** At most one run may be waiting; runs never overlap. */
  reconcile(): Promise<void> {
    if (!this.engine || this.status.phase === 'off') return Promise.resolve()
    if (this.coalesced) return this.coalesced
    this.coalesced = this.chain
      .then(() => this.runReconcile())
      .catch((error: unknown) => {
        this.patch({ error: error instanceof Error ? error.message : String(error), phase: 'failed', busy: false })
      })
      .finally(() => {
        this.coalesced = null
      })
    this.chain = this.coalesced
    return this.coalesced
  }

  private async runReconcile(): Promise<void> {
    const engine = this.engine
    if (!engine) return
    const notes = useNotes.getState().notes
    const folders = useNotes.getState().folders
    const search = useSession.getState().settings.search
    const { revisions, deferred, total } = this.targets()

    const { toAdd, toRemove } = engine.diff(revisions)
    this.patch({ available: total, deferred })

    if (toRemove.length) {
      const freed = toRemove.reduce((sum, id) => {
        const size = engine.storedFieldsOf(id)?.size ?? 0
        return sum + Math.min(size, search.maxContentChars)
      }, 0)
      engine.removeDocuments(toRemove)
      await localDb.dropOmnisearchBodies(toRemove.map(noteIdOfDoc).filter(Boolean))
      this.bodyBytes = Math.max(0, this.bodyBytes - freed)
    }

    if (toAdd.length) {
      this.patch({ phase: 'indexing', busy: true, error: null })
      const linkKeys = new Map<string, string>()
      for (const id of revisions.keys()) {
        const note = notes[noteIdOfDoc(id)]
        if (note) linkKeys.set(normalizeLinkKey(note.title), note.id)
      }
      // Attachments need no fetch: their names, sizes and owners are already in the list.
      const fileDocs = toAdd
        .filter((id) => !noteIdOfDoc(id))
        .map((id) => this.fileSources.find((file) => docIdForFile(file.id) === id))
        .filter((file): file is FileSource => Boolean(file))
      if (fileDocs.length) await engine.addDocuments(fileDocs.map((file) => buildFileDocument(file)))
      const noteIds = toAdd.map(noteIdOfDoc).filter(Boolean)
      for (let offset = 0; offset < noteIds.length; offset += FETCH_CHUNK) {
        if (this.engine !== engine) return
        await this.indexChunk(noteIds.slice(offset, offset + FETCH_CHUNK), linkKeys, folders, revisions)
        await nextIdleSlot()
      }
    }

    if (this.engine !== engine) return
    this.patch({
      phase: 'done',
      ready: true,
      busy: false,
      indexed: engine.documentCount,
      bodyBytes: this.bodyBytes,
    })
    if (toAdd.length || toRemove.length) this.scheduleCacheWrite()
  }

  /** The chunk is a slice of plain note ids; the document ids are built here, not passed in. */
  private async indexChunk(
    noteIds: string[],
    linkKeys: Map<string, string>,
    folders: ReturnType<typeof useNotes.getState>['folders'],
    revisions: Map<string, number>,
  ): Promise<void> {
    const engine = this.engine
    if (!engine) return
    const search = useSession.getState().settings.search
    const contents = useNotes.getState().contents
    const fetched = new Map<string, { content: string; chars: number }>()
    const needFetch = noteIds.filter((id) => contents[id] === undefined)
    if (needFetch.length) {
      const response = await api.searchDocuments(needFetch)
      for (const item of response.items) fetched.set(item.id, { content: item.content, chars: item.chars })
      // A note the server did not hand over — trashed mid-flight, or too big for this page — is
      // remembered at the revision we were asked for, so the next diff leaves it alone until it
      // actually changes. Without this the same chunk would be re-requested on every refresh.
      if (response.missing.length) {
        engine.markRevisions(response.missing.map((id) => [docIdForNote(id), revisions.get(docIdForNote(id)) ?? 0]))
      }
    }

    const entries = []
    const availability: boolean[] = []
    const embeddings: { docId: string; targets: string[] }[] = []
    const toStore: [string, string][] = []
    const toDrop: string[] = []
    const budget = bodyBudgetBytes(search)
    for (const noteId of noteIds) {
      const note = useNotes.getState().notes[noteId]
      if (!note) continue
      const body = contents[noteId] ?? fetched.get(noteId)?.content
      if (body === undefined) continue
      const source: NoteSource = {
        id: note.id,
        title: note.title,
        content: body,
        updatedAt: note.updatedAt,
        folderPath: note.folderId ? folderPathLabel(folders, note.folderId) : '',
        archived: note.isArchived,
        starred: note.isStarred,
      }
      const built = buildNoteDocument(source, documentSettings(search))
      const docId = built.doc.id
      const targets = new Set<string>()
      for (const link of extractWikiLinks(body)) {
        const target = linkKeys.get(link.key)
        if (target && docIdForNote(target) !== docId) targets.add(docIdForNote(target))
      }
      for (const fileId of extractAttachmentIds(body)) {
        if (revisions.has(docIdForFile(fileId))) targets.add(docIdForFile(fileId))
      }
      embeddings.push({ docId, targets: [...targets] })
      entries.push(built)
      const fits = this.bodyBytes + body.length <= budget
      availability.push(fits)
      if (fits) {
        toStore.push([noteId, body])
        this.bodyBytes += body.length
      } else {
        toDrop.push(noteId)
      }
    }

    if (toStore.length) await localDb.setOmnisearchBodies(toStore)
    if (toDrop.length) await localDb.dropOmnisearchBodies(toDrop)
    if (entries.length) await engine.addDocuments(entries, availability)
    for (const embedding of embeddings) engine.setEmbeddings(embedding.docId, embedding.targets)
  }

  private scheduleCacheWrite(): void {
    window.clearTimeout(this.cacheTimer)
    if (!useSession.getState().settings.search.useCache) return
    this.cacheTimer = window.setTimeout(() => void this.writeCache(), CACHE_WRITE_DELAY_MS)
  }

  private async writeCache(): Promise<void> {
    const engine = this.engine
    if (!engine || !useSession.getState().settings.search.useCache) return
    this.patch({ phase: 'writing' })
    await nextIdleSlot()
    if (this.engine !== engine) return
    const record: OmnisearchCacheRecord = {
      version: OMNISEARCH_CACHE_VERSION,
      fingerprint: this.fingerprint,
      savedAt: Date.now(),
      bodyBytes: this.bodyBytes,
      payload: engine.toJSON(),
    }
    const ok = await writeCache(record)
    this.patch({ phase: 'done', cacheFailed: !ok, indexed: engine.documentCount, bodyBytes: this.bodyBytes })
  }

  /**
   * Parse and search. The reference re-indexed on window blur, so a reader could type a query and get
   * yesterday's index; here a refresh is awaited when one is already in flight, and typing has already
   * queued one through the store subscription.
   */
  async query(raw: string, options: { singleDocId?: string } = {}): Promise<{
    query: ParsedOmnisearchQuery
    results: OmnisearchResult[]
  }> {
    const search = useSession.getState().settings.search
    const query = parseOmnisearchQuery(raw, (value) => foldTerm(value, search.ignoreDiacritics))
    if (!this.engine || !search.enabled) return { query, results: [] }
    return { query, results: await this.engine.search(query, options) }
  }

  /** Force a full rebuild, the way the reference's danger-zone button does it without a restart. */
  async rebuild(): Promise<void> {
    const ids = this.engine ? [...this.engine.references.keys()].map(noteIdOfDoc).filter(Boolean) : []
    this.engine = null
    await eraseCache(ids)
    this.buildEngine()
    await this.loadAttachments()
    await this.reconcile()
  }

  storedFieldsOf(docId: string): OmnisearchStoredFields | null {
    return this.engine?.storedFieldsOf(docId) ?? null
  }

  has(docId: string): boolean {
    return this.engine?.has(docId) ?? false
  }

  embedsOf(docId: string): string[] {
    return this.engine?.embedsOf(docId) ?? []
  }

  inFileMatches(body: string, terms: readonly string[]): ReturnType<OmnisearchEngine['inFileMatches']> {
    return this.engine?.inFileMatches(body, terms) ?? []
  }

  resolveBody(docId: string): Promise<string | null> {
    const noteId = noteIdOfDoc(docId)
    if (!noteId) return Promise.resolve(null)
    const live = useNotes.getState().contents[noteId]
    if (live !== undefined) return Promise.resolve(live)
    return localDb.getOmnisearchBodies([noteId]).then((found) => found.get(noteId) ?? null)
  }

  dispose(): void {
    window.clearTimeout(this.refreshTimer)
    window.clearTimeout(this.cacheTimer)
    this.storeUnsubscribe?.()
    this.sessionUnsubscribe?.()
    this.storeUnsubscribe = null
    this.sessionUnsubscribe = null
    this.listeners.clear()
    this.engine = null
    this.coalesced = null
    this.chain = Promise.resolve()
    this.started = false
    this.fileSources = []
    this.status = { ...INITIAL_STATUS }
  }
}

export const omnisearchIndexer = new OmnisearchIndexer()

/** React binding for the progress line and the settings panel. */
export function useOmnisearchStatus(): IndexerStatus {
  return useSyncExternalStore(omnisearchIndexer.subscribe, omnisearchIndexer.getStatus, omnisearchIndexer.getStatus)
}

