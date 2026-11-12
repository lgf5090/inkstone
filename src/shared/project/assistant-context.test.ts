import { describe, expect, it } from 'vitest'
import type { ProjectBoardBundle } from './model'
import { emptyProjectViewFields } from './model'
import { buildProjectAssistantFacts, MAX_PROJECT_CONTEXT_CARDS } from './assistant-context'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
function bundle(cardCount: number): ProjectBoardBundle {
  return {
    board: { id: 'b1', ownerId: 'u1', type: 'P', minimumRole: '', title: 'Roadmap', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, archived: false, ...stamps },
    properties: [{ id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }] }],
    views: [{ id: 'v1', boardId: 'b1', title: 'Board', viewType: 'board', fields: { ...emptyProjectViewFields(), groupById: 'ps' }, position: 0, ...stamps }],
    cards: Array.from({ length: cardCount }, (_, i) => ({ id: `c${i}`, boardId: 'b1', parentId: '', title: `Card ${i}`, icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1' }, ...stamps })),
    contents: [], comments: [], members: [], people: {}, role: 'admin', cursor: 1,
  }
}

describe('project assistant facts', () => {
  it('names the board, counts cards and lists grouped card values', () => {
    const facts = buildProjectAssistantFacts(bundle(2), emptyProjectViewFields())
    expect(facts[0]).toBe('board: Roadmap')
    expect(facts).toContain('cards: 2')
    expect(facts.some((f) => f.startsWith('card: Card 0') && f.includes('Status=Open'))).toBe(true)
  })
  it('caps the card list', () => {
    const facts = buildProjectAssistantFacts(bundle(MAX_PROJECT_CONTEXT_CARDS + 5), emptyProjectViewFields())
    expect(facts.filter((f) => f.startsWith('card:'))).toHaveLength(MAX_PROJECT_CONTEXT_CARDS)
  })
})