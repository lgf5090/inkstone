import { describe, expect, it } from 'vitest'
import { rowToBoard, visibleProjectBoards, type ProjectBoardRow } from './permissions'

function row(overrides: Partial<ProjectBoardRow> = {}): ProjectBoardRow {
  return {
    id: 'b1', owner_id: 'u1', type: 'P', minimum_role: '', title: 'Roadmap', description: '',
    icon: '', show_description: 0, is_template: 0, template_version: 0,
    created_by: 'u1', modified_by: 'u1', create_at: 1, update_at: 2, delete_at: 0, archived: 0,
    ...overrides,
  }
}

describe('reading a board row', () => {
  it('turns the stored integers into the booleans the client draws', () => {
    const board = rowToBoard(row({ show_description: 1, is_template: 1 }))
    expect(board.showDescription).toBe(true)
    expect(board.isTemplate).toBe(true)
    expect(rowToBoard(row()).showDescription).toBe(false)
    expect(rowToBoard(row()).ownerId).toBe('u1')
  })
})

describe('the boards a caller may see', () => {
  it('gives the owner admin without a membership row', () => {
    const listed = visibleProjectBoards([row()], [], 'u1')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.role).toBe('admin')
  })

  it('carries the membership role for a board someone else owns', () => {
    const listed = visibleProjectBoards([row({ owner_id: 'u2' })], [{ board_id: 'b1', role: 'commenter' }], 'u1')
    expect(listed[0]!.role).toBe('commenter')
  })

  it('drops a board the caller has no role on rather than listing it greyed out', () => {
    expect(visibleProjectBoards([row({ owner_id: 'u2' })], [], 'u1')).toEqual([])
    expect(visibleProjectBoards([row({ owner_id: 'u2' })], [{ board_id: 'other', role: 'editor' }], 'u1')).toEqual([])
  })

  it('lets an open board grant its minimum to a caller with no membership', () => {
    const open = row({ owner_id: 'u2', type: 'O', minimum_role: 'viewer' })
    expect(visibleProjectBoards([open], [], 'u1')[0]!.role).toBe('viewer')
    expect(visibleProjectBoards([row({ owner_id: 'u2', type: 'P', minimum_role: 'editor' })], [], 'u1')).toEqual([])
  })

  it('takes the stronger of the membership and the open-board minimum', () => {
    const open = row({ owner_id: 'u2', type: 'O', minimum_role: 'editor' })
    expect(visibleProjectBoards([open], [{ board_id: 'b1', role: 'viewer' }], 'u1')[0]!.role).toBe('editor')
    expect(visibleProjectBoards([open], [{ board_id: 'b1', role: 'admin' }], 'u1')[0]!.role).toBe('admin')
  })
})