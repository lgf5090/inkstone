import { describe, expect, it } from 'vitest'
import { kanbanPeopleDirectory, kanbanPersonCandidates, kanbanPersonInitials, kanbanPersonName } from './person'
import type { KanbanItem, KanbanProperty } from './types'

const personColumn: KanbanProperty = { id: 'assignee', name: 'Assignee', type: 'person' }

function card(id: string, assignee?: unknown): KanbanItem {
  return { id, title: id, properties: assignee === undefined ? {} : { assignee } }
}

describe('how a person value is read back', () => {
  it('keeps the name the author typed, without the surrounding blanks', () => {
    expect(kanbanPersonName('  Bob Jones ')).toBe('Bob Jones')
  })

  it('calls anything blank nobody', () => {
    expect(kanbanPersonName(undefined)).toBe('')
    expect(kanbanPersonName(null)).toBe('')
    expect(kanbanPersonName('   ')).toBe('')
  })

  it('reads a number as the name it spells', () => {
    expect(kanbanPersonName(7)).toBe('7')
  })

  it('refuses to spell an object as a name', () => {
    expect(kanbanPersonName({})).toBe('')
    expect(kanbanPersonName(true)).toBe('')
    expect(kanbanPersonName(['Alice', 'Bob'])).toBe('')
  })
})

describe('the two letters an avatar shows', () => {
  it('shows the first two letters the cards have always shown', () => {
    expect(kanbanPersonInitials('Alice')).toBe('AL')
    expect(kanbanPersonInitials('bob jones')).toBe('BO')
  })

  it('has nothing to show for nobody', () => {
    expect(kanbanPersonInitials('')).toBe('')
  })
})

describe('the roster a picker offers', () => {
  it('offers the people the board already uses, busiest first', () => {
    const items = [card('a', 'Alice'), card('b', 'Bob'), card('c', 'Bob'), card('d', 'Cara')]
    expect(kanbanPersonCandidates(personColumn, items)).toEqual(['Bob', 'Alice', 'Cara'])
  })

  it('keeps a tie between equally busy people in the order they first appear', () => {
    const items = [card('a', 'Zoe'), card('b', 'Amy'), card('c', 'Ivy')]
    expect(kanbanPersonCandidates(personColumn, items)).toEqual(['Zoe', 'Amy', 'Ivy'])
  })

  it('counts a difference in case or blanks as the same person, spelled as it was first seen', () => {
    const items = [card('a', 'ada'), card('b', 'Ada'), card('c', 'Ivy'), card('d', ' ADA ')]
    expect(kanbanPersonCandidates(personColumn, items)).toEqual(['ada', 'Ivy'])
  })

  it('skips the cards nobody is on', () => {
    const items = [card('a', 'Alice'), card('b'), card('c', '   '), card('d', {})]
    expect(kanbanPersonCandidates(personColumn, items)).toEqual(['Alice'])
  })

  it('offers nobody for a column that holds no people or does not exist', () => {
    expect(kanbanPersonCandidates(personColumn, [card('a', true), card('b', {}), card('c', [])])).toEqual([])
    expect(kanbanPersonCandidates(undefined, [card('a', 'Alice')])).toEqual([])
  })
})

describe('the directory an author declares for a member column', () => {
  it('puts the directory the author declared ahead of whoever the cards name', () => {
    const column: KanbanProperty = {
      ...personColumn,
      options: [
        { id: 'ann', label: 'Ann', color: 'blue' },
        { id: 'bo', label: 'Bo', color: 'green' },
      ],
    }
    const items = [card('a', 'Bo'), card('b', 'Bo'), card('c', 'Cyd')]
    expect(kanbanPersonCandidates(column, items)).toEqual(['Ann', 'Bo', 'Cyd'])
  })

  it('names a declared member by the option id when the label is blank', () => {
    const column: KanbanProperty = {
      ...personColumn,
      options: [{ id: 'u-9', label: '  ', color: 'gray' }],
    }
    expect(kanbanPersonCandidates(column, [])).toEqual(['u-9'])
  })
})

describe('the roster of every member column at once', () => {
  it('answers for every member column of the board at once', () => {
    const reviewer: KanbanProperty = { id: 'reviewer', name: 'Reviewer', type: 'person' }
    const status: KanbanProperty = { id: 'status', name: 'Status', type: 'select' }
    const items: KanbanItem[] = [
      { id: 'a', title: 'A', properties: { assignee: 'Alice', reviewer: 'Ann', status: 'todo' } },
      { id: 'b', title: 'B', properties: { assignee: 'Bob', reviewer: 'Ann' } },
    ]
    const directory = kanbanPeopleDirectory([personColumn, reviewer, status], items)
    expect(directory).toEqual({ assignee: ['Alice', 'Bob'], reviewer: ['Ann'] })
    expect(kanbanPeopleDirectory([status], [])).toEqual({})
  })
})
