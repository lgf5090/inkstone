import { describe, expect, it } from 'vitest'
import type { InknotePageContent, InknoteStroke } from '@shared/inknote/types'
import { applyTimelineEvent, snapshotReplayPages, strokeEventsForCommit, trimTimeline } from './timeline'

function stroke(id: string): InknoteStroke {
  return { id, tool: 'pen', style: 'normal', shape: null, color: '#111111', width: 2, points: [{ x: 1, y: 2, p: 0.5 }] }
}

function page(strokes: InknoteStroke[]): InknotePageContent {
  return { format: 'inknote-page', version: 1, strokes, texts: [], images: [], bg: null }
}

const json = (strokes: InknoteStroke[]) => JSON.stringify(page(strokes))

describe('strokeEventsForCommit', () => {
  it('turns a new stroke into one event', () => {
    const events = strokeEventsForCommit(json([]), json([stroke('a')]), 'p1', 100)
    expect(events).toEqual([{ t: 100, type: 'stroke', pageId: 'p1', data: stroke('a') }])
  })

  it('turns an erased stroke into an erase event, and a pixel erase into erase plus additions', () => {
    expect(strokeEventsForCommit(json([stroke('a')]), json([]), 'p1', 5)).toEqual([{ t: 5, type: 'erase', pageId: 'p1', data: { ids: ['a'] } }])
    const split = strokeEventsForCommit(json([stroke('a')]), json([stroke('a-left'), stroke('a-right')]), 'p1', 6)
    expect(split).toEqual([
      { t: 6, type: 'erase', pageId: 'p1', data: { ids: ['a'] } },
      { t: 6, type: 'stroke', pageId: 'p1', data: stroke('a-left') },
      { t: 6, type: 'stroke', pageId: 'p1', data: stroke('a-right') },
    ])
  })

  it('ignores text and image edits and unreadable snapshots', () => {
    expect(strokeEventsForCommit('bad', json([]), 'p1', 1)).toEqual([])
    expect(strokeEventsForCommit(json([]), json([]), 'p1', 1)).toEqual([])
  })
})

describe('applyTimelineEvent', () => {
  it('adds an unknown stroke once and removes erased ids', () => {
    const start = page([])
    const added = applyTimelineEvent(start, { t: 1, type: 'stroke', pageId: 'p1', data: stroke('a') })
    expect(added.strokes.map((entry) => entry.id)).toEqual(['a'])
    expect(applyTimelineEvent(added, { t: 2, type: 'stroke', pageId: 'p1', data: stroke('a') })).toBe(added)
    const erased = applyTimelineEvent(added, { t: 3, type: 'erase', pageId: 'p1', data: { ids: ['a'] } })
    expect(erased.strokes).toEqual([])
    expect(applyTimelineEvent(start, { t: 4, type: 'page', pageId: 'p2', data: { to: 1 } })).toBe(start)
  })
})

describe('snapshotReplayPages and trimTimeline', () => {
  it('deep-copies pages so a replay cannot edit the live objects', () => {
    const live = page([stroke('a')])
    const snapshot = snapshotReplayPages([{ id: 'p1', content: live }])
    live.strokes.push(stroke('b'))
    expect(snapshot.get('p1')!.strokes.map((entry) => entry.id)).toEqual(['a'])
  })

  it('trims events at the byte budget instead of sending a refused timeline', () => {
    const events = Array.from({ length: 100 }, (_, index) => ({ t: index, type: 'stroke' as const, pageId: 'p1', data: stroke(`s${index}`) }))
    const kept = trimTimeline(events, 1_000)
    expect(kept.length).toBeLessThan(events.length)
    expect(JSON.stringify(kept).length * 2).toBeLessThanOrEqual(1_000)
  })
})
