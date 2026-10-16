/**
 * The notes one link away.
 *
 * What is pinned here is the shaping, not the SQL: a note does not relate to itself, a note reached from two
 * seeds is listed once, outbound beats inbound when both exist (a note's own "see also" is the stronger
 * signal), and the list is capped so a hub note does not hand the model the whole vault.
 *
 * The query itself is exercised where the notes are: this module's only judgement is which rows survive.
 */
import { describe, expect, it } from 'vitest'
import { NEIGHBOUR_LIMIT, rankNeighbours } from '../src/worker/assistant/note-graph'

const SEED = '01hzzzzzzzzzzzzzzzzzzzzz11'
const A = '01hzzzzzzzzzzzzzzzzzzzzz21'
const B = '01hzzzzzzzzzzzzzzzzzzzzz22'

describe('one hop from a search hit', () => {
  it('drops the seed and keeps the direction it was found in', () => {
    const rows = [
      { id: SEED, title: 'the hit itself', via: 'x', direction: 'outbound' },
      { id: A, title: 'the plan', via: 'Quarterly', direction: 'outbound' },
      { id: B, title: 'the retro', via: 'Quarterly', direction: 'inbound' },
    ]
    expect(rankNeighbours(rows, new Set([SEED]))).toEqual([
      { id: A, title: 'the plan', via: 'Quarterly', direction: 'outbound' },
      { id: B, title: 'the retro', via: 'Quarterly', direction: 'inbound' },
    ])
  })

  it('lists a note once, keeping the first reason it was reached', () => {
    const rows = [
      { id: A, title: 'the plan', via: 'Quarterly', direction: 'outbound' },
      { id: A, title: 'the plan', via: 'Weekly', direction: 'inbound' },
    ]
    expect(rankNeighbours(rows, new Set([SEED]))).toHaveLength(1)
    expect(rankNeighbours(rows, new Set([SEED]))[0]!.direction).toBe('outbound')
  })

  it('caps the list, because a hub note links to everything', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      id: `01hzzzzzzzzzzzzzzzzzzzzz${30 + index}`,
      title: `n${index}`,
      via: 'hub',
      direction: 'outbound',
    }))
    expect(rankNeighbours(rows, new Set([SEED]))).toHaveLength(NEIGHBOUR_LIMIT)
  })

  it('skips a row with no id rather than listing an unnamed note', () => {
    expect(rankNeighbours([{ id: '', title: 'ghost', via: 'x', direction: 'outbound' }], new Set())).toEqual([])
  })
})
