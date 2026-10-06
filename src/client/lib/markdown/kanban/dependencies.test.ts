/**
 * KU-23. The dependency model is four rules the rest of the module reads from, and each is pinned
 * here against the document rather than against any view: reads normalize junk (a hand-written
 * fence may carry numbers, repeats, the card itself), edges run blocker → dependent and only
 * between cards that exist, the guarded write refuses a whole list that would close a loop (and
 * costs no step of undo when it does), and missing ids are reported rather than silently dropped.
 * The links are geometry, and their assertions are the elbow's endpoints: out of the blocker's
 * right edge, into the dependent's left edge, at the row heights the two time views draw with.
 */
import { describe, expect, it } from 'vitest'
import {
  kanbanDependencyEdges,
  kanbanDependencyIds,
  kanbanDependencyLinks,
  kanbanDependencyWouldCycle,
  kanbanTimelineBarMap,
  missingKanbanDependencyIds,
  withKanbanDependenciesGuarded,
} from './dependencies'
import type { TimelineRange } from './timeline-helpers'
import type { KanbanItem } from './types'

function item(id: string, dependsOn?: unknown): KanbanItem {
  const base: KanbanItem = { id, title: id.toUpperCase(), properties: {} }
  return dependsOn === undefined ? base : { ...base, dependsOn: dependsOn as string[] }
}

describe('kanbanDependencyIds reads what a card waits for, normalized', () => {
  it('returns the ids as written when the list is already clean', () => {
    expect(kanbanDependencyIds(item('a', ['b', 'c']))).toEqual(['b', 'c'])
  })

  it('drops numbers, blanks, repeats and the card itself instead of crashing or passing them on', () => {
    expect(kanbanDependencyIds(item('a', [1, 'b', '', 'b', 'a', null, 'c']))).toEqual(['b', 'c'])
  })

  it('reads a card without the field as waiting for nothing, and never invents the key', () => {
    const plain = item('a')
    expect(kanbanDependencyIds(plain)).toEqual([])
    expect('dependsOn' in plain).toBe(false)
  })
})

describe('kanbanDependencyEdges runs blocker to dependent, between cards that exist', () => {
  it('turns a dependsOn list into edges that point at the lister', () => {
    const items = [item('a'), item('b', ['a']), item('c', ['a', 'b'])]
    expect(kanbanDependencyEdges(items)).toEqual([
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ])
  })

  it('never names a card the board does not have', () => {
    const items = [item('a', ['ghost'])]
    expect(kanbanDependencyEdges(items)).toEqual([])
  })
})

describe('missingKanbanDependencyIds reports blockers the board has lost', () => {
  it('lists each missing id once, however many cards wait on it', () => {
    const items = [item('a', ['ghost', 'x']), item('b', ['ghost'])]
    expect(missingKanbanDependencyIds(items)).toEqual(['ghost', 'x'])
  })

  it('says nothing when every named blocker is on the board', () => {
    expect(missingKanbanDependencyIds([item('a'), item('b', ['a'])])).toEqual([])
  })
})

describe('kanbanDependencyWouldCycle', () => {
  it('sees a self-reference as the shortest loop', () => {
    expect(kanbanDependencyWouldCycle([item('a')], 'a', 'a')).toBe(true)
  })

  it('walks the chain: a waits on b, b waits on c, so c cannot wait on a', () => {
    const items = [item('a', ['b']), item('b', ['c']), item('c')]
    expect(kanbanDependencyWouldCycle(items, 'c', 'a')).toBe(true)
  })

  it('allows an edge that leaves the graph open', () => {
    const items = [item('a', ['b']), item('b'), item('c')]
    expect(kanbanDependencyWouldCycle(items, 'c', 'a')).toBe(false)
  })
})

