import { describe, expect, it } from 'vitest'
import type { ProjectBoardBundle } from './model'
import { emptyProjectViewFields } from './model'
import { parseProjectArchiveLines, serializeProjectArchiveLines, type ProjectArchiveLine } from './archive'
import { projectArchiveLinesToImport, projectBundleToArchiveLines } from './archive-mapping'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 10, updateAt: 20, deleteAt: 0 }

function fixture(): ProjectBoardBundle {
  return {
    board: {
      id: 'b1', ownerId: 'u1', type: 'P', minimumRole: '', title: 'Roadmap', description: 'Desc',
      icon: '🗺️', showDescription: true, isTemplate: false, templateVersion: 0, ...stamps,
    },
    properties: [
      { id: 'p1', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: 'propColorRed' }] },
      { id: 'p2', name: 'Tags', type: 'multiSelect', options: [] },
    ],
    views: [{
      id: 'v1', boardId: 'b1', title: 'Table', viewType: 'table',
      fields: { ...emptyProjectViewFields(), cardOrder: ['c1'], columnWidths: { c1: 200 } },
      position: 0, ...stamps,
    }],
    cards: [{
      id: 'c1', boardId: 'b1', parentId: '', title: 'Card', icon: '📌', isTemplate: false,
      contentOrder: ['a1', ['m1']], values: { p1: 'o1', p2: '["o1","o2"]' }, ...stamps,
    }],
    contents: [
      { id: 'a1', cardId: 'c1', boardId: 'b1', type: 'checkbox', title: 'Step', fields: { checked: true }, position: 0, ...stamps },
    ],
    comments: [{ id: 'm1', cardId: 'c1', boardId: 'b1', authorId: 'u2', body: 'Nice', createAt: 10, updateAt: 20, deleteAt: 0 }],
    members: [{ boardId: 'b1', userId: 'u1', role: 'admin', createdAt: 10, updatedAt: 20 }],
    role: 'admin',
    cursor: 20,
  }
}

describe('archive round trip', () => {
  it('exports a bundle and imports it back field for field', () => {
    const bundle = fixture()
    const lines = projectBundleToArchiveLines(bundle)
    const parsed = parseProjectArchiveLines(serializeProjectArchiveLines(lines))
    const imported = projectArchiveLinesToImport(parsed)
    expect(imported.board).toMatchObject({ id: 'b1', title: 'Roadmap', description: 'Desc', icon: '🗺️', showDescription: true, type: 'P' })
    expect(imported.properties).toEqual(bundle.properties)
    expect(imported.cards[0]).toMatchObject({
      id: 'c1', title: 'Card', icon: '📌', contentOrder: ['a1', ['m1']], values: { p1: 'o1', p2: '["o1","o2"]' },
    })
    expect(imported.views[0]).toMatchObject({ id: 'v1', viewType: 'table', position: 0 })
    expect(imported.views[0]!.fields.cardOrder).toEqual(['c1'])
    expect(imported.views[0]!.fields.columnWidths).toEqual({ c1: 200 })
    expect(imported.contents[0]).toMatchObject({ id: 'a1', cardId: 'c1', type: 'checkbox', fields: { checked: true } })
    expect(imported.comments[0]).toMatchObject({ id: 'm1', cardId: 'c1', authorId: 'u2', body: 'Nice' })
    expect(imported.members).toEqual([{ userId: 'u1', role: 'admin' }])
  })

  it('exports multi-select values as arrays the reference understands', () => {
    const lines = projectBundleToArchiveLines(fixture())
    const card = lines.find((line) => line.type === 'block' && line.data.type === 'card')
    expect(card).toBeDefined()
    const fields = (card as unknown as { data: { fields: { properties: Record<string, unknown> } } }).data.fields
    expect(fields.properties.p2).toEqual(['o1', 'o2'])
    expect(fields.properties.p1).toBe('o1')
  })
})

describe('legacy and v1 shapes', () => {
  it('reads a board carried as a block line (the built-in template form)', () => {
    const lines: ProjectArchiveLine[] = [
      {
        type: 'block',
        data: {
          id: 'b1', type: 'board', parentId: '', boardId: '', title: 'Template',
          fields: { cardProperties: [{ id: 'p1', name: 'Status', type: 'select', options: [] }], showDescription: true },
          ...stamps,
        },
      },
      { type: 'block', data: { id: 'c1', type: 'card', parentId: 'b1', boardId: 'b1', title: 'Card', fields: { properties: {} }, ...stamps } },
    ]
    const imported = projectArchiveLinesToImport(parseProjectArchiveLines(serializeProjectArchiveLines(lines)))
    expect(imported.board).toMatchObject({ id: 'b1', title: 'Template', showDescription: true })
    expect(imported.properties.map((p) => p.id)).toEqual(['p1'])
    expect(imported.cards.map((c) => c.id)).toEqual(['c1'])
  })

  it('collapses heading and list blocks to Markdown text', () => {
    const lines: ProjectArchiveLine[] = [
      { type: 'board', data: { id: 'b1', title: 'B', cardProperties: [] } },
      { type: 'block', data: { id: 'a1', type: 'h2', parentId: 'c1', boardId: 'b1', title: 'Heading', fields: {}, ...stamps } },
      { type: 'block', data: { id: 'a2', type: 'list-item', parentId: 'c1', boardId: 'b1', title: 'Item', fields: {}, ...stamps } },
    ]
    const imported = projectArchiveLinesToImport(lines)
    expect(imported.contents[0]).toMatchObject({ type: 'text', title: '## Heading', position: 0 })
    expect(imported.contents[1]).toMatchObject({ type: 'text', title: '- Item', position: 1 })
  })

  it('throws when an archive has no board', () => {
    expect(() => projectArchiveLinesToImport([])).toThrow('archive has no board')
  })
})