import { describe, expect, it } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { buildActivityProjectionCached } from './calendar-activity'
import { dateKey } from './time'

const note = (overrides: Partial<NoteSummary> = {}): NoteSummary => ({
  id: 'n1', title: 'Note', excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false,
  isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 0, updatedAt: 0, deletedAt: null,
  ...overrides,
})

const asRecord = (items: NoteSummary[]): Record<string, NoteSummary> =>
  Object.fromEntries(items.map((item) => [item.id, item]))

const naive = (notes: Record<string, NoteSummary>) => {
  const counts = new Map<string, number>()
  const noteIdByTitle = new Map<string, string>()
  const notesByDay = new Map<string, { id: string; title: string; updatedAt: number }[]>()
  for (const item of Object.values(notes)) {
    if (item.deletedAt !== null)
      continue
    const key = dateKey(new Date(item.updatedAt))
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (!noteIdByTitle.has(item.title))
      noteIdByTitle.set(item.title, item.id)
    const list = notesByDay.get(key)
    const entry = { id: item.id, title: item.title, updatedAt: item.updatedAt }
    if (list)
      list.push(entry)
    else
      notesByDay.set(key, [entry])
  }
  for (const list of notesByDay.values())
    list.sort((a, b) => b.updatedAt - a.updatedAt)
  return { counts, noteIdByTitle, notesByDay }
}

const day = (year: number, month: number, dayOfMonth: number, hour = 12): number =>
  new Date(year, month - 1, dayOfMonth, hour).getTime()
const id = (index: number) => `note-${String(index).padStart(5, '0')}`

// A mulberry32 PRNG so the differential run is deterministic across runs.
const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FUZZ_TITLES = ['Shared', 'Untitled', 'Diary', 'Project', 'Scratch']

// Three cases below build or rebuild a vault of thousands of notes, and the work is synchronous: idle
// this file costs ~1.7 s a case, and the suite runs one file per core, so a busy machine stretches that
// past the default five-second budget without anything being wrong with the projection. The budget is
// stated here rather than paid for by a smaller vault — the coverage is the point of these cases. The
// same shape as `kanban-render-budget.test.ts`'s `HEAVY_BOARD`.
const HEAVY_VAULT = { timeout: 30_000 }

// One random op against the map, mirroring the differential fuzz test's branch
// probabilities; rand() is consumed in exactly the same order per step.
const randomStep = (rand: () => number, notes: Record<string, NoteSummary>, step: number): Record<string, NoteSummary> => {
  const op = rand()
  const target = id(Math.floor(rand() * 5_500))
  const current = notes[target]
  if (!current) {
    // A missing target acts as a brand-new note.
    const ts = day(2024 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 12), 1 + Math.floor(rand() * 28))
    return { ...notes, [target]: note({ id: target, title: FUZZ_TITLES[Math.floor(rand() * FUZZ_TITLES.length)]!, updatedAt: ts, createdAt: ts }) }
  }
  if (op < 0.35) {
    return { ...notes, [target]: { ...current, updatedAt: day(2024 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 12), 1 + Math.floor(rand() * 28)) } }
  }
  if (op < 0.5) {
    return { ...notes, [target]: { ...current, title: FUZZ_TITLES[Math.floor(rand() * FUZZ_TITLES.length)]! } }
  }
  if (op < 0.65) {
    return { ...notes, [target]: { ...current, deletedAt: day(2026, 9, 1), updatedAt: day(2026, 9, 1) } }
  }
  if (op < 0.75) {
    return { ...notes, [target]: { ...current, deletedAt: null, updatedAt: day(2024 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 12), 1 + Math.floor(rand() * 28)) } }
  }
  if (op < 0.85) {
    const ts = day(2024 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 12), 1 + Math.floor(rand() * 28))
    return { ...notes, [id(5_500 + step)]: note({ id: id(5_500 + step), title: FUZZ_TITLES[Math.floor(rand() * FUZZ_TITLES.length)]!, updatedAt: ts, createdAt: ts }) }
  }
  if (op < 0.95) {
    return { ...notes, [target]: { ...current, isPinned: true, excerpt: `excerpt ${step}` } }
  }
  const { [target]: gone, ...rest } = notes
  void gone
  return rest
}