describe('withKanbanDependenciesGuarded writes the list whole or not at all', () => {
  it('writes a clean list onto the named card alone', () => {
    const items = [item('a'), item('b'), item('c')]
    const next = withKanbanDependenciesGuarded(items, 'b', ['a', 'c'])
    expect(next[1]!.dependsOn).toEqual(['a', 'c'])
    expect(next[0]!.dependsOn).toBeUndefined()
  })

  it('filters junk before it reaches the document', () => {
    const items = [item('a'), item('b')]
    const next = withKanbanDependenciesGuarded(items, 'b', ['a', 'ghost', 'a', 'b', '', 3 as unknown as string])
    expect(next[1]!.dependsOn).toEqual(['a'])
  })

  it('clears the key instead of leaving an empty array behind', () => {
    const items = [item('a'), item('b', ['a'])]
    const next = withKanbanDependenciesGuarded(items, 'b', [])
    expect(next[1]!.dependsOn).toBeUndefined()
  })

  it('clearing a card that never had the key changes nothing at all', () => {
    const items = [item('a'), item('b')]
    expect(withKanbanDependenciesGuarded(items, 'b', [])).toBe(items)
  })

  it('refuses the whole list when it would close a loop, and costs no undo step', () => {
    // a waits on b already; b taking on a as a blocker closes a → b → a.
    const items = [item('a', ['b']), item('b'), item('c')]
    expect(withKanbanDependenciesGuarded(items, 'b', ['a', 'c'])).toBe(items)
  })

  it('lets a card keep a dependency it already had: keeping is not a new edge', () => {
    const items = [item('a', ['b']), item('b')]
    const next = withKanbanDependenciesGuarded(items, 'a', ['b'])
    expect(next[0]!.dependsOn).toEqual(['b'])
    expect(next).not.toBe(items)
  })

  it('names no card the board does not have', () => {
    const items = [item('a'), item('b')]
    const next = withKanbanDependenciesGuarded(items, 'b', ['ghost'])
    expect(next[1]!.dependsOn).toBeUndefined()
  })
})

const ROW = 40
const range: TimelineRange = {
  days: Array.from({ length: 10 }, (_, i) => ({ dateStr: `2026-09-${10 + i}`, label: '', isToday: i === 4 })),
  dayWidth: 48,
  todayIndex: 4,
  clipped: false,
}

describe('kanbanDependencyLinks draws blocker right edge to dependent left edge', () => {
  it('skips an edge whose card has no bar on this window', () => {
    const items = [{ ...item('a'), properties: { startDate: '2026-09-10' } }, item('b', ['a'])]
    expect(kanbanDependencyLinks(items, range)).toEqual([])
  })

  it('runs from the blocker right edge to the dependent left edge, at the rows they stand in', () => {
    const items = [
      { ...item('a'), properties: { startDate: '2026-09-10', endDate: '2026-09-12' } },
      { ...item('b', ['a']), properties: { startDate: '2026-09-14', endDate: '2026-09-16' } },
    ]
    const [link] = kanbanDependencyLinks(items, range)
    expect(link).toBeDefined()
    expect(link!.fromId).toBe('a')
    expect(link!.toId).toBe('b')
    // a's bar: left = day 0 × 48 + the 4px offset; its right edge = left + (3 days × 48 − the 8px
    // gap) = 140. b's bar starts at day 4 × 48 + the 4px offset = 196.
    expect(link!.path).toContain(`M ${4 + 3 * 48 - 8} ${ROW / 2}`)
    expect(link!.path).toContain(`H ${4 * 48 + 4}`)
    // The arrowhead lands at b's own row middle: row 1 × 40 + 20.
    expect(link!.arrow).toBe(`M ${4 * 48 + 4} ${ROW + ROW / 2} l 7 -4.5 v 9 Z`)
  })

  it('bows out to the right so an arrow never crosses the bars it joins', () => {
    const items = [
      { ...item('a'), properties: { startDate: '2026-09-10', endDate: '2026-09-16' } },
      { ...item('b', ['a']), properties: { startDate: '2026-09-12', endDate: '2026-09-14' } },
    ]
    const [link] = kanbanDependencyLinks(items, range)
    expect(link).toBeDefined()
    const midX = Math.max(...[...link!.path.matchAll(/H (\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])))
    // a's right edge: day 0 start + 7 days × 48 − the 8px gap.
    expect(midX).toBeGreaterThan(7 * 48 - 8)
  })
})

describe('the bars a view hands its dependency layer', () => {
  it('draws the same arrows from bars handed in as it would from bars it measures itself', () => {
    const items = [
      { ...item('a'), properties: { startDate: '2026-09-10', endDate: '2026-09-12' } },
      { ...item('b', ['a']), properties: { startDate: '2026-09-14', endDate: '2026-09-16' } },
    ]
    // What the view hands the layer: the map it already built to draw the rows with.
    const measured = kanbanTimelineBarMap(items, range)
    expect(kanbanDependencyLinks(items, range, undefined, measured)).toEqual(kanbanDependencyLinks(items, range))
  })
})
