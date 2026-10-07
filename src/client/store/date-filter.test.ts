import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { renderElement, type RenderedElement } from '../lib/test-render'
import { buildActivityProjectionCached } from '../lib/calendar-activity'
import { dateKey } from '../lib/time'
import { dayWindow, inDayWindow, useNotes, useVisibleNotes } from '../store/notes'
import { useUi } from '../store/ui'

const stamp = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12).getTime()

const summary = (id: string, updatedAt: number, overrides: Partial<NoteSummary> = {}): NoteSummary => ({
  id, title: id, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false,
  isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0,
  createdAt: updatedAt, updatedAt, deletedAt: null, ...overrides,
})

const NOTES = {
  early: summary('early', stamp(2026, 9, 12)),
  midA: summary('midA', stamp(2026, 10, 4)),
  midB: summary('midB', stamp(2026, 10, 5)),
  late: summary('late', stamp(2026, 10, 6)),
  trashed: summary('trashed', stamp(2026, 10, 5), { deletedAt: stamp(2026, 10, 6) }),
  archived: summary('archived', stamp(2026, 10, 5), { isArchived: true }),
}

const ALL_UNFILTERED = ['early', 'late', 'midA', 'midB']

let visible: NoteSummary[] = []
function VisibleProbe() {
  visible = useVisibleNotes()
  return null
}

function apply(filter: { start: string; end: string } | null) {
  act(() => { useUi.getState().setDateFilter(filter) })
  return visible.map((note) => note.id).sort()
}

describe('the list honours the calendar day filter', () => {
  const originalNotes = useNotes.getState()
  const originalUi = useUi.getState()
  let rendered: RenderedElement

  beforeEach(() => {
    useNotes.setState({ ...originalNotes, notes: NOTES, folders: [], tags: [] })
    useUi.setState({ ...originalUi, view: 'all', folderId: null, tags: [], dateFilter: null })
    rendered = renderElement(createElement(VisibleProbe))
  })

  afterEach(() => {
    rendered.unmount()
    useNotes.setState(originalNotes, true)
    useUi.setState(originalUi, true)
  })

  it('shows every live note when no range is selected', () => {
    expect(apply(null)).toEqual(ALL_UNFILTERED)
  })

  it('keeps exactly the notes the heat cell counted for one day', () => {
    const key = dateKey(new Date(2026, 9, 5))
    expect(apply({ start: key, end: key })).toEqual(['midB'])
  })

  it('is inclusive at both ends of a dragged range', () => {
    expect(apply({ start: '2026-10-04', end: '2026-10-06' })).toEqual(['late', 'midA', 'midB'])
  })

  it('clears back to the unfiltered collection', () => {
    expect(apply({ start: '2026-10-04', end: '2026-10-06' })).toEqual(['late', 'midA', 'midB'])
    expect(apply(null)).toEqual(ALL_UNFILTERED)
  })

  it('composes with the folder view instead of replacing it', () => {
    act(() => {
      useNotes.setState({
        ...useNotes.getState(),
        folders: [{ id: 'f1', parentId: null, name: 'F', icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 }],
        notes: { ...NOTES, inFolder: summary('inFolder', stamp(2026, 10, 5), { folderId: 'f1' }) },
      })
      useUi.setState({ view: 'folder', folderId: 'f1', dateFilter: { start: '2026-10-05', end: '2026-10-05' } })
    })
    expect(visible.map((note) => note.id)).toEqual(['inFolder'])
  })

  it('drops the range when the view changes', () => {
    apply({ start: '2026-10-04', end: '2026-10-04' })
    act(() => { useUi.getState().openView('starred') })
    expect(useUi.getState().dateFilter).toBeNull()
  })

  it('answers the heat cell with the same collection it promises', () => {
    // One number, two truths: the projection feeds the cell and this hook feeds the
    // rows, so any day whose count differs from its visible list is a broken promise.
    const projection = buildActivityProjectionCached(NOTES)
    const keys = Object.values(NOTES).map((item) => dateKey(new Date(item.updatedAt)))
    for (const key of [...new Set(keys)]) {
      const listed = apply({ start: key, end: key })
      expect(listed, key).toEqual((projection.notesByDay.get(key) ?? []).map((item) => item.id).sort())
      expect(listed.length, key).toBe(projection.counts.get(key) ?? 0)
    }
    expect(apply(null)).toHaveLength([...projection.counts.values()].reduce((sum, value) => sum + value, 0))
  })
})