// Same-millisecond ties have no consumable order (the UI only reads id/title),
// and only the order of equal timestamps can diverge: the naive rebuild follows
// map insertion while the incremental re-appends notes that left and re-entered
// a day. Compare with a canonical (updatedAt, id) sort instead.
const normalize = (byDay: Map<string, { id: string; title: string; updatedAt: number }[]>): Map<string, string[]> => {
  const out = new Map<string, string[]>()
  for (const [dayKey, list] of byDay) {
    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    out.set(dayKey, sorted.map((item) => `${item.updatedAt}|${item.id}|${item.title}`))
  }
  return out
}

describe('buildActivityProjectionCached — cold build and identity', () => {
  it('matches a fresh rebuild over a 19.8k-vault cold build', HEAVY_VAULT, () => {
    const notes: Record<string, NoteSummary> = {}
    for (let i = 0; i < 19_800; i++) {
      const ts = day(2024 + (i % 5), 1 + (i % 12), 1 + (i % 28), 1 + (i % 23))
      notes[id(i)] = note({ id: id(i), title: `Note ${i % 9}`, updatedAt: ts, createdAt: ts })
    }
    const projection = buildActivityProjectionCached(notes)
    const expected = naive(notes)
    expect(projection.counts).toEqual(expected.counts)
    expect(projection.noteIdByTitle).toEqual(expected.noteIdByTitle)
    expect(projection.notesByDay).toEqual(expected.notesByDay)
  })

  it('returns the exact same projection for the same map identity', () => {
    const map = asRecord([
      note({ id: 'a', updatedAt: day(2026, 8, 1) }),
      note({ id: 'b', updatedAt: day(2026, 8, 2) }),
    ])
    const first = buildActivityProjectionCached(map)
    expect(buildActivityProjectionCached(map)).toBe(first)
  })

  it('keeps every output identity stable when a commit touches no projection field', () => {
    const map = asRecord([
      note({ id: 'a', updatedAt: day(2026, 1, 10) }),
      note({ id: 'b', updatedAt: day(2026, 1, 11) }),
      note({ id: 'c', updatedAt: day(2026, 1, 12) }),
    ])
    const first = buildActivityProjectionCached(map)
    const pinned = { ...map.a!, isPinned: true, folderId: 'f1', excerpt: 'x' }
    const second = buildActivityProjectionCached({ ...map, a: pinned })
    expect(second.counts).toBe(first.counts)
    expect(second.noteIdByTitle).toBe(first.noteIdByTitle)
    expect(second.notesByDay).toBe(first.notesByDay)
  })
})

