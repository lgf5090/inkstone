/**
 * What changed between two libraries, in rows.
 *
 * The account used to be written as one blob: a device that starred an article sent every
 * subscription and every mark it knew about, and whatever a second device had marked in the
 * meantime was gone. A change set names only what moved, so two devices reading the same library
 * add to it instead of replacing each other.
 *
 * The diff is computed against what the sender last handed over rather than against what the server
 * holds, which is what keeps a retry after a refused write from losing the first attempt: the next
 * change set is still measured from the last one that landed, so it carries both.
 */
import { RSS_MARK_KINDS, splitSavedNoteKey, type RssMarkKey, type RssMarkKind, type RssMarkRow } from './marks'
import { RSS_LIMITS, type RssFeed, type RssGroup, type RssLibrary } from './model'

export interface RssTagKey {
  feedId: string
  tag: string
}

export interface RssPatch {
  feeds: { upsert: RssFeed[], remove: string[] }
  groups: { upsert: RssGroup[], remove: string[] }
  tags: { upsert: RssTagKey[], remove: RssTagKey[] }
  marks: { upsert: RssMarkRow[], remove: RssMarkKey[] }
  state: { lastChannel: string } | null
}

/** The four lists, and the library field each one lives in. */
const LISTS: [RssMarkKind, 'readIds' | 'favorites' | 'readLater' | 'hiddenIds'][] = [
  ['read', 'readIds'],
  ['star', 'favorites'],
  ['later', 'readLater'],
  ['hidden', 'hiddenIds'],
]

function markKey(kind: string, entryId: string): string {
  return `${kind}\u0000${entryId}`
}

function tagKey(feedId: string, tag: string): string {
  return `${feedId}\u0000${tag}`
}

/** The library as mark rows. A list row's stamp is left at zero: its position is its order. */
function markRowsOf(library: RssLibrary): RssMarkRow[] {
  const rows: RssMarkRow[] = []
  for (const [kind, field] of LISTS) {
    for (const entryId of library[field]) rows.push({ kind, entryId, value: '', at: 0 })
  }
  for (const [entryId, at] of Object.entries(library.opened)) rows.push({ kind: 'opened', entryId, value: '', at })
  for (const [key, noteId] of Object.entries(library.savedNotes)) {
    const mark = splitSavedNoteKey(key)
    if (mark) rows.push({ kind: mark.kind, entryId: mark.entryId, value: noteId, at: 0 })
  }
  return rows
}

function tagKeysOf(feeds: readonly RssFeed[]): Set<string> {
  const out = new Set<string>()
  for (const feed of feeds) for (const tag of feed.tags) out.add(tagKey(feed.id, tag))
  return out
}

function splitTagKey(key: string): RssTagKey {
  const cut = key.indexOf('\u0000')
  return { feedId: key.slice(0, cut), tag: key.slice(cut + 1) }
}

/**
 * The rows that turn `from` into `to`.
 *
 * `now` stamps a mark that is new to this sender. A list mark's stamp is what orders the list on the
 * way back — newest first — so a clock is passed in rather than read: a test has to be able to name
 * the stamp it expects, and two devices seconds apart must not land in each other's sequence.
 */
