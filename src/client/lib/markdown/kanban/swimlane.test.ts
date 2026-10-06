/**
 * F-10. A swimlane is a second grouping: the columns stay what they are and the cards are also cut
 * into horizontal bands by another field. Both answers have to come out of the same derivation as
 * the plain board, otherwise a card counted in a band and a card counted in a column drift apart —
 * so these cases read the bands back from `groupKanbanItems` behaviour they share with it.
 *
 * The band a card sits in is a fact about the card (it is that field's value), so dropping a card
 * into another band is a write of that field as much as it is a write of the column: one gesture,
 * one step of undo.
 */
import { describe, expect, it } from 'vitest'
import { kanbanSwimlanes, moveKanbanItemToCell, moveKanbanItemsToCell } from './swimlane'
import type { KanbanCellsMove } from './swimlane'
import type { KanbanItem, KanbanProperty } from './types'

const ownerColumn: KanbanProperty = {
  id: 'owner',
  name: 'Owner',
  type: 'select',
  options: [
    { id: 'alice', label: 'Alice', color: 'blue' },
    { id: 'bob', label: 'Bob', color: 'green' },
  ],
}

const statusColumn: KanbanProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'todo', label: 'To Do', color: 'gray' },
    { id: 'doing', label: 'In Progress', color: 'blue' },
  ],
}

function card(id: string, properties: Record<string, unknown>): KanbanItem {
  return { id, title: `Card ${id}`, properties }
}

const layout = {
  groupPropertyId: 'status',
  groupProperty: statusColumn,
  lanePropertyId: 'owner',
  laneProperty: ownerColumn,
}

describe('the bands a board cuts itself into', () => {
  it('answers nothing about lanes until the view asks for one field over another', () => {
    expect(kanbanSwimlanes([card('a', { status: 'todo', owner: 'alice' })], { ...layout, lanePropertyId: undefined })).toEqual([])
  })

  it('gives one band per option, in the order the field lists them', () => {
    const bands = kanbanSwimlanes([
      card('b1', { status: 'todo', owner: 'bob' }),
      card('a1', { status: 'todo', owner: 'alice' }),
    ], layout)
    expect(bands.map((band) => band.lane.groupKey)).toEqual(['alice', 'bob'])
    expect(bands.map((band) => band.lane.label)).toEqual(['Alice', 'Bob'])
  })

  it('puts cards nobody owns in an unassigned band, the same column that groups them does', () => {
    const bands = kanbanSwimlanes([
      card('a1', { status: 'todo', owner: 'alice' }),
      card('n1', { status: 'todo' }),
    ], layout)
    const unassigned = bands.find((band) => band.lane.groupKey === '__none__')
    expect(unassigned?.lane.items.map((item) => item.id)).toEqual(['n1'])
  })

  it('reads a band off a label the way the columns read a group', () => {
    const bands = kanbanSwimlanes([card('a1', { status: 'todo', owner: 'ALICE' })], layout)
    expect(bands.find((band) => band.lane.groupKey === 'alice')?.lane.items.map((i) => i.id)).toEqual(['a1'])
  })
})

describe('what each band answers about every column', () => {  it('cuts each band into every column of the board, empty ones included', () => {
    const bands = kanbanSwimlanes([card('a1', { status: 'todo', owner: 'alice' })], layout)
    const alice = bands.find((band) => band.lane.groupKey === 'alice')!
    expect(alice.columns.map((group) => [group.groupKey, group.items.length])).toEqual([
      ['todo', 1],
      ['doing', 0],
    ])
  })

  it('keeps a band rule the column it belongs to set', () => {
    const limited: KanbanProperty = {
      ...statusColumn,
      options: [{ id: 'todo', label: 'To Do', color: 'gray', wipLimit: 1 }, { id: 'doing', label: 'In Progress', color: 'blue' }],
    }
    const bands = kanbanSwimlanes([
      card('a1', { status: 'todo', owner: 'alice' }),
      card('a2', { status: 'todo', owner: 'alice' }),
    ], { ...layout, groupProperty: limited })
    expect(bands[0]!.columns[0]!.wipLimit).toBe(1)
  })

  it('leaves a field that offers no options with a single unassigned band', () => {
    const freeText: KanbanProperty = { id: 'owner', name: 'Owner', type: 'text' }
    const bands = kanbanSwimlanes([card('a1', { status: 'todo', owner: 'alice' })], { ...layout, laneProperty: freeText })
    expect(bands.map((band) => band.lane.groupKey)).toEqual(['__none__'])
  })
})

