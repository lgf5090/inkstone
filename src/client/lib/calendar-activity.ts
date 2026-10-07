import type { NoteSummary } from '@shared/types'
import { dateKey } from './time'
import { isActiveNote, isDeleted } from './note-visibility'

// The activity-heatmap calendar derives three whole-vault structures from each
// note (per-day updatedAt counts, first-note-per-title lookup, per-day note
// lists), and every typing pause commits a notes-map identity change, so all
// three Object.values scans used to re-run over the full vault per commit.
// Build the projection once and then repair it by diffing note references: a
// commit only replaces the edited note's object, so untouched day buckets and
// the title map keep their identities (memoized consumers skip them), and only
// the edited note's old/new day slices and title slot are recomputed.
export interface ActivityDayNote {
  id: string
  title: string
  updatedAt: number
}

export interface ActivityProjection {
  counts: Map<string, number>
  noteIdByTitle: Map<string, string>
  notesByDay: Map<string, ActivityDayNote[]>
  /** Newest `updatedAt` among counted notes as a day key; null when the vault holds none. */
  latestEditKey: string | null
}


interface ActivityEntry {
  ref: NoteSummary
  key: string
  title: string
  counted: boolean
  // Where the id sits in the record's own order: the fresh build gives a title to the first note
  // that carries it, so an incremental repair can only hand a slot over to a note that comes
  // earlier than the current owner.
  order: number
}


interface ActivityProjectionSlot extends ActivityProjection {
  notes: Record<string, NoteSummary>
  byId: Map<string, ActivityEntry>
  titleCounts: Map<string, number>
  latestUpdatedAt: number
  lastOrder: number
}

// Two tiers of visibility, because the calendar asks two different questions. The day
// slices answer "how active was this day", which has to agree with what the note list
// shows, so archived notes are out (isActiveNote). The title slots answer "which note is
// this day's diary", and an archived diary must still be found there or clicking its date
// would file a second note for the same day.
const isAliveNote = (note: NoteSummary): boolean => !isDeleted(note)

let activityProjectionSlot: ActivityProjectionSlot | null = null

// The newest edit is the one field of this projection a repair can lose without
// noticing, so every path that lowers it raises this flag and one exact rescan
// settles the answer afterwards. `>=` against the running maximum is what makes a
// tie (two notes sharing the newest millisecond) rescan too.
function latestEditKeyOf(latestUpdatedAt: number): string | null {
  return latestUpdatedAt === 0 ? null : dateKey(new Date(latestUpdatedAt))
}

// Only the counted tier feeds the gap banner: an archived note is invisible to the
// list, so pointing the reader at a day the list cannot show would repeat C-14.
function rescanLatestUpdatedAt(byId: Map<string, ActivityEntry>): number {
  let latest = 0
  for (const entry of byId.values()) {
    if (entry.counted && entry.ref.updatedAt > latest)
      latest = entry.ref.updatedAt
  }
  return latest
}

export function buildActivityProjectionFresh(notes: Record<string, NoteSummary>): ActivityProjectionSlot {
  const counts = new Map<string, number>()
  const noteIdByTitle = new Map<string, string>()
  const notesByDay = new Map<string, ActivityDayNote[]>()
  const byId = new Map<string, ActivityEntry>()
  const titleCounts = new Map<string, number>()
  let latestUpdatedAt = 0
  let position = 0
  for (const id in notes) {
    const order = position++
    const note = notes[id]!
    if (!isAliveNote(note))
      continue
    const key = dateKey(new Date(note.updatedAt))
    const counted = isActiveNote(note)
    byId.set(id, { ref: note, key, title: note.title, counted, order })
    titleCounts.set(note.title, (titleCounts.get(note.title) ?? 0) + 1)
    if (!noteIdByTitle.has(note.title))
      noteIdByTitle.set(note.title, id)
    if (!counted)
      continue
    if (note.updatedAt > latestUpdatedAt)
      latestUpdatedAt = note.updatedAt
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const list = notesByDay.get(key)
    const item: ActivityDayNote = { id, title: note.title, updatedAt: note.updatedAt }
    if (list)
      list.push(item)
    else
      notesByDay.set(key, [item])
  }
  for (const list of notesByDay.values())
    list.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  return { notes, counts, noteIdByTitle, notesByDay, byId, titleCounts, latestUpdatedAt, latestEditKey: latestEditKeyOf(latestUpdatedAt), lastOrder: position - 1 }
}