export function diffLibrary(from: RssLibrary | null, to: RssLibrary, now: () => number = Date.now): RssPatch {
  const patch: RssPatch = {
    feeds: { upsert: [], remove: [] },
    groups: { upsert: [], remove: [] },
    tags: { upsert: [], remove: [] },
    marks: { upsert: [], remove: [] },
    state: null,
  }
  const previous = from ?? { ...to, feeds: [], groups: [] }

  const oldFeeds = new Map(previous.feeds.map(feed => [feed.id, feed]))
  const seenFeeds = new Set<string>()
  for (const feed of to.feeds) {
    seenFeeds.add(feed.id)
    const was = oldFeeds.get(feed.id)
    if (!was || JSON.stringify(was) !== JSON.stringify(feed)) patch.feeds.upsert.push(feed)
  }
  for (const feed of previous.feeds) {
    if (!seenFeeds.has(feed.id)) patch.feeds.remove.push(feed.id)
  }

  const oldGroups = new Map(previous.groups.map(group => [group.id, group]))
  const seenGroups = new Set<string>()
  for (const group of to.groups) {
    seenGroups.add(group.id)
    const was = oldGroups.get(group.id)
    if (!was || JSON.stringify(was) !== JSON.stringify(group)) patch.groups.upsert.push(group)
  }
  for (const group of previous.groups) {
    if (!seenGroups.has(group.id)) patch.groups.remove.push(group.id)
  }

  const oldTags = tagKeysOf(previous.feeds)
  const newTags = tagKeysOf(to.feeds)
  for (const key of newTags) {
    if (!oldTags.has(key)) patch.tags.upsert.push(splitTagKey(key))
  }
  for (const key of oldTags) {
    if (!newTags.has(key)) patch.tags.remove.push(splitTagKey(key))
  }

  const oldMarks = new Map(markRowsOf(previous).map(row => [markKey(row.kind, row.entryId), row]))
  const seenMarks = new Set<string>()
  for (const row of markRowsOf(to)) {
    const key = markKey(row.kind, row.entryId)
    seenMarks.add(key)
    const was = oldMarks.get(key)
    if (was && was.value === row.value && was.at === row.at) continue
    const isList = LISTS.some(([kind]) => kind === row.kind)
    patch.marks.upsert.push(!was && isList ? { ...row, at: now() } : row)
  }
  for (const row of oldMarks.values()) {
    if (!seenMarks.has(markKey(row.kind, row.entryId))) {
      patch.marks.remove.push({ kind: row.kind, entryId: row.entryId })
    }
  }

  if ((from?.lastChannel ?? '') !== to.lastChannel) patch.state = { lastChannel: to.lastChannel }
  return patch
}

/** True when nothing would be written, which is how a save becomes a no-op. */
export function patchIsEmpty(patch: RssPatch): boolean {
  return !patch.feeds.upsert.length && !patch.feeds.remove.length
    && !patch.groups.upsert.length && !patch.groups.remove.length
    && !patch.tags.upsert.length && !patch.tags.remove.length
    && !patch.marks.upsert.length && !patch.marks.remove.length
    && !patch.state
}

/**
 * A change set that arrived over the network, checked before anything is folded in.
 *
 * The client is the only sender, so anything else is either an old build or somebody at a console,
 * and neither gets to have a shape the merge would have to guess at: every field has to be there,
 * of the right kind, and no larger than the library it is meant to update.
 */
