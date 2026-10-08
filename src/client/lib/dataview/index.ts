/**
 * The page index a Dataview block queries.
 *
 * Inkstone's note store already holds every note's title, folder, tags, timestamps and counters, and
 * the server derives those tags and links from the note's content on every write. Dataview's own
 * indexer assumes a desktop vault where every file is on disk and cheap to parse, so this index does
 * the opposite: it answers everything a summary can answer — folders, tags, starred, dates, names —
 * without reading a single body, and pulls bodies only for the notes a query can actually show.
 * `FROM #book WHERE rating > 3` therefore costs one list scan plus the bodies of the book notes.
 *
 * A body comes from whichever of three places has it first: the editor's in-memory copy (the only place
 * a *typed* edit exists), the search index's body cache on disk, then the batched note endpoint. That
 * endpoint is throttled per account, so work is chunked and remembered per revision: a note the backend
 * declined to hand over is recorded at the revision we asked about and is not re-requested on every
 * refresh.
 */

import { normalizeLinkKey } from '@shared/markdown-utils'
import type { Source } from './ast'
import { DvLink, type DataObject } from './value'
import { parseNote, pathOfNote, serializePage, extractSubtags, type PageMetadata } from './metadata'
import { stripTime } from './expression'
import type { DataRail } from './engine'

/** The per-note facts the store already keeps, plus its body when one is loaded. */
export interface IndexNote {
    id: string
    title: string
    folder: string
    tags: readonly string[]
    createdAt: number
    updatedAt: number
    rev: number
    charCount: number
    wordCount: number
    starred: boolean
    pinned: boolean
    archived: boolean
    content?: string
}

export interface IndexAdapter {
    /** A snapshot of the live notes, as cheap as possible — called on every store change. */
    notes(): IndexNote[]
    /** Bodies for the given ids, from cache or network. Ids the backend will not supply are absent. */
    loadContent(ids: readonly string[]): Promise<Map<string, string>>
    /** Note ids that link *to* the given note, without reading anybody's body. */
    incomingLinks(noteId: string): Promise<string[]>
}

export type IndexPhase = 'empty' | 'loading' | 'ready' | 'limited'

export interface IndexStatus {
    phase: IndexPhase
    /** Pages whose body is parsed and available to a query. */
    parsed: number
    /** Live notes the reader has, parsed or not. */
    total: number
    /** The last load hit the per-query body ceiling, so a list may be short on purpose. */
    truncated: boolean
}

interface CachedPage {
    page: PageMetadata
    /** Everything a re-parse would notice: the note moved, was renamed, or was edited. */
    stamp: string
}

/** One query's candidate ids, split by why they are still incomplete. */
export interface CandidateSet {
    ids: Set<string>
    /** Bodies that could change *which* notes match, not merely what a row shows. */
    needBodies: Set<string>
}

const DEFAULT_BODY_LIMIT = 500

export class DataviewIndex {
    private pages = new Map<string, CachedPage>()
    /** Lower-cased `Folder/Title.md` and title keys, built from summaries so links resolve early. */
    private byPath = new Map<string, string>()
    private byLinkKey = new Map<string, string>()
    /** Notes the backend would not hand over, remembered at the revision we asked about. */
    private declined = new Map<string, number>()
    private incoming = new Map<string, string[]>()
    private listeners = new Set<() => void>()
    private snapshot: IndexNote[] = []
    private byId = new Map<string, IndexNote>()
    private status: IndexStatus = { phase: 'empty', parsed: 0, total: 0, truncated: false }
    private notifyTimer: ReturnType<typeof setTimeout> | null = null
    private version = 0

    constructor(
        private readonly adapter: IndexAdapter,
        private readonly bodyLimit: number = DEFAULT_BODY_LIMIT,
    ) {}

    get currentVersion(): number {
        return this.version
    }