describe('buildActivityProjectionCached — incremental day edits', () => {
  it('re-derives only the edited note slices when a same-day edit changes updatedAt', () => {
    const map = asRecord([
      note({ id: 'a', updatedAt: day(2026, 7, 1) }),
      note({ id: 'b', title: 'Shared', updatedAt: day(2026, 7, 2) }),
      note({ id: 'c', title: 'Shared', updatedAt: day(2026, 7, 3) }),
    ])
    const first = buildActivityProjectionCached(map)
    const edited = { ...map.b!, excerpt: 'new', wordCount: 5, charCount: 20, updatedAt: day(2026, 7, 2, 15) }
    const second = buildActivityProjectionCached({ ...map, b: edited })
    expect(second.counts).toBe(first.counts)
    expect(second.noteIdByTitle).toBe(first.noteIdByTitle)
    // The untouched day keeps its exact array identity.
    expect(second.notesByDay.get('2026-07-01')).toBe(first.notesByDay.get('2026-07-01'))
    expect(second.notesByDay.get('2026-07-03')).toBe(first.notesByDay.get('2026-07-03'))
    // The edited day is rebuilt with the new updatedAt ordering.
    expect(second.notesByDay.get('2026-07-02')).toEqual([{ id: 'b', title: 'Shared', updatedAt: day(2026, 7, 2, 15) }])
  })

  it('moves a note across day buckets with counts corrected and untouched days stable', () => {
    const map = asRecord([
      note({ id: 'a', updatedAt: day(2026, 7, 1) }),
      note({ id: 'b', updatedAt: day(2026, 7, 2) }),
      note({ id: 'c', updatedAt: day(2026, 7, 3) }),
    ])
    const first = buildActivityProjectionCached(map)
    const moved = { ...map.b!, updatedAt: day(2026, 8, 15) }
    const second = buildActivityProjectionCached({ ...map, b: moved })
    expect(second.counts.get('2026-07-02')).toBeUndefined()
    expect(second.counts.get('2026-08-15')).toBe(1)
    expect(second.counts.get('2026-07-01')).toBe(1)
    expect(second.notesByDay.get('2026-07-02')).toBeUndefined()
    expect(second.notesByDay.get('2026-08-15')).toEqual([{ id: 'b', title: 'Note', updatedAt: day(2026, 8, 15) }])
    expect(second.notesByDay.get('2026-07-01')).toBe(first.notesByDay.get('2026-07-01'))
    expect(second.notesByDay.get('2026-07-03')).toBe(first.notesByDay.get('2026-07-03'))
  })

  it('sorts a day list by updatedAt descending after a same-day edit', () => {
    const map = asRecord([
      note({ id: 'a', updatedAt: day(2026, 7, 2, 9) }),
      note({ id: 'b', updatedAt: day(2026, 7, 2, 10) }),
      note({ id: 'c', updatedAt: day(2026, 7, 2, 11) }),
    ])
    const first = buildActivityProjectionCached(map)
    expect(first.notesByDay.get('2026-07-02')!.map((item) => item.id)).toEqual(['c', 'b', 'a'])
    const edited = { ...map.a!, updatedAt: day(2026, 7, 2, 12) }
    const second = buildActivityProjectionCached({ ...map, a: edited })
    expect(second.notesByDay.get('2026-07-02')!.map((item) => item.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('buildActivityProjectionCached — title slot re-claim', () => {
  it('re-claims a vacated title slot by the next note in map order', () => {
    const map = asRecord([
      note({ id: 'a', title: 'Alpha', updatedAt: day(2026, 7, 1) }),
      note({ id: 'b', title: 'Alpha', updatedAt: day(2026, 7, 2) }),
      note({ id: 'c', title: 'Other', updatedAt: day(2026, 7, 3) }),
    ])
    const first = buildActivityProjectionCached(map)
    expect(first.noteIdByTitle.get('Alpha')).toBe('a')
    // The owner changes title; note b (later in map order) takes over.
    const renamed = { ...map.a!, title: 'Beta' }
    const second = buildActivityProjectionCached({ ...map, a: renamed })
    expect(second.noteIdByTitle.get('Alpha')).toBe('b')
    expect(second.noteIdByTitle.get('Beta')).toBe('a')
    // Renaming a non-owner leaves the slot untouched.
    const third = buildActivityProjectionCached({ ...map, b: { ...map.b!, title: 'Gamma' } })
    expect(third.noteIdByTitle.get('Alpha')).toBe('a')
    // A late map-order note sharing a title never steals the slot.
    const fourth = buildActivityProjectionCached({ ...map, c: { ...map.c!, title: 'Alpha' } })
    expect(fourth.noteIdByTitle.get('Alpha')).toBe('a')
  })
})

describe('buildActivityProjectionCached — tombstones and sweeps', () => {
  it('drops and restores a tombstoned note across every slice', () => {
    const map = asRecord([
      note({ id: 'a', updatedAt: day(2026, 7, 1) }),
      note({ id: 'b', title: 'Unique', updatedAt: day(2026, 7, 2) }),
    ])
    const first = buildActivityProjectionCached(map)
    const trashed = { ...map.b!, deletedAt: day(2026, 9, 1) }
    const second = buildActivityProjectionCached({ ...map, b: trashed })
    expect(second.counts.get('2026-07-02')).toBeUndefined()
    expect(second.notesByDay.get('2026-07-02')).toBeUndefined()
    expect(second.noteIdByTitle.get('Unique')).toBeUndefined()
    expect(second.notesByDay.get('2026-07-01')).toBe(first.notesByDay.get('2026-07-01'))
    // Reviving re-adds the note everywhere with its new timeline position.
    const revived = { ...map.b!, deletedAt: null, updatedAt: day(2026, 7, 2, 8) }
    const third = buildActivityProjectionCached({ ...map, b: revived })
    expect(third.counts.get('2026-07-02')).toBe(1)
    expect(third.noteIdByTitle.get('Unique')).toBe('b')
    expect(third.notesByDay.get('2026-07-02')).toEqual([{ id: 'b', title: 'Unique', updatedAt: day(2026, 7, 2, 8) }])
  })

  it('sweeps an id that vanishes from the map without a tombstone', () => {
    const map = asRecord([
      note({ id: 'a', updatedAt: day(2026, 7, 1) }),
      note({ id: 'b', title: 'Gone', updatedAt: day(2026, 7, 2) }),
    ])
    buildActivityProjectionCached(map)
    const { b: _removed, ...shrunk } = map
    const second = buildActivityProjectionCached(shrunk)
    expect(second.counts.get('2026-07-02')).toBeUndefined()
    expect(second.noteIdByTitle.get('Gone')).toBeUndefined()
    expect(second.notesByDay.get('2026-07-02')).toBeUndefined()
    expect(second.notesByDay.get('2026-07-01')).toEqual([{ id: 'a', title: 'Note', updatedAt: day(2026, 7, 1) }])
    void _removed
  })
})

describe('buildActivityProjectionCached — differential fuzz', () => {
  it('stays equal to the naive rebuild through a seeded random op sequence', HEAVY_VAULT, () => {
    const rand = mulberry32(20260902)
    const notes: Record<string, NoteSummary> = {}
    for (let i = 0; i < 5_000; i++) {
      const ts = day(2025 + (i % 3), 1 + (i % 12), 1 + (i % 28), 1 + (i % 23))
      notes[id(i)] = note({ id: id(i), title: FUZZ_TITLES[i % FUZZ_TITLES.length]!, updatedAt: ts, createdAt: ts })
    }
    let next = notes
    for (let step = 0; step < 80; step++) {
      next = randomStep(rand, next, step)
      const projection = buildActivityProjectionCached(next)
      const expected = naive(next)
      expect(projection.counts).toEqual(expected.counts)
      expect(projection.noteIdByTitle).toEqual(expected.noteIdByTitle)
      expect(normalize(projection.notesByDay)).toEqual(normalize(expected.notesByDay))
    }
  })
})

describe('calendar projection benchmark', () => {
  it('measures cold build, incremental commits, and identity stability on a 19.8k vault (CI gated)', HEAVY_VAULT, () => {
    const notes: Record<string, NoteSummary> = {}
    const start = Date.UTC(2024, 8, 3)
    const dayMs = 86_400_000
    const notesPerDay = 28
    const benchId = (index: number) => `seed-${String(index).padStart(5, '0')}`
    for (let i = 0; i < 19_800; i++) {
      const ts = start + Math.floor(i / notesPerDay) * dayMs + Math.floor((i % notesPerDay) * dayMs / notesPerDay)
      notes[benchId(i)] = note({ id: benchId(i), title: `Seed ${i % 9}`, createdAt: ts, updatedAt: ts + 3_600_000 })
    }
    const coldStart = performance.now()
    buildActivityProjectionCached(notes)
    const coldMs = performance.now() - coldStart
    const shortcutStart = performance.now()
    buildActivityProjectionCached(notes)
    const shortcutMs = performance.now() - shortcutStart
    let map = notes
    const keys = Object.keys(notes).slice(0, 10)
    const chain: number[] = []
    for (let step = 0; step < 10; step++) {
      const target = keys[step % keys.length]!
      const current = map[target]!
      map = { ...map, [target]: { ...current, excerpt: `e${step}`, updatedAt: current.updatedAt + (step + 1) * 60_000 } }
      const t0 = performance.now()
      buildActivityProjectionCached(map)
      chain.push(performance.now() - t0)
    }
    const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    const before = buildActivityProjectionCached(map)
    const after = buildActivityProjectionCached({ ...map, [keys[0]!]: { ...map[keys[0]!], updatedAt: map[keys[0]!].updatedAt + 30_000 } })
    const identityStable = after.counts === before.counts && after.noteIdByTitle === before.noteIdByTitle
    console.log('')
    console.log(`[calendar proj benchmark] vault=19,800 note summaries, 10 typing commits, one note edited per commit`)
    console.log(`  cold build ms: ${coldMs.toFixed(1)}`)
    console.log(`  incremental per commit ms: ${chain.map((value) => value.toFixed(1)).join(', ')}`)
    console.log(`  per-commit average ms: ${avg(chain).toFixed(1)}`)
    console.log(`  same-map shortcut ms: ${shortcutMs.toFixed(2)}`)
    console.log(`  same-day identity stable: ${identityStable ? 'yes' : 'no'}`)
  })

})