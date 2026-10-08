/**
 * The Dataview service: the index, wired to this app's note store and its three body sources.
 *
 * A note's summary is already in memory for every note the reader has, so the snapshot is built from
 * it and no request is made until a query actually needs a body. Bodies then come from the editor's
 * copy first (the only place an uncommitted edit exists), the search index's on-disk bodies second, and
 * the batched note endpoint last — in chunks of forty, which is what that endpoint will hand over in
 * one call, and with the response's own `missing` list remembered so a note the backend will not
 * supply is not asked for again on every keystroke.
 *
 * The store's tag list is written by the server from the note's own content, so a `FROM #tag` clause is
 * answered from the summary alone.
 */

import { api } from '../api'
import { localDb } from '../db'
import { folderPath } from '../../lib/folders'
import { useSession } from '../../store/session'
import { useNotes } from '../../store/notes'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { DataviewSettings, NoteSummary, UserSettings } from '@shared/types'
import { DataviewIndex, type IndexNote } from './index'
import { DEFAULT_QUERY_SETTINGS, type QueryRuntimeSettings } from './functions'

/** The batch endpoint caps one request at this many ids. */
const CHUNK = 40

function summaryToIndex(note: NoteSummary, folders: Parameters<typeof folderPath>[0], body: string | undefined): IndexNote {
    return {
        id: note.id,
        title: note.title,
        folder: folderPath(folders, note.folderId).map((folder) => folder.name).join('/'),
        tags: note.tags,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        rev: note.rev,
        charCount: note.charCount,
        wordCount: note.wordCount,
        starred: note.isStarred,
        pinned: note.isPinned,
        archived: note.isArchived,
        content: body,
    }
}

function settingsOf(): DataviewSettings {
    return useSession.getState().settings?.dataview ?? DEFAULT_SETTINGS.dataview
}

export function dataviewSettings(): DataviewSettings {
    return settingsOf()
}

/** The renderer-facing view of the settings, in the shape the value model expects. */
export function querySettings(): QueryRuntimeSettings {
    const settings = settingsOf()
    return {
        renderNullAs: settings.renderNullAs || DEFAULT_QUERY_SETTINGS.renderNullAs,
        dateFormat: settings.dateFormat,
        datetimeFormat: settings.datetimeFormat,
        durationFormat: settings.durationFormat,
        locale: useSession.getState().settings?.appearance.language ?? 'en-US',
    }
}

async function loadContent(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const missing: string[] = []
    const contents = useNotes.getState().contents
    for (const id of ids) {
        const live = contents[id]
        if (live !== undefined) out.set(id, live)
        else missing.push(id)
    }
    if (!missing.length) return out

    const cached = await localDb.getOmnisearchBodies(missing)
    const rest: string[] = []
    for (const id of missing) {
        const body = cached.get(id)
        if (body !== undefined) out.set(id, body)
        else rest.push(id)
    }
    if (!rest.length) return out

    for (let offset = 0; offset < rest.length; offset += CHUNK) {
        const chunk = rest.slice(offset, offset + CHUNK)
        const response = await api.searchDocuments(chunk)
        for (const item of response.items) out.set(item.id, item.content)
    }
    return out
}

async function incomingLinks(noteId: string): Promise<string[]> {
    const response = await api.notes.backlinks(noteId)
    const ids = new Set<string>()
    for (const link of [...response.backlinks, ...response.unlinked]) ids.add(link.id)
    ids.delete(noteId)
    return [...ids]
}

function snapshot(): IndexNote[] {
    const state = useNotes.getState()
    const settings = settingsOf()
    const folders = state.folders
    const out: IndexNote[] = []
    for (const note of Object.values(state.notes)) {
        if (note.isArchived && !settings.includeArchived) continue
        out.push(summaryToIndex(note, folders, state.contents[note.id]))
    }
    return out
}

/** The one index the app queries. Tests build their own `DataviewIndex` over a fake adapter. */
export const dataviewIndex = new DataviewIndex(
    {
        notes: snapshot,
        loadContent,
        incomingLinks,
    },
    settingsOf().bodyLimit,
)

let started = false
let syncTimer: ReturnType<typeof setTimeout> | null = null
let storeUnsubscribe: (() => void) | null = null
let sessionUnsubscribe: (() => void) | null = null

/**
 * Start feeding the index from the stores. Kept lazy and shared: a note without a `dataview` block
 * never causes a sync, because the first block to render is what starts this.
 */
export function startDataview(): void {
    if (started || typeof window === 'undefined') return
    started = true
    const schedule = () => {
        if (syncTimer !== null) clearTimeout(syncTimer)
        syncTimer = setTimeout(() => {
            syncTimer = null
            dataviewIndex.sync()
        }, 120)
    }
    storeUnsubscribe = useNotes.subscribe(schedule)
    sessionUnsubscribe = useSession.subscribe(schedule)
    dataviewIndex.sync()
}

export function stopDataview(): void {
    if (!started) return
    started = false
    if (syncTimer !== null) clearTimeout(syncTimer)
    syncTimer = null
    storeUnsubscribe?.()
    sessionUnsubscribe?.()
    storeUnsubscribe = null
    sessionUnsubscribe = null
}

/** Fold one note's newest content in immediately, so a saved edit refreshes blocks without a debounce. */
export function touchNote(noteId: string): void {
    const state = useNotes.getState()
    const note = state.notes[noteId]
    if (!note) return
    const body = state.contents[noteId]
    if (body === undefined) {
        dataviewIndex.sync()
        return
    }
    dataviewIndex.ingest(summaryToIndex(note, state.folders, body), body)
}

export function useDataviewSettings(): UserSettings['dataview'] {
    return useSession((state) => state.settings?.dataview ?? DEFAULT_SETTINGS.dataview)
}