// C-08. The predicate used to build a `YYYY-MM-DD` string from every note's
// `updatedAt` on every list recompute, so a 20k vault paid one Date, one string and
// two string compares per row per commit. Comparing instants instead is only safe if
// the window's own edges are calendar-correct: the end has to be the start of the
// day AFTER `range.end`, because a fixed +86400000 loses the 23:00–24:00 hour on any
// day the reader's zone makes 23 hours long.
describe('the day filter compares instants, not day keys', () => {
  const originalNotes = useNotes.getState()
  const originalUi = useUi.getState()
  let rendered: RenderedElement

  const edgeStamps = [
    new Date(2026, 9, 4, 0, 0, 0, 0).getTime(),
    new Date(2026, 9, 4, 23, 59, 59, 999).getTime(),
    new Date(2026, 9, 5, 0, 0, 0, 0).getTime(),
    new Date(2026, 9, 5, 12, 0, 0, 0).getTime(),
    new Date(2026, 9, 5, 23, 30, 0, 0).getTime(),
    new Date(2026, 9, 5, 23, 59, 59, 999).getTime(),
    new Date(2026, 9, 6, 0, 0, 0, 0).getTime(),
    new Date(2026, 9, 6, 0, 0, 0, 1).getTime(),
    // The two Sundays a northern-hemisphere zone changes offset on: one 23-hour day
    // and one 25-hour day, at the hours a note is actually written.
    new Date(2026, 2, 29, 1, 30, 0, 0).getTime(),
    new Date(2026, 2, 29, 2, 30, 0, 0).getTime(),
    new Date(2026, 9, 25, 2, 30, 0, 0).getTime(),
    new Date(2026, 9, 25, 3, 30, 0, 0).getTime(),
  ]

  const EDGE_NOTES = Object.fromEntries(edgeStamps.map((at, i) => [`e${i}`, summary(`e${i}`, at)]))

  const byDayKey = (at: number, start: string, end: string) => {
    const key = dateKey(new Date(at))
    return key >= start && key <= end
  }

  beforeEach(() => {
    useNotes.setState({ ...originalNotes, notes: EDGE_NOTES, folders: [], tags: [] })
    useUi.setState({ ...originalUi, view: 'all', folderId: null, tags: [], dateFilter: null })
    rendered = renderElement(createElement(VisibleProbe))
  })

  afterEach(() => {
    rendered.unmount()
    useNotes.setState(originalNotes, true)
    useUi.setState(originalUi, true)
  })

  it('keeps the last minute of the closing day, which a fixed day-length window drops', () => {
    expect(apply({ start: '2026-10-05', end: '2026-10-05' })).toEqual(['e2', 'e3', 'e4', 'e5'])
  })

  it('cuts exactly at midnight on both sides of a single-day window', () => {
    const single = apply({ start: '2026-10-05', end: '2026-10-05' })
    expect(single).not.toContain('e1')
    expect(single).not.toContain('e6')
    expect(single).not.toContain('e7')
  })

  it('answers the same set as the day-key predicate across every edge and both DST Sundays', () => {
    for (const [start, end] of [
      ['2026-10-04', '2026-10-04'],
      ['2026-10-04', '2026-10-05'],
      ['2026-10-05', '2026-10-05'],
      ['2026-10-05', '2026-10-06'],
      ['2026-10-06', '2026-10-06'],
      ['2026-03-29', '2026-03-29'],
      ['2026-10-25', '2026-10-25'],
      ['2026-03-01', '2026-12-31'],
    ]) {
      const expected = edgeStamps.filter((at) => byDayKey(at, start, end)).map((at) => `e${edgeStamps.indexOf(at)}`)
      expect(apply({ start, end })).toEqual(expected.sort())
    }
  })
})