export function parseRssPatch(value: unknown): RssPatch | null {
  if (!isRecord(value)) return null
  const feeds = readSection(value.feeds, 'upsert', 'remove')
  const groups = readSection(value.groups, 'upsert', 'remove')
  const tags = readSection(value.tags, 'upsert', 'remove')
  const marks = readSection(value.marks, 'upsert', 'remove')
  if (!feeds || !groups || !tags || !marks) return null
  const patch: RssPatch = { feeds, groups, tags, marks, state: null }
  if (value.state !== null && value.state !== undefined) {
    if (!isRecord(value.state) || typeof value.state.lastChannel !== 'string') return null
    patch.state = { lastChannel: value.state.lastChannel.slice(0, 120) }
  }
  for (const feed of patch.feeds.upsert) {
    if (!isRecord(feed) || typeof feed.id !== 'string' || typeof feed.url !== 'string' || typeof feed.title !== 'string') return null
  }
  for (const group of patch.groups.upsert) {
    if (!isRecord(group) || typeof group.id !== 'string' || typeof group.name !== 'string') return null
  }
  for (const key of [...patch.tags.upsert, ...patch.tags.remove]) {
    if (!isRecord(key) || typeof key.feedId !== 'string' || typeof key.tag !== 'string') return null
  }
  for (const row of patch.marks.upsert) {
    if (!isRecord(row) || typeof row.entryId !== 'string') return null
    if (!isMarkKind(row.kind)) return null
    if (typeof row.value !== 'string' || typeof row.at !== 'number' || !Number.isFinite(row.at)) return null
  }
  for (const row of patch.marks.remove) {
    if (!isRecord(row) || typeof row.entryId !== 'string' || !isMarkKind(row.kind)) return null
  }
  return patch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isMarkKind(value: unknown): value is RssMarkKind {
  return typeof value === 'string' && (RSS_MARK_KINDS as readonly string[]).includes(value)
}

/** `{ upsert: [...], remove: [...] }`, each side an array of at most the ceiling it belongs to. */
function readSection(value: unknown, upsertName: string, removeName: string): { upsert: never[], remove: never[] } | null {
  if (!isRecord(value)) return null
  const upsert = Array.isArray(value[upsertName]) ? value[upsertName] : null
  const remove = Array.isArray(value[removeName]) ? value[removeName] : null
  if (!upsert || !remove) return null
  if (upsert.length > RSS_LIMITS.feeds || remove.length > RSS_LIMITS.feeds) return null
  return { upsert, remove } as unknown as { upsert: never[], remove: never[] }
}

/** How large a change set is, counted the way the route counts a body. */
export function patchChars(patch: RssPatch): number {
  return JSON.stringify(patch).length
}

/**
 * Fold a change set into the library the account already holds.
 *
 * A mark this patch adds goes to the front of its list, because newest-first is the order the
 * reader's own lists are kept in and the ceiling trims from the back.
 */
export function applyLibraryPatch(library: RssLibrary, patch: RssPatch): RssLibrary {
  const feeds = library.feeds.map(feed => ({ ...feed, tags: [...feed.tags] }))
  const groups = library.groups.map(group => ({ ...group }))

  const goneGroups = new Set(patch.groups.remove)
  const keptGroups = goneGroups.size ? groups.filter(group => !goneGroups.has(group.id)) : groups
  for (const group of patch.groups.upsert) {
    const at = keptGroups.findIndex(item => item.id === group.id)
    if (at >= 0) keptGroups[at] = { ...group }
    else keptGroups.push({ ...group })
  }

  const goneFeeds = new Set(patch.feeds.remove)
  const keptFeeds = goneFeeds.size ? feeds.filter(feed => !goneFeeds.has(feed.id)) : feeds
  for (const key of patch.tags.remove) {
    const feed = keptFeeds.find(item => item.id === key.feedId)
    if (feed) feed.tags = feed.tags.filter(tag => tag !== key.tag)
  }
  for (const feed of patch.feeds.upsert) {
    const at = keptFeeds.findIndex(item => item.id === feed.id)
    const copy = { ...feed, tags: [...feed.tags] }
    if (at >= 0) keptFeeds[at] = copy
    else keptFeeds.push(copy)
  }
  for (const key of patch.tags.upsert) {
    const feed = keptFeeds.find(item => item.id === key.feedId)
    if (feed && !feed.tags.includes(key.tag)) feed.tags = [...feed.tags, key.tag]
  }

  const lists = {
    readIds: [...library.readIds],
    favorites: [...library.favorites],
    readLater: [...library.readLater],
    hiddenIds: [...library.hiddenIds],
  }
  for (const [kind, field] of LISTS) {
    const removed = new Set(patch.marks.remove.filter(row => row.kind === kind).map(row => row.entryId))
    const added: string[] = []
    for (const row of patch.marks.upsert) {
      if (row.kind === kind && !added.includes(row.entryId)) added.push(row.entryId)
    }
    if (!removed.size && !added.length) continue
    const current = removed.size ? lists[field].filter(entryId => !removed.has(entryId)) : lists[field]
    lists[field] = [...added, ...current.filter(entryId => !added.includes(entryId))]
  }

  const opened = { ...library.opened }
  const savedNotes = { ...library.savedNotes }
  for (const row of patch.marks.remove) {
    if (row.kind === 'opened') delete opened[row.entryId]
    else if (row.kind === 'note' || row.kind === 'copy') delete savedNotes[`${row.entryId}|${row.kind}`]
  }
  for (const row of patch.marks.upsert) {
    if (row.kind === 'opened') opened[row.entryId] = row.at
    else if (row.kind === 'note') savedNotes[`${row.entryId}|note`] = row.value
    else if (row.kind === 'copy') savedNotes[`${row.entryId}|copy`] = row.value
  }

  return {
    version: library.version,
    feeds: keptFeeds,
    groups: keptGroups,
    readIds: lists.readIds,
    favorites: lists.favorites,
    readLater: lists.readLater,
    hiddenIds: lists.hiddenIds,
    opened,
    savedNotes,
    lastChannel: patch.state?.lastChannel ?? library.lastChannel,
  }
}
