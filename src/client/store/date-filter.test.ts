import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { renderElement, type RenderedElement } from '../lib/test-render'
import { dateKey } from '../lib/time'
import { useNotes, useVisibleNotes } from '../store/notes'
import { useUi } from '../store/ui'

const stamp = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12).getTime()

const summary = (id: string, updatedAt: number, overrides: Partial<NoteSummary> = {}): NoteSummary => ({
  id, title: id, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false,
  isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0,
  createdAt: updatedAt, updatedAt, deletedAt: null, ...overrides,
})

const NOTES = {
  early: summary('early', stamp(2026, 9, 12)),
  midA: summary('midA', stamp(2026, 10, 4)),
  midB: summary('midB', stamp(2026, 10, 5)),
  late: summary('late', stamp(2026, 10, 6)),
  trashed: summary('trashed', stamp(2026, 10, 5), { deletedAt: stamp(2026, 10, 6) }),
  archived: summary('archived', stamp(2026, 10, 5), { isArchived: true }),
}

const ALL_UNFILTERED = ['early', 'late', 'midA', 'midB']

let visible: NoteSummary[] = []
function VisibleProbe() {
  visible = useVisibleNotes()
  return null
}

function apply(filter: { start: string; end: string } | null) {
  act(() => { useUi.getState().setDateFilter(filter) })
  return visible.map((note) => note.id).sort()
}

describe('the list honours the calendar day filter', () => {
  const originalNotes = useNotes.getState()
  const originalUi = useUi.getState()
  let rendered: RenderedElement

  beforeEach(() => {
    useNotes.setState({ ...originalNotes, notes: NOTES, folders: [], tags: [] })
    useUi.setState({ ...originalUi, view: 'all', folderId: null, tags: [], dateFilter: null })
    rendered = renderElement(createElement(VisibleProbe))
  })

  afterEach(() => {
    rendered.unmount()
    useNotes.setState(originalNotes, true)
    useUi.setState(originalUi, true)
  })

  it('shows every live note when no range is selected', () => {
    expect(apply(null)).toEqual(ALL_UNFILTERED)
  })

  it('keeps exactly the notes the heat cell counted for one day', () => {
    const key = dateKey(new Date(2026, 9, 5))
    expect(apply({ start: key, end: key })).toEqual(['midB'])
  })

  it('is inclusive at both ends of a dragged range', () => {
    expect(apply({ start: '2026-10-04', end: '2026-10-06' })).toEqual(['late', 'midA', 'midB'])
  })

  it('clears back to the unfiltered collection', () => {
    expect(apply({ start: '2026-10-04', end: '2026-10-06' })).toEqual(['late', 'midA', 'midB'])
    expect(apply(null)).toEqual(ALL_UNFILTERED)
  })

  it('composes with the folder view instead of replacing it', () => {
    act(() => {
      useNotes.setState({
        ...useNotes.getState(),
        folders: [{ id: 'f1', parentId: null, name: 'F', icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 }],
        notes: { ...NOTES, inFolder: summary('inFolder', stamp(2026, 10, 5), { folderId: 'f1' }) },
      })
      useUi.setState({ view: 'folder', folderId: 'f1', dateFilter: { start: '2026-10-05', end: '2026-10-05' } })
    })
    expect(visible.map((note) => note.id)).toEqual(['inFolder'])
  })

  it('drops the range when the view changes', () => {
    apply({ start: '2026-10-04', end: '2026-10-04' })
    act(() => { useUi.getState().openView('starred') })
    expect(useUi.getState().dateFilter).toBeNull()
  })
})
