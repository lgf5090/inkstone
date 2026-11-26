import { describe, expect, it } from 'vitest'
import type { ProjectCard, ProjectProperty } from './model'
import { isProjectCardDone, projectCanMarkDone, projectDoneOption, projectDonePatch } from './model'
import { projectParentDonePatches } from './hierarchy'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const zh: ProjectProperty[] = [
  { id: 'ps', name: '状态', type: 'select', options: [{ id: 'todo', value: '待办', color: '', category: 'todo' }, { id: 'doing', value: '进行中', color: '', category: 'doing' }, { id: 'done', value: '已完成', color: '', category: 'done' }] },
]
const en: ProjectProperty[] = [
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'open', value: 'Open', color: '', category: 'todo' }, { id: 'done', value: 'Done', color: '', category: 'done' }] },
]
const box: ProjectProperty[] = [{ id: 'pb', name: 'Finished', type: 'checkbox', options: [] }]

function card(id: string, values: Record<string, string> = {}, parentId = ''): ProjectCard {
  return { id, boardId: 'b1', parentId, title: id, icon: '', isTemplate: false, contentOrder: [], values, ...stamps }
}

describe('the tick and the reader agree', () => {
  it('finds the done option in either language', () => {
    expect(projectDoneOption(zh)?.option.id).toBe('done')
    expect(projectDoneOption(en)?.option.id).toBe('done')
  })

  it('writes the option the reader will read back as done, on a Chinese board', () => {
    const values = projectDonePatch(zh, true)!
    expect(values).toEqual({ ps: 'done' })
    expect(isProjectCardDone(card('a', values as Record<string, string>), zh)).toBe(true)
  })

  it('round-trips: ticking then unticking never clears the status to nothing', () => {
    const on = projectDonePatch(zh, true)!
    const off = projectDonePatch(zh, false)!
    expect(off).toEqual({ ps: 'todo' })
    expect(isProjectCardDone(card('a', off as Record<string, string>), zh)).toBe(false)
    expect(isProjectCardDone(card('a', on as Record<string, string>), zh)).toBe(true)
  })

  it('does not mistake a negated Chinese label for done', () => {
    const negated: ProjectProperty[] = [{ id: 'ps', name: 'S', type: 'select', options: [{ id: 'a', value: '未完成', color: '', category: 'todo' }, { id: 'b', value: '已完成', color: '', category: 'done' }] }]
    expect(projectDoneOption(negated)?.option.id).toBe('b')
  })

  it('never treats an arbitrary checkbox as card completion', () => {
    expect(projectDonePatch(box, true)).toBeNull()
    expect(projectDonePatch(box, false)).toBeNull()
    expect(projectCanMarkDone(box)).toBe(false)
    expect(projectDonePatch([{ id: 'pt', name: 'Notes', type: 'text', options: [] }], true)).toBeNull()
    expect(projectCanMarkDone(zh)).toBe(true)
  })

  it('reopens to the first option that is not done, keeping the reader\'s order', () => {
    const reordered: ProjectProperty[] = [{ id: 'ps', name: 'S', type: 'select', options: [{ id: 'done', value: 'Done', color: '', category: 'done' }, { id: 'later', value: 'Later', color: '', category: 'todo' }] }]
    expect(projectDonePatch(reordered, false)).toEqual({ ps: 'later' })
  })
})

describe('a parent follows its children', () => {
  const withValues = (cards: ProjectCard[], id: string, values: Record<string, string>): ProjectCard[] =>
    cards.map((entry) => (entry.id === id ? { ...entry, values: { ...entry.values, ...values } } : entry))

  it('ticks the parent when the last open child is ticked', () => {
    const cards = [card('p', { ps: 'doing' }), card('a', { ps: 'done' }, 'p'), card('b', { ps: 'doing' }, 'p')]
    const after = withValues(cards, 'b', { ps: 'done' })
    expect(projectParentDonePatches(after, zh, 'b')).toEqual([{ id: 'p', values: { ps: 'done' } }])
  })

  it('leaves the parent alone while a sibling is still open', () => {
    const cards = [card('p', { ps: 'doing' }), card('a', { ps: 'todo' }, 'p'), card('b', { ps: 'doing' }, 'p')]
    const after = withValues(cards, 'b', { ps: 'done' })
    expect(projectParentDonePatches(after, zh, 'b')).toEqual([])
  })

  it('reopens the parent when one child is reopened', () => {
    const cards = [card('p', { ps: 'done' }), card('a', { ps: 'done' }, 'p'), card('b', { ps: 'done' }, 'p')]
    const after = withValues(cards, 'b', { ps: 'todo' })
    expect(projectParentDonePatches(after, zh, 'b')).toEqual([{ id: 'p', values: { ps: 'todo' } }])
  })

  it('settles a three-level tree in one pass, nearest parent first', () => {
    const cards = [
      card('g', { ps: 'doing' }),
      card('p', { ps: 'doing' }, 'g'),
      card('a', { ps: 'done' }, 'p'),
      card('b', { ps: 'doing' }, 'p'),
    ]
    const after = withValues(cards, 'b', { ps: 'done' })
    expect(projectParentDonePatches(after, zh, 'b')).toEqual([
      { id: 'p', values: { ps: 'done' } },
      { id: 'g', values: { ps: 'done' } },
    ])
  })

  it('never touches a card without children, nor writes a board that cannot express done', () => {
    const cards = [card('p', { ps: 'doing' }), card('a', { ps: 'doing' }, 'p')]
    const after = withValues(cards, 'a', { ps: 'done' })
    expect(projectParentDonePatches(after, [{ id: 'pt', name: 'N', type: 'text', options: [] }], 'a')).toEqual([])
    expect(projectParentDonePatches([card('solo', { ps: 'done' })], zh, 'solo')).toEqual([])
  })

  it('stops at a cycle instead of walking forever', () => {
    const cards = [card('a', { ps: 'done' }, 'b'), card('b', { ps: 'done' }, 'a')]
    expect(projectParentDonePatches(cards, zh, 'a').length).toBeLessThanOrEqual(2)
  })
})