    getStatus(): IndexStatus {
        return this.status
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    /**
     * Fold the store's latest snapshot in. Synchronous and cheap: a note is re-parsed only when its
     * revision, timestamp, title or folder moved, so typing costs one parse.
     */
    sync(): void {
        const notes = this.adapter.notes()
        this.snapshot = notes
        this.byId = new Map(notes.map((note) => [note.id, note]))
        for (const id of [...this.pages.keys()]) {
            if (!this.byId.has(id)) this.pages.delete(id)
        }
        this.rebuildKeys()
        for (const note of notes) {
            const cached = this.pages.get(note.id)
            if (note.content === undefined) {
                // A note that moved, was renamed or was edited elsewhere has a page that now says the
                // wrong thing. Without the body it cannot be re-parsed, so the stale answer is dropped:
                // the row disappears and the next `rails()` lists it as owing a read.
                if (cached && cached.stamp !== stampOf(note)) this.pages.delete(note.id)
                continue
            }
            if (cached && cached.stamp === stampOf(note)) continue
            this.parse(note, note.content)
        }
        this.declined = new Map([...this.declined].filter(([id, rev]) => {
            const note = this.byId.get(id)
            return note !== undefined && note.rev === rev
        }))
        this.incoming.clear()
        this.publish({
            phase: this.pages.size ? 'ready' : 'empty',
            parsed: this.pages.size,
            total: notes.length,
            truncated: false,
        })
    }

    /** Index a note from a body the caller already holds — an editor commit, or a fetch. */
    ingest(note: IndexNote, content: string): void {
        this.byId.set(note.id, note)
        if (!this.snapshot.some((item) => item.id === note.id)) this.snapshot = [...this.snapshot, note]
        this.parse(note, content)
        this.rebuildKeys()
        this.publish({ ...this.status, parsed: this.pages.size, total: this.snapshot.length, phase: 'ready' })
    }

    private parse(note: IndexNote, content: string): void {
        const page = parseNote({
            id: note.id,
            title: note.title,
            content,
            folder: note.folder,
            tags: note.tags,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt,
            charCount: note.charCount,
            wordCount: note.wordCount,
            starred: note.starred,
            pinned: note.pinned,
            archived: note.archived,
        })
        this.pages.set(note.id, { page, stamp: stampOf(note) })
    }

    /**
     * Link and path keys come from the summary (title + folder), which is what lets `FROM [[X]]` answer
     * before X's body has been read. Aliases only exist in the body, so they are layered on top for the
     * pages already parsed.
     */
    private rebuildKeys(): void {
        this.byPath.clear()
        this.byLinkKey.clear()
        for (const note of this.snapshot) {
            const path = pathOfNote(note)
            this.byPath.set(path.toLocaleLowerCase(), note.id)
            this.byLinkKey.set(normalizeLinkKey(note.title), note.id)
            this.byLinkKey.set(normalizeLinkKey(note.folder ? `${note.folder}/${note.title}` : note.title), note.id)
        }
        for (const [id, cached] of this.pages) {
            for (const alias of cached.page.aliases) {
                if (!this.byLinkKey.has(normalizeLinkKey(alias))) this.byLinkKey.set(normalizeLinkKey(alias), id)
            }
        }
    }

    pageOf(noteId: string): PageMetadata | undefined {
        return this.pages.get(noteId)?.page
    }

    summaryOf(noteId: string): IndexNote | undefined {
        return this.byId.get(noteId)
    }

    allNoteIds(): string[] {
        return [...this.pages.keys()]
    }

    /**
     * Every note the reader has, parsed or not, with the parsed ones first: a `dataviewjs` block gets the
     * whole vault within its window rather than only what happened to be read, and a page that is still
     * summary-only is worth less than one whose fields are known.
     */
    universeIds(): string[] {
        const parsed: string[] = []
        const rest: string[] = []
        for (const note of this.snapshot) (this.pages.has(note.id) ? parsed : rest).push(note.id)
        return [...parsed, ...rest]
    }

    /** Resolve a link target to a note id: bare title first, then the folder-qualified path. */
    noteIdForLink(target: string): string | undefined {
        const plain = stripExtension(target.trim())
        if (!plain) return undefined
        return this.byLinkKey.get(normalizeLinkKey(plain))
            ?? this.byPath.get(plain.toLocaleLowerCase())
            ?? this.byLinkKey.get(normalizeLinkKey(plain.slice(plain.lastIndexOf('/') + 1)))
    }

    noteIdForPath(path: string): string | undefined {
        // The exact path first, because two notes may share a title in different folders and only the
        // path says which one a result stood for; the link lookup is the fallback for a partial spelling.
        return this.byPath.get(path.trim().toLocaleLowerCase()) ?? this.noteIdForLink(path)
    }

    /** Which notes a source yields, and which bodies could still change that answer. */
    candidates(source: Source): CandidateSet {
        return this.resolve(source)
    }

    private universe(): Set<string> {
        return new Set(this.snapshot.map((note) => note.id))
    }

    private resolve(source: Source): CandidateSet {
        switch (source.type) {
            case 'empty':
                return { ids: new Set(), needBodies: new Set() }
            case 'folder':
                return this.fromSummary((note) => (source.folder === '' ? true : matchesFolder(pathOfNote(note), source.folder)))
            case 'tag': {
                const wanted = source.tag.toLocaleLowerCase()
                // The server writes note_tags from the note's own content, so a tag written in prose is
                // already in the summary. The parsed page is consulted only as a cross-check for a note
                // edited since the last sync.
                return this.fromSummary((note) => {
                    if (note.tags.some((tag) => tagMatches(tag, wanted))) return true
                    const page = this.pages.get(note.id)?.page
                    return page !== undefined && [...page.tags].some((tag) => tagMatches(tag, wanted))
                })
            }
            case 'csv': {
                // This app has no attachment files, so a `csv(...)` source names a note, written either as
                // its full path, as that path without the `.md` every note path carries, or with the `.md`
                // spelled out.
                const wanted = source.path.trim().toLocaleLowerCase()
                return this.fromSummary((note) => {
                    const path = pathOfNote(note).toLocaleLowerCase()
                    return path === wanted || path === `${wanted}.md` || stripExtension(path) === wanted
                })
            }
            case 'link':
                return this.resolveLink(source.file, source.direction)
            case 'negate': {
                const child = this.resolve(source.child)
                if (!child.needBodies.size) {
                    const ids = this.universe()
                    for (const id of child.ids) ids.delete(id)
                    return { ids, needBodies: new Set() }
                }
                // A child whose answer may still grow cannot be subtracted yet: every note is then a
                // candidate until those bodies arrive, because any of them could leave the child.
                return { ids: this.universe(), needBodies: child.needBodies }
            }
            case 'binaryop': {
                const left = this.resolve(source.left)
                const right = this.resolve(source.right)
                const needBodies = new Set([...left.needBodies, ...right.needBodies])
                if (source.op === '|') return { ids: new Set([...left.ids, ...right.ids]), needBodies }
                const ids = new Set<string>()
                for (const id of left.ids) {
                    if (right.ids.has(id) || right.needBodies.has(id)) ids.add(id)
                }
                for (const id of right.ids) {
                    if (left.ids.has(id) || left.needBodies.has(id)) ids.add(id)
                }
                return { ids, needBodies }
            }
            default:
                return { ids: new Set(), needBodies: new Set() }
        }
    }

    /**
     * A filter the summary can answer exactly: no body is needed to decide membership, only to render
     * the row — and rendering is `rails()`'s business, not this set's.
     */
    private fromSummary(predicate: (note: IndexNote) => boolean): CandidateSet {
        const ids = new Set<string>()
        for (const note of this.snapshot) {
            if (predicate(note)) ids.add(note.id)
        }
        return { ids, needBodies: new Set() }
    }

    private resolveLink(target: string, direction: 'incoming' | 'outgoing'): CandidateSet {
        const id = this.noteIdForLink(target)
        if (!id) {
            // An unresolved name still has a spelling: only a body says whether it links there, so every
            // unparsed note is a candidate and the parsed ones are answered exactly.
            const key = normalizeLinkKey(stripExtension(target))
            const ids = new Set<string>()
            const needBodies = new Set<string>()
            for (const note of this.snapshot) {
                const page = this.pages.get(note.id)?.page
                if (page) {
                    if (page.links.some((link) => normalizeLinkKey(stripExtension(link.path)) === key)) ids.add(note.id)
                    continue
                }
                ids.add(note.id)
                needBodies.add(note.id)
            }
            return { ids, needBodies }
        }
        if (direction === 'outgoing') {
            const page = this.pages.get(id)?.page
            if (!page) return { ids: new Set(), needBodies: new Set([id]) }
            const ids = new Set<string>()
            for (const link of page.links) {
                const found = this.noteIdForLink(link.path)
                if (found) ids.add(found)
            }
            return { ids, needBodies: new Set() }
        }
        const known = this.incoming.get(id)
        if (known) return { ids: new Set(known), needBodies: new Set() }
        // The server's link table knows this without anybody's body; `linksPending` says so, and
        // `resolveRails` awaits it before it asks for a single note body.
        return { ids: new Set(), needBodies: new Set() }
    }

    /** True when answering this source still owes a backlink round-trip. */
    linksPending(source: Source): boolean {
        return this.pendingLinks(source).length > 0
    }

    /** The link targets whose incoming set this source still waits on. */
    pendingLinks(source: Source): string[] {
        const wanted: string[] = []
        for (const node of leaves(source)) {
            if (node.type !== 'link' || node.direction !== 'incoming') continue
            const id = this.noteIdForLink(node.file)
            if (id && !this.incoming.has(id) && !wanted.includes(node.file)) wanted.push(node.file)
        }
        return wanted
    }

    /** Warm the incoming-link set for one target; the answer lives until the next sync. */
    async prepareLinks(target: string): Promise<void> {
        const id = this.noteIdForLink(target)
        if (!id || this.incoming.has(id)) return
        this.incoming.set(id, await this.adapter.incomingLinks(id))
    }

    /**
     * Read the bodies a query is missing, bounded by `bodyLimit`. Returns whether the ceiling clipped
     * the request, which the block reports rather than hiding.
     */
    async load(ids: readonly string[]): Promise<boolean> {
        const wanted = ids.filter((id) => !this.pages.has(id) && !this.declined.has(id) && this.byId.has(id))
        if (!wanted.length) return false
        const capped = wanted.slice(0, this.bodyLimit)
        const truncated = wanted.length > capped.length
        this.publish({ ...this.status, phase: 'loading' })
        const bodies = await this.adapter.loadContent(capped)
        for (const id of capped) {
            const note = this.byId.get(id)
            if (!note) continue
            const content = bodies.get(id)
            if (content === undefined) {
                this.declined.set(id, note.rev)
                continue
            }
            this.parse(note, content)
        }
        this.publish({
            phase: truncated ? 'limited' : 'ready',
            parsed: this.pages.size,
            total: this.snapshot.length,
            truncated,
        })
        return truncated
    }

    /**
     * The rows a source yields over whatever is indexed right now, plus the ids that still need a body
     * before they can be shown at all.
     */
    rails(source: Source): { rails: DataRail[]; needBodies: string[]; pending: boolean } {
        const { ids, needBodies } = this.resolve(source)
        const rails: DataRail[] = []
        const missing: string[] = [...needBodies]
        for (const id of ids) {
            const data = this.serialize(id)
            const page = this.pages.get(id)?.page
            if (!data || !page) {
                if (!missing.includes(id)) missing.push(id)
                continue
            }
            rails.push({ id: DvLink.file(page.path), data })
        }
        rails.sort((one, other) => (one.id as DvLink).path.localeCompare((other.id as DvLink).path))
        return { rails, needBodies: missing, pending: missing.length > 0 || this.linksPending(source) }
    }

    /** A note's query-facing object, with its incoming links resolved against the index. */
    serialize(noteId: string): DataObject | null {
        const cached = this.pages.get(noteId)
        if (!cached) return null
        const key = normalizeLinkKey(cached.page.name)
        const inlinks: DvLink[] = []
        for (const [id, other] of this.pages) {
            if (id === noteId) continue
            const pointsHere = other.page.links.some((link) => {
                const found = this.noteIdForLink(link.path)
                return found === noteId || (found === undefined && normalizeLinkKey(stripExtension(link.path)) === key)
            })
            if (pointsHere) inlinks.push(DvLink.file(other.page.path))
        }
        inlinks.sort((one, other) => one.path.localeCompare(other.path))
        return serializePage(cached.page, inlinks)
    }

    /**
     * A note's page as far as the summary knows it, for the one reader that has to cover the whole vault
     * without waiting on bodies: a `dataviewjs` snapshot. Identity, folder, tags, dates and counts are the
     * real ones; what only a body can say — fields, lists, links — is the empty version of itself, and the
     * block re-runs as those pages arrive.
     */
    summaryPage(noteId: string): DataObject | null {
        const note = this.byId.get(noteId)
        if (!note) return null
        if (this.pages.has(noteId)) return this.serialize(noteId)
        const path = pathOfNote(note)
        return {
            file: {
                path,
                name: note.title,
                folder: note.folder,
                link: DvLink.file(path),
                outlinks: [],
                inlinks: [],
                etags: [...note.tags],
                tags: [...new Set(note.tags.flatMap((tag) => extractSubtags(tag)))],
                aliases: [],
                lists: [],
                tasks: [],
                ctime: new Date(note.createdAt),
                cday: stripTime(new Date(note.createdAt)),
                mtime: new Date(note.updatedAt),
                mday: stripTime(new Date(note.updatedAt)),
                size: note.charCount,
                starred: note.starred,
                pinned: note.pinned,
                archived: note.archived,
                wordCount: note.wordCount,
                frontmatter: {},
                ext: 'md',
            },
        }
    }

    /** The `this` object for a block: the note it lives in, or null before that note has a body. */
    currentData(originId: string | null): DataObject | null {
        if (!originId) return null
        return this.serialize(originId)
    }

    /**
     * Resolve a source to rows, loading bodies and backlinks until the answer stops growing. Bounded by
     * design: at most four rounds, and at most `bodyLimit` bodies per round.
     */
    async resolveRails(source: Source): Promise<{ rails: DataRail[]; truncated: boolean }> {
        let rounds = 0
        let truncated = false
        for (;;) {
            if (this.linksPending(source)) {
                for (const node of leaves(source)) {
                    if (node.type === 'link' && node.direction === 'incoming') await this.prepareLinks(node.file)
                }
            }
            const seen = this.rails(source)
            if (!seen.needBodies.length || rounds >= 4) {
                truncated = this.status.truncated
                return { rails: seen.rails, truncated }
            }
            truncated = (await this.load(seen.needBodies)) || truncated
            rounds += 1
        }
    }

    private publish(status: IndexStatus): void {
        this.status = status
        this.version += 1
        if (this.notifyTimer !== null) return
        this.notifyTimer = setTimeout(() => {
            this.notifyTimer = null
            for (const listener of this.listeners) listener()
        }, 60)
    }

    /** Deliver pending notifications now, which is what a test asserts right after a load. */
    flush(): void {
        if (this.notifyTimer !== null) {
            clearTimeout(this.notifyTimer)
            this.notifyTimer = null
        }
        for (const listener of this.listeners) listener()
    }
}

function stampOf(note: IndexNote): string {
    return `${note.rev}|${note.updatedAt}|${note.title}|${note.folder}|${note.tags.join(',')}|${note.starred ? 1 : 0}|${note.archived ? 1 : 0}`
}

/** Every leaf of a source tree, in written order. */
export function leaves(source: Source): Source[] {
    switch (source.type) {
        case 'binaryop':
            return [...leaves(source.left), ...leaves(source.right)]
        case 'negate':
            return leaves(source.child)
        default:
            return [source]
    }
}

/** A folder source matches the folder, everything under it, and a note named after it. */
function matchesFolder(path: string, wanted: string): boolean {
    if (!wanted) return true
    const lower = stripExtension(path).toLocaleLowerCase()
    const key = stripExtension(wanted).toLocaleLowerCase()
    return lower === key || lower.startsWith(`${key}/`)
}

/** `#project` matches a note tagged `#project/active`, which is how a reader expects tags to nest. */
function tagMatches(tag: string, wanted: string): boolean {
    const lower = tag.toLocaleLowerCase()
    const key = lower.startsWith('#') ? lower : `#${lower}`
    return key === wanted || key.startsWith(`${wanted}/`)
}

function stripExtension(path: string): string {
    return path.replace(/\.md$/i, '')
}