describe('moving a card into one cell of the grid', () => {
  it('writes the column and the band in one step', () => {
    const next = moveKanbanItemToCell([card('a1', { status: 'todo', owner: 'alice' })], {
      itemId: 'a1',
      cell: { groupKey: 'doing', laneKey: 'bob' },
      layout,
    })
    expect(next[0]!.properties).toEqual({ status: 'doing', owner: 'bob' })
  })

  it('takes a card out of the field when the drop lands it in the unassigned band', () => {
    const next = moveKanbanItemToCell([card('a1', { status: 'todo', owner: 'alice' })], {
      itemId: 'a1',
      cell: { groupKey: 'todo', laneKey: '__none__' },
      layout,
    })
    expect('owner' in next[0]!.properties).toBe(false)
    expect(next[0]!.properties.status).toBe('todo')
  })

  it('leaves the band alone when the board is not cut into bands', () => {
    const next = moveKanbanItemToCell([card('a1', { status: 'todo', owner: 'alice' })], {
      itemId: 'a1',
      cell: { groupKey: 'doing' },
      layout: { ...layout, lanePropertyId: undefined },
    })
    expect(next[0]!.properties).toEqual({ status: 'doing', owner: 'alice' })
  })

  it('does not invent a band value for a field the view never named', () => {
    const next = moveKanbanItemToCell([card('a1', { status: 'todo' })], {
      itemId: 'a1',
      cell: { groupKey: 'doing', laneKey: 'bob' },
      layout: { ...layout, lanePropertyId: undefined },
    })
    expect('owner' in next[0]!.properties).toBe(false)
  })
})

/**
 * KU-22. The drag a batch makes: every picked card lands in the dropped cell, and the one the reader
 * held takes the place under the pointer. Only the held card may take a pivot — the pointer named one
 * spot — so the rest keep the order they already had.
 */
describe('moving a batch of cards into one cell of the grid', () => {
  it('writes the cell on every picked card, and only the held one takes the place under the pointer', () => {
    const next = moveKanbanItemsToCell(
      [card('a1', { status: 'todo', owner: 'alice' }), card('a2', { status: 'todo', owner: 'alice' }), card('b1', { status: 'doing', owner: 'bob' })],
      {
        itemIds: ['a1', 'a2'],
        anchorId: 'a2',
        cell: { groupKey: 'doing', laneKey: 'bob' },
        pivot: { itemId: 'b1', position: 'after' },
        layout,
      },
    )
    expect(next.map((item) => item.properties)).toEqual([
      { status: 'doing', owner: 'bob' },
      { status: 'doing', owner: 'bob' },
      { status: 'doing', owner: 'bob' },
    ])
    // The rule is about the held card: it sits beside the card it was dropped on. The other picked
    // card is appended to the same column rather than given a place of its own, which is what leaves
    // it after the anchor here — the batch keeps its order, it does not reverse it.
    expect(next.map((item) => item.id)).toEqual(['b1', 'a2', 'a1'])
    expect(next.findIndex((item) => item.id === 'a2')).toBe(next.findIndex((item) => item.id === 'b1') + 1)
  })

  it('moves a batch of one exactly where the single drop would put it', () => {
    const items = [card('a1', { status: 'todo' }), card('b1', { status: 'doing' })]
    const move = { itemId: 'a1', cell: { groupKey: 'doing' }, pivot: { itemId: 'b1', position: 'after' as const }, layout }
    const single = moveKanbanItemToCell(items, move)
    const batch = moveKanbanItemsToCell(items, { ...move, itemIds: ['a1'], anchorId: 'a1' })
    expect(batch.map((item) => item.id)).toEqual(single.map((item) => item.id))
  })
})