const stringForm = (updatedAt: number, range: { start: string; end: string }) => {
  const key = dateKey(new Date(updatedAt))
  return key >= range.start && key <= range.end
}

// Node re-reads the zone from `process.env.TZ`, so a case can visit a zone that actually
// has a short day. The machine this repo is developed on is Asia/Shanghai, where no day is
// short any more, so a fixed `+86_400_000` upper bound passes there and fails here.
const withZone = (zone: string, run: () => void) => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  if (!env)
    throw new Error('the suite needs a process env to move the clock zone')
  const saved = env.TZ
  env.TZ = zone
  try {
    run()
  }
  finally {
    env.TZ = saved
  }
}

describe('the numeric day window', () => {
  const stamps = Array.from({ length: 240 }, (_, index) => new Date(2026, 2, 6 + Math.floor(index / 60), 0, 0, (index % 60) * 37).getTime())
  const ranges = [
    { start: '2026-03-07', end: '2026-03-08' },
    { start: '2026-02-27', end: '2026-03-01' },
    { start: '2026-10-31', end: '2026-11-01' },
    { start: '2026-12-31', end: '2027-01-02' },
  ]
  const probe = (updatedAt: number) => ({ ...summary('probe', updatedAt), updatedAt })

  it('selects exactly what the formatted-key comparison selects, in every zone tested', () => {
    for (const zone of ['Asia/Shanghai', 'America/Santiago', 'Pacific/Apia', 'UTC']) {
      withZone(zone, () => {
        for (const range of ranges) {
          const days = dayWindow(range)!
          for (const stamp of stamps) {
            expect(inDayWindow(probe(stamp), days), `${zone} ${range.start}..${range.end} @${new Date(stamp).toISOString()}`).toBe(stringForm(stamp, range))
          }
        }
      })
    }
  })

  it('ends the last day at the next local midnight, not 24 hours on', () => {
    // Chile drops 00:00-01:00 on 2026-09-06, making that day 23 hours long.
    withZone('America/Santiago', () => {
      const days = dayWindow({ start: '2026-09-06', end: '2026-09-06' })!
      expect(inDayWindow(probe(new Date(2026, 8, 6, 23, 30).getTime()), days)).toBe(true)
      expect(inDayWindow(probe(new Date(2026, 8, 7, 0, 30).getTime()), days)).toBe(false)
      expect(days.to).toBe(new Date(2026, 8, 7, 0, 0).getTime())
      expect(days.to - days.from).toBeLessThan(86_400_000)
    })
  })

  it('reports what the two forms cost over a 20k vault (benchmark, no threshold)', () => {
    const vault = Array.from({ length: 20_000 }, (_, index) => ({ id: `n${index}`, updatedAt: new Date(2026, 2, 1 + (index % 700), index % 24).getTime() }))
    const range = { start: '2026-04-02', end: '2026-04-20' }
    const days = dayWindow(range)!
    const median = (run: () => number) => {
      const samples: number[] = []
      for (let pass = 0; pass < 5; pass += 1) {
        const start = performance.now()
        run()
        samples.push(performance.now() - start)
      }
      return samples.sort((left, right) => left - right)[2]
    }
    const stringMs = median(() => vault.filter((note) => stringForm(note.updatedAt, range)).length)
    const windowMs = median(() => vault.filter((note) => inDayWindow(note as never, days)).length)
    console.log(`[day window benchmark] 20,000 notes, one range: formatted keys ${stringMs.toFixed(2)}ms vs numeric window ${windowMs.toFixed(2)}ms (${(stringMs / Math.max(windowMs, 0.01)).toFixed(1)}x)`)
    expect(vault.filter((note) => stringForm(note.updatedAt, range)).length).toBe(vault.filter((note) => inDayWindow(note as never, days)).length)
  })
})