// First-wins over insertion order, matching the naive rebuild: the map holds
// the first alive note per title, so a vacated slot is re-claimed by the first
// alive note in map order that still carries the title.

function claimNextNoteWithTitle(notes: Record<string, NoteSummary>, title: string): string | null {
  for (const id in notes) {
    const note = notes[id]!
    if (isAliveNote(note) && note.title === title)
      return id
  }
  return null
}


function dropTitleClaim(titleCounts: Map<string, number>, titles: Map<string, string>, notes: Record<string, NoteSummary>, title: string, id: string): void {
  const rest = (titleCounts.get(title) ?? 0) - 1
  if (rest > 0) {
    titleCounts.set(title, rest)
    if (titles.get(title) === id) {
      titles.delete(title)
      const nextOwner = claimNextNoteWithTitle(notes, title)
      if (nextOwner)
        titles.set(title, nextOwner)
    }
  } else {
    titleCounts.delete(title)
    if (titles.get(title) === id)
      titles.delete(title)
  }
}

// The naive rebuild only ever records days with at least one note, so the
// incremental must drop a key when its count reaches zero (keeps the map
// bounded and matches the reference shape exactly).

function decrementCount(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 0) - 1
  if (next > 0)
    counts.set(key, next)
  else
    counts.delete(key)
}


function removeFromDay(byDay: Map<string, ActivityDayNote[]>, key: string, id: string): void {
  const list = byDay.get(key)
  if (!list)
    return
  const copy = list.filter((item) => item.id !== id)
  if (copy.length > 0)
    byDay.set(key, copy)
  else
    byDay.delete(key)
}


function upsertInDay(byDay: Map<string, ActivityDayNote[]>, key: string, item: ActivityDayNote): void {
  const list = byDay.get(key)
  const copy = list ? list.map((entry) => (entry.id === item.id ? item : entry)) : []
  if (!copy.some((entry) => entry.id === item.id))
    copy.push(item)
  copy.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  byDay.set(key, copy)
}

// Copy-on-write helpers: the incremental path reuses the previous maps until
// a note actually touches a slice, so every untouched output keeps its exact
// identity (memoized consumers skip it). Each helper swaps in a fresh map only
// once, before the first mutation of that slice.
interface ProjectionCtx {
  byId: Map<string, ActivityEntry>
  titleCounts: Map<string, number>
  counts: Map<string, number>
  titles: Map<string, string>
  byDay: Map<string, ActivityDayNote[]>
  oldCounts: Map<string, number>
  oldTitles: Map<string, string>
  oldByDay: Map<string, ActivityDayNote[]>
  next: Record<string, NoteSummary>
  order: number
  latestUpdatedAt: number
  latestMayHaveDropped: boolean
}

function ensureCountsWritable(ctx: ProjectionCtx): void {
  if (ctx.counts === ctx.oldCounts)
    ctx.counts = new Map(ctx.oldCounts)
}

function ensureByDayWritable(ctx: ProjectionCtx): void {
  if (ctx.byDay === ctx.oldByDay)
    ctx.byDay = new Map(ctx.oldByDay)
}

function ensureTitlesWritable(ctx: ProjectionCtx): void {
  if (ctx.titles === ctx.oldTitles)
    ctx.titles = new Map(ctx.oldTitles)
}

