import { describe, expect, it } from 'vitest'
import {
  kanbanActiveItems,
  kanbanArchivedItems,
  kanbanDeletedItems,
  kanbanIsArchived,
  kanbanIsDeleted,
  kanbanPurgeDeleted,
  kanbanSetArchived,
  kanbanSetDeleted,
} from './archive'
import type { KanbanItem } from './types'

function card(id: string, extra: Partial<KanbanItem> = {}): KanbanItem {
  return { id, title: `Card ${id}`, properties: { status: 'todo' }, ...extra }
}

const mixed = [card('a'), card('b', { archived: true }), card('c', { archived: false })]
const deletedBoard = [card('a'), card('b', { deleted: true }), card('c', { archived: true, deleted: true })]

describe('what counts as an archived card', () => {
  it('archives a card only on a literal true', () => {
    expect(kanbanIsArchived(card('x', { archived: true }))).toBe(true)
    expect(kanbanIsArchived(card('x', { archived: false }))).toBe(false)
    expect(kanbanIsArchived(card('x'))).toBe(false)
  })

  it('splits a board into the cards it works on and the cards it filed away', () => {
    expect(kanbanActiveItems(mixed).map((item) => item.id)).toEqual(['a', 'c'])
    expect(kanbanArchivedItems(mixed).map((item) => item.id)).toEqual(['b'])
  })
})

describe('what counts as a deleted card', () => {
  it('deletes a card only on a literal true', () => {
    expect(kanbanIsDeleted(card('x', { deleted: true }))).toBe(true)
    expect(kanbanIsDeleted(card('x', { deleted: false }))).toBe(false)
    expect(kanbanIsDeleted(card('x'))).toBe(false)
  })

  it('a deleted card is out of every view and out of the archive shelf, whichever flag it also wears', () => {
    expect(kanbanActiveItems(deletedBoard).map((item) => item.id)).toEqual(['a'])
    expect(kanbanArchivedItems(deletedBoard).map((item) => item.id)).toEqual([])
    expect(kanbanDeletedItems(deletedBoard).map((item) => item.id)).toEqual(['b', 'c'])
  })

  it('flags cards out of the views in one idempotent batch, and leaves no key behind on restore', () => {
    const next = kanbanSetDeleted(mixed, ['a', 'ghost'], true)
    expect(kanbanDeletedItems(next).map((item) => item.id)).toEqual(['a'])
    expect(next[1]).toBe(mixed[1])
    const restored = kanbanSetDeleted(next, ['a'], false).find((item) => item.id === 'a')!
    expect('deleted' in restored).toBe(false)
    expect(kanbanSetDeleted(mixed, ['a'], false)).toBe(mixed)
  })

  it('purge removes deleted cards for good, never the live ones, and no-ops on nothing to purge', () => {
    expect(kanbanPurgeDeleted(deletedBoard, ['ghost']).map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(kanbanPurgeDeleted(deletedBoard, ['b']).map((item) => item.id)).toEqual(['a', 'c'])
    expect(kanbanPurgeDeleted(deletedBoard).map((item) => item.id)).toEqual(['a'])
    expect(kanbanPurgeDeleted(mixed)).toBe(mixed)
  })
})

describe('archiving and restoring a set of cards', () => {
  it('touches only the named cards and keeps the rest of the document by reference', () => {
    const next = kanbanSetArchived(mixed, ['a', 'ghost'], true)
    expect(kanbanArchivedItems(next).map((item) => item.id)).toEqual(['a', 'b'])
    expect(next[2]).toBe(mixed[2])
    expect(kanbanIsArchived(next[2]!)).toBe(false)
  })

  it('leaves no archived key behind once a card is restored', () => {
    const next = kanbanSetArchived(mixed, ['b'], false)
    const restored = next.find((item) => item.id === 'b')!
    expect('archived' in restored).toBe(false)
    expect(restored.properties).toEqual({ status: 'todo' })
  })

  it('writes nothing when the cards already are what the batch asked for', () => {
    expect(kanbanSetArchived(mixed, ['b'], true)).toBe(mixed)
    expect(kanbanSetArchived(mixed, ['a'], false)).toBe(mixed)
    expect(kanbanSetArchived(mixed, [], true)).toBe(mixed)
  })

  it('leaves a hand-written `archived: false` alone: it already reads as active', () => {
    expect(kanbanSetArchived(mixed, ['c'], false)).toBe(mixed)
    expect(kanbanSetArchived(mixed, ['c'], true).find((item) => item.id === 'c')).toMatchObject({ archived: true })
  })

  it('ignores ids the board does not hold', () => {
    expect(kanbanSetArchived(mixed, ['ghost'], true)).toBe(mixed)
  })
})
