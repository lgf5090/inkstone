import { describe, expect, it } from 'vitest'
import type { ProjectBoardBundle } from './model'
import { emptyProjectViewFields } from './model'
import { projectBoardToMarkdown } from './markdown'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 10, updateAt: 20, deleteAt: 0 }

function fixture(): ProjectBoardBundle {
  return {
    board: { id: 'b1', ownerId: 'u1', type: 'P', minimumRole: '', title: 'Roadmap', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, ...stamps },
    properties: [
      { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }] },
      { id: 'pp', name: 'Assignee', type: 'person', options: [] },
      { id: 'pm', name: 'Watchers', type: 'multiPerson', options: [] },
    ],
    views: [{ id: 'v1', boardId: 'b1', title: 'V', viewType: 'table', fields: emptyProjectViewFields(), position: 0, ...stamps }],
    cards: [{ id: 'c1', boardId: 'b1', parentId: '', title: 'Ship it', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1', pp: 'u2', pm: '["u2","u3"]' }, ...stamps }],
    contents: [], comments: [], members: [],
    people: { u2: { id: 'u2', name: 'Uri', avatarUrl: '' }, u3: { id: 'u3', name: 'Ada', avatarUrl: '' } },
    role: 'admin', cursor: 20,
  }
}

describe('Markdown export', () => {
  it('names people instead of printing their ids', () => {
    const markdown = projectBoardToMarkdown(fixture())
    expect(markdown).toContain('- **Assignee**: Uri')
    expect(markdown).toContain('- **Watchers**: Uri, Ada')
    expect(markdown).not.toContain('u2')
    expect(markdown).not.toContain('u3')
  })

  it('still labels select values and groups by the chosen property', () => {
    const markdown = projectBoardToMarkdown(fixture(), 'ps')
    expect(markdown).toContain('## Open')
    expect(markdown).toContain('- **Status**: Open')
    expect(markdown).toContain('### Ship it')
  })
})