describe('where a card that moved lands within the column it lands in', () => {
  it('still inserts beside the card the drop was anchored to', () => {
    const next = moveKanbanItemToCell([
      card('b1', { status: 'doing', owner: 'bob' }),
      card('b2', { status: 'doing', owner: 'bob' }),
      card('a1', { status: 'todo', owner: 'alice' }),
    ], {
      itemId: 'a1',
      cell: { groupKey: 'doing', laneKey: 'bob' },
      pivot: { itemId: 'b2', position: 'after' },
      layout,
    })
    expect(next.map((item) => item.id)).toEqual(['b1', 'b2', 'a1'])
    expect(next[2]!.properties).toEqual({ status: 'doing', owner: 'bob' })
  })

  it('leaves a card that only changed band standing where it was in its column', () => {
    const next = moveKanbanItemToCell([
      card('a1', { status: 'todo', owner: 'alice' }),
      card('a2', { status: 'todo', owner: 'alice' }),
      card('a3', { status: 'todo', owner: 'alice' }),
    ], { itemId: 'a1', cell: { groupKey: 'todo', laneKey: 'bob' }, layout })
    expect(next.map((item) => item.id)).toEqual(['a1', 'a2', 'a3'])
    expect(next[0]!.properties).toEqual({ status: 'todo', owner: 'bob' })
  })

  it('leaves a card in the no-status column it already sits in when it only changes band', () => {
    const next = moveKanbanItemToCell([
      card('n1', { owner: 'alice' }),
      card('n2', { owner: 'alice' }),
    ], { itemId: 'n1', cell: { groupKey: '__none__', laneKey: 'bob' }, layout })
    expect(next.map((item) => item.id)).toEqual(['n1', 'n2'])
    expect(next[0]!.properties).toEqual({ owner: 'bob' })
  })
})

describe('a drop that touches only one coordinate of the cell', () => {
  it('keeps the band when the drop lands on the column itself', () => {
    const next = moveKanbanItemToCell([card('a1', { status: 'todo', owner: 'alice' })], {
      itemId: 'a1',
      cell: { groupKey: 'doing' },
      layout,
    })
    expect(next[0]!.properties).toEqual({ status: 'doing', owner: 'alice' })
  })

  it('answers with the same list when the card is nowhere to be found', () => {
    const items = [card('a1', { status: 'todo', owner: 'alice' })]
    expect(moveKanbanItemToCell(items, { itemId: 'ghost', cell: { groupKey: 'doing', laneKey: 'bob' }, layout })).toBe(items)
  })
})

/** The reference: exactly what the batch mover did before it walked a list — one card at a time. */
function batchCardByCard(items: KanbanItem[], move: KanbanCellsMove): KanbanItem[] {
  return move.itemIds.reduce(
    (next, itemId) => moveKanbanItemToCell(next, {
      itemId,
      cell: move.cell,
      pivot: itemId === move.anchorId ? move.pivot : undefined,
      layout: move.layout,
    }),
    items,
  )
}

/** Deterministic replacement for `Math.random`, so a failure replays the exact board that failed. */
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const STATUSES = ['todo', 'doing', 'done', undefined]
const OWNERS = ['alice', 'bob', undefined]
const GROUPS = ['todo', 'doing', 'done', '__none__']
const LANES = ['alice', 'bob', '__none__', undefined]

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

/** One random round: a small board, a random subset picked in a random order, a random drop. */
function randomBatchCase(random: () => number): { items: KanbanItem[]; move: KanbanCellsMove } {
  const count = 1 + Math.floor(random() * 12)
  const items = Array.from({ length: count }, (_, index) => {
    const properties: Record<string, unknown> = { status: pick(random, STATUSES) }
    if (random() < 0.85) properties.owner = pick(random, OWNERS)
    return card(`item-${index}`, properties)
  })
  const ids = items.map((item) => item.id)
  const picked = ids.filter(() => random() < 0.5)
  const anchor = pick(random, picked.length > 0 ? picked : [ids[0]!])
  const move: KanbanCellsMove = {
    itemIds: picked.length > 0 ? picked : [ids[0]!],
    anchorId: anchor,
    cell: { groupKey: pick(random, GROUPS), ...(random() < 0.7 ? { laneKey: pick(random, LANES) } : {}) },
    ...(random() < 0.7
      ? { pivot: { itemId: pick(random, [...ids, 'ghost']), position: random() < 0.5 ? ('before' as const) : ('after' as const) } }
      : {}),
    ...(random() < 0.5 ? { layout } : { layout: { ...layout, lanePropertyId: undefined, laneProperty: undefined } }),
  }
  return { items, move }
}

/**
 * The batch mover walks a linked list rather than re-running the whole document through the
 * single-card mover per picked card. What must not change is the answer, so the reference here is
 * the walk itself — one card at a time, exactly as the reduce used to — and hundreds of random
 * boards, batches, cells and pivots have to come out identical to it, order and property writes alike.
 */
describe('the batch walk agrees with the card-by-card walk it stands in for', () => {
  it('matches it on hundreds of random boards, batches and drops', () => {
    const random = mulberry32(20260925)
    for (let round = 0; round < 400; round++) {
      const { items, move } = randomBatchCase(random)
      const batch = moveKanbanItemsToCell(items, move)
      const reference = batchCardByCard(items, move)
      expect(batch, `round ${round}: ids ${JSON.stringify(move)}`).toStrictEqual(reference)
    }
  })
})