function trackLatestUpdatedAt(ctx: ProjectionCtx, from: number | null, to: number | null): void {
  if (to !== null && to > ctx.latestUpdatedAt) {
    ctx.latestUpdatedAt = to
    return
  }
  if (from !== null && from >= ctx.latestUpdatedAt)
    ctx.latestMayHaveDropped = true
}

// The fresh build hands a title to the first note in record order that carries it, so a
// repair may only move a slot to a note that comes earlier than the current owner.
function claimTitle(ctx: ProjectionCtx, title: string, id: string, order: number): void {
  const owner = ctx.titles.get(title)
  if (owner === undefined || owner === id) {
    ctx.titles.set(title, id)
    return
  }
  const current = ctx.byId.get(owner)
  if (!current || order < current.order)
    ctx.titles.set(title, id)
}

function applyTombstone(ctx: ProjectionCtx, id: string, prev: ActivityEntry): void {
  ctx.byId.delete(id)
  if (prev.counted) {
    ensureCountsWritable(ctx)
    ensureByDayWritable(ctx)
    decrementCount(ctx.counts, prev.key)
    removeFromDay(ctx.byDay, prev.key, id)
    trackLatestUpdatedAt(ctx, prev.ref.updatedAt, null)
  }
  ensureTitlesWritable(ctx)
  dropTitleClaim(ctx.titleCounts, ctx.titles, ctx.next, prev.title, id)
}

function applyInsert(ctx: ProjectionCtx, id: string, note: NoteSummary, key: string, counted: boolean): void {
  if (counted) {
    ensureCountsWritable(ctx)
    ensureByDayWritable(ctx)
    ctx.counts.set(key, (ctx.counts.get(key) ?? 0) + 1)
    upsertInDay(ctx.byDay, key, { id, title: note.title, updatedAt: note.updatedAt })
  }
  ensureTitlesWritable(ctx)
  claimTitle(ctx, note.title, id, ctx.order)
  ctx.titleCounts.set(note.title, (ctx.titleCounts.get(note.title) ?? 0) + 1)
  ctx.byId.set(id, { ref: note, key, title: note.title, counted, order: ctx.order++ })
  if (counted)
    trackLatestUpdatedAt(ctx, null, note.updatedAt)
}

// An alive note whose projection fields actually changed.
function applyChange(ctx: ProjectionCtx, id: string, note: NoteSummary, prev: ActivityEntry, key: string, counted: boolean): void {
  const item = { id, title: note.title, updatedAt: note.updatedAt }
  if (prev.counted && counted) {
    if (prev.key !== key) {
      ensureCountsWritable(ctx)
      decrementCount(ctx.counts, prev.key)
      ctx.counts.set(key, (ctx.counts.get(key) ?? 0) + 1)
      ensureByDayWritable(ctx)
      removeFromDay(ctx.byDay, prev.key, id)
      upsertInDay(ctx.byDay, key, item)
    } else {
      // Same day: per-day count is unchanged; only the day's list needs
      // rebuilding, so the counts map keeps its identity.
      ensureByDayWritable(ctx)
      upsertInDay(ctx.byDay, key, item)
    }
  }
  else if (prev.counted) {
    ensureCountsWritable(ctx)
    ensureByDayWritable(ctx)
    decrementCount(ctx.counts, prev.key)
    removeFromDay(ctx.byDay, prev.key, id)
  }
  else if (counted) {
    ensureCountsWritable(ctx)
    ensureByDayWritable(ctx)
    ctx.counts.set(key, (ctx.counts.get(key) ?? 0) + 1)
    upsertInDay(ctx.byDay, key, item)
  }
  if (prev.title !== note.title) {
    ensureTitlesWritable(ctx)
    dropTitleClaim(ctx.titleCounts, ctx.titles, ctx.next, prev.title, id)
    claimTitle(ctx, note.title, id, prev.order)
    ctx.titleCounts.set(note.title, (ctx.titleCounts.get(note.title) ?? 0) + 1)
  }
  ctx.byId.set(id, { ref: note, key, title: note.title, counted, order: prev.order })
  // Archiving retires the newest edit without changing its timestamp, and un-archiving
  // can hand it back, so either tier crossing has to be reported — but a note that sits
  // outside the counted tier on both sides never touched the maximum.
  if (prev.counted || counted)
    trackLatestUpdatedAt(ctx, prev.counted ? prev.ref.updatedAt : null, counted ? note.updatedAt : null)
}

