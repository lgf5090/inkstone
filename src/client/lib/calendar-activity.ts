import type { NoteSummary } from '@shared/types'
import { dateKey } from './time'

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
}


interface ActivityEntry {
  ref: NoteSummary
  key: string
  title: string
}


interface ActivityProjectionSlot extends ActivityProjection {
  notes: Record<string, NoteSummary>
  byId: Map<string, ActivityEntry>
  titleCounts: Map<string, number>
}

let activityProjectionSlot: ActivityProjectionSlot | null = null

export function buildActivityProjectionFresh(notes: Record<string, NoteSummary>): ActivityProjectionSlot {
  const counts = new Map<string, number>()
  const noteIdByTitle = new Map<string, string>()
  const notesByDay = new Map<string, ActivityDayNote[]>()
  const byId = new Map<string, ActivityEntry>()
  const titleCounts = new Map<string, number>()
  for (const id in notes) {
    const note = notes[id]!
    if (note.deletedAt !== null)
      continue
    const key = dateKey(new Date(note.updatedAt))
    counts.set(key, (counts.get(key) ?? 0) + 1)
    byId.set(id, { ref: note, key, title: note.title })
    titleCounts.set(note.title, (titleCounts.get(note.title) ?? 0) + 1)
    if (!noteIdByTitle.has(note.title))
      noteIdByTitle.set(note.title, id)
    const list = notesByDay.get(key)
    const item: ActivityDayNote = { id, title: note.title, updatedAt: note.updatedAt }
    if (list)
      list.push(item)
    else
      notesByDay.set(key, [item])
  }
  for (const list of notesByDay.values())
    list.sort((a, b) => b.updatedAt - a.updatedAt)
  return { notes, counts, noteIdByTitle, notesByDay, byId, titleCounts }
}

// First-wins over insertion order, matching the naive rebuild: the map holds
// the first alive note per title, so a vacated slot is re-claimed by the first
// alive note in map order that still carries the title.

function claimNextNoteWithTitle(notes: Record<string, NoteSummary>, title: string): string | null {
  for (const id in notes) {
    const note = notes[id]!
    if (note.deletedAt === null && note.title === title)
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
  copy.sort((a, b) => b.updatedAt - a.updatedAt)
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

function applyTombstone(ctx: ProjectionCtx, id: string, prev: ActivityEntry): void {
  ctx.byId.delete(id)
  ensureCountsWritable(ctx)
  ensureByDayWritable(ctx)
  decrementCount(ctx.counts, prev.key)
  removeFromDay(ctx.byDay, prev.key, id)
  ensureTitlesWritable(ctx)
  dropTitleClaim(ctx.titleCounts, ctx.titles, ctx.next, prev.title, id)
}

function applyInsert(ctx: ProjectionCtx, id: string, note: NoteSummary, key: string): void {
  ensureCountsWritable(ctx)
  ensureByDayWritable(ctx)
  ctx.counts.set(key, (ctx.counts.get(key) ?? 0) + 1)
  upsertInDay(ctx.byDay, key, { id, title: note.title, updatedAt: note.updatedAt })
  ensureTitlesWritable(ctx)
  if (ctx.titles.get(note.title) === undefined)
    ctx.titles.set(note.title, id)
  ctx.titleCounts.set(note.title, (ctx.titleCounts.get(note.title) ?? 0) + 1)
  ctx.byId.set(id, { ref: note, key, title: note.title })
}

// An alive note whose projection fields actually changed.
function applyChange(ctx: ProjectionCtx, id: string, note: NoteSummary, prev: ActivityEntry, key: string): void {
  if (prev.key !== key) {
    ensureCountsWritable(ctx)
    decrementCount(ctx.counts, prev.key)
    ctx.counts.set(key, (ctx.counts.get(key) ?? 0) + 1)
    ensureByDayWritable(ctx)
    removeFromDay(ctx.byDay, prev.key, id)
    upsertInDay(ctx.byDay, key, { id, title: note.title, updatedAt: note.updatedAt })
  } else {
    // Same day: per-day count is unchanged; only the day's list needs
    // rebuilding, so the counts map keeps its identity.
    ensureByDayWritable(ctx)
    upsertInDay(ctx.byDay, key, { id, title: note.title, updatedAt: note.updatedAt })
  }
  if (prev.title !== note.title) {
    ensureTitlesWritable(ctx)
    dropTitleClaim(ctx.titleCounts, ctx.titles, ctx.next, prev.title, id)
    if (ctx.titles.get(note.title) === undefined)
      ctx.titles.set(note.title, id)
    ctx.titleCounts.set(note.title, (ctx.titleCounts.get(note.title) ?? 0) + 1)
  }
  ctx.byId.set(id, { ref: note, key, title: note.title })
}

// An id vanished from the map without a tombstone: drop its stale
// contributions (a rare path that costs one extra walk when it fires).
function sweepVanishedIds(ctx: ProjectionCtx): void {
  ensureCountsWritable(ctx)
  ensureByDayWritable(ctx)
  ensureTitlesWritable(ctx)
  for (const [id, entry] of [...ctx.byId]) {
    if (ctx.next[id] !== undefined)
      continue
    ctx.byId.delete(id)
    decrementCount(ctx.counts, entry.key)
    removeFromDay(ctx.byDay, entry.key, id)
    dropTitleClaim(ctx.titleCounts, ctx.titles, ctx.next, entry.title, id)
  }
}

export function updateActivityProjection(slot: ActivityProjectionSlot, next: Record<string, NoteSummary>): ActivityProjectionSlot {
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
  }
  let visited = 0
  let tombstoned = 0
  for (const id in next) {
    visited++
    const note = next[id]!
    const prev = ctx.byId.get(id)
    if (prev && prev.ref === note)
      continue
    if (note.deletedAt !== null) {
      tombstoned++
      if (!prev)
        continue
      applyTombstone(ctx, id, prev)
      continue
    }
    const key = dateKey(new Date(note.updatedAt))
    if (prev && prev.key === key && prev.title === note.title && prev.ref.updatedAt === note.updatedAt) {
      // A commit that touched fields this projection does not read
      // (excerpt, tags, pin, ...): keep every output identity stable.
      // updatedAt feeds both the day key and the day-list sort, so it
      // must match down to the millisecond for the slice to be skipped.
      ctx.byId.set(id, { ref: note, key, title: note.title })
      continue
    }
    if (!prev) {
      applyInsert(ctx, id, note, key)
      continue
    }
    applyChange(ctx, id, note, prev, key)
  }
  if (visited - tombstoned !== ctx.byId.size)
    sweepVanishedIds(ctx)
  return { notes: next, counts: ctx.counts, noteIdByTitle: ctx.titles, notesByDay: ctx.byDay, byId: ctx.byId, titleCounts: ctx.titleCounts }
}

export function buildActivityProjectionCached(notes: Record<string, NoteSummary>): ActivityProjection {
  const slot = activityProjectionSlot
  if (slot && slot.notes === notes)
    return slot
  const next = slot ? updateActivityProjection(slot, notes) : buildActivityProjectionFresh(notes)
  activityProjectionSlot = next
  return next
}