// An id vanished from the map without a tombstone: drop its stale
// contributions (a rare path that costs one extra walk when it fires).
function sweepVanishedIds(ctx: ProjectionCtx): void {
  ensureTitlesWritable(ctx)
  for (const [id, entry] of [...ctx.byId]) {
    if (ctx.next[id] !== undefined)
      continue
    ctx.byId.delete(id)
    if (entry.counted) {
      ensureCountsWritable(ctx)
      ensureByDayWritable(ctx)
      decrementCount(ctx.counts, entry.key)
      removeFromDay(ctx.byDay, entry.key, id)
      trackLatestUpdatedAt(ctx, entry.ref.updatedAt, null)
    }
    dropTitleClaim(ctx.titleCounts, ctx.titles, ctx.next, entry.title, id)
  }
}

function updateActivityProjection(slot: ActivityProjectionSlot, next: Record<string, NoteSummary>): ActivityProjectionSlot {
  const ctx: ProjectionCtx = {
    byId: slot.byId,
    titleCounts: slot.titleCounts,
    counts: slot.counts,
    titles: slot.noteIdByTitle,
    byDay: slot.notesByDay,
    oldCounts: slot.counts,
    oldTitles: slot.noteIdByTitle,
    oldByDay: slot.notesByDay,
    next,
    order: slot.lastOrder + 1,
    latestUpdatedAt: slot.latestUpdatedAt,
    latestMayHaveDropped: false,
  }
  let visited = 0
  let tombstoned = 0
  for (const id in next) {
    visited++
    const note = next[id]!
    const prev = ctx.byId.get(id)
    if (prev && prev.ref === note)
      continue
    if (!isAliveNote(note)) {
      tombstoned++
      if (!prev)
        continue
      applyTombstone(ctx, id, prev)
      continue
    }
    const counted = isActiveNote(note)
    const key = dateKey(new Date(note.updatedAt))
    if (prev && prev.key === key && prev.title === note.title && prev.counted === counted && prev.ref.updatedAt === note.updatedAt) {
      // A commit that touched fields this projection does not read
      // (excerpt, tags, pin, ...): keep every output identity stable.
      // updatedAt feeds both the day key and the day-list sort, so it
      // must match down to the millisecond for the slice to be skipped.
      ctx.byId.set(id, { ref: note, key, title: note.title, counted, order: prev.order })
      continue
    }
    if (!prev) {
      applyInsert(ctx, id, note, key, counted)
      continue
    }
    applyChange(ctx, id, note, prev, key, counted)
  }
  if (visited - tombstoned !== ctx.byId.size)
    sweepVanishedIds(ctx)
  if (ctx.latestMayHaveDropped)
    ctx.latestUpdatedAt = rescanLatestUpdatedAt(ctx.byId)
  return {
    notes: next,
    counts: ctx.counts,
    noteIdByTitle: ctx.titles,
    notesByDay: ctx.byDay,
    byId: ctx.byId,
    titleCounts: ctx.titleCounts,
    latestUpdatedAt: ctx.latestUpdatedAt,
    latestEditKey: latestEditKeyOf(ctx.latestUpdatedAt),
    lastOrder: ctx.order - 1,
  }
}

export function buildActivityProjectionCached(notes: Record<string, NoteSummary>): ActivityProjection {
  const slot = activityProjectionSlot
  if (slot && slot.notes === notes)
    return slot
  const next = slot ? updateActivityProjection(slot, notes) : buildActivityProjectionFresh(notes)
  activityProjectionSlot = next
  return next
